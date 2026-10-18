import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/server/app.js';
import { createFieldworkMcpServer, fieldworkInstructions } from '../src/server/mcp-server.js';
import type { ToolService } from '../src/server/service.js';
import type {
  Checkpoint,
  Scene,
  SceneObject,
  ToolEvent,
  ToolResponse,
} from '../src/shared/schema.js';
import { tinyGlb, tinyHdr, tinyPng } from './helpers/assets.js';

let server: Server;
let base: string;
let root: string;
let service: ToolService;
let failCapture = false;
async function call(tool: string, args: unknown = {}): Promise<ToolResponse> {
  const res = await fetch(`${base}/api/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
  return res.json() as Promise<ToolResponse>;
}
async function get<T>(route: string): Promise<T> {
  return (await fetch(`${base}${route}`)).json() as Promise<T>;
}
async function uploadAsset(fileName: string, name: string, tags: string[], data: Buffer) {
  return fetch(`${base}/api/assets/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Asset-Name': encodeURIComponent(name),
      'X-Asset-File-Name': encodeURIComponent(fileName),
      'X-Asset-Tags': encodeURIComponent(JSON.stringify(tags)),
    },
    body: Uint8Array.from(data),
  });
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'fieldwork-api-'));
  failCapture = false;
  const options = {
    dataDir: path.join(root, 'data'),
    artifactsDir: path.join(root, 'runs'),
    runId: 'test',
    clientUrl: '',
    capture: async (url: string, output: string) => {
      if (failCapture) throw new Error('Simulated browser failure');
      const id = new URL(url).searchParams.get('checkpoint');
      const scene = await get<Scene>(`/api/checkpoints/${id}/scene`);
      expect(scene.schemaVersion).toBe(2); // Read routes must not block behind render's command queue.
      await writeFile(output, 'test image placeholder');
    },
  };
  const app = await createApp(options);
  service = app.service;
  server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  options.clientUrl = base;
  service.options.clientUrl = base;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('public tool API', () => {
  it('serves the canonical designer guide and advertises concise MCP bootstrap instructions', async () => {
    const guide = await readFile(path.resolve(process.cwd(), 'docs/designer-agent-bootstrap.md'));
    const response = await fetch(`${base}/api/instructions`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(guide);
    for (const phrase of [
      'host agent runtime',
      'one workspace per specialist',
      'Promote explicitly',
      'photographic plausibility',
    ])
      expect(guide.toString()).toContain(phrase);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const createWorkspaceResponse = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MCP instruction test', goal: 'Verify startup instructions' }),
    });
    const workspaceId = ((await createWorkspaceResponse.json()) as { workspace: { id: string } })
      .workspace.id;
    const mcpServer = createFieldworkMcpServer({ api: base, workspaceId });
    const client = new Client({ name: 'bootstrap-test', version: '1.0.0' });
    try {
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(fieldworkInstructions);
      expect(client.getInstructions()).toContain('docs/designer-agent-bootstrap.md');
      expect(client.getInstructions()).toContain('SCENE_WORKSPACE_ID');
      expect(client.getInstructions()).toContain('fresh scene');
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it('discovers every tool and exercises create, inspect, list, patch and delete', async () => {
    const docs = await get<{ tools: Record<string, unknown> }>('/api/tools');
    expect(Object.keys(docs.tools)).toHaveLength(16);
    const created = await call('create_object', {
      name: 'Tree',
      type: 'cylinder',
      position: [2, 1, 0],
    });
    expect(created.success).toBe(true);
    expect(created.sceneRevision).toBe(1);
    const object = created.result as SceneObject;
    const patch = await call('update_object', { id: object.id, color: '#aabbcc', visible: false });
    expect(patch.sceneRevision).toBe(2);
    expect((patch.result as SceneObject).position).toEqual([2, 1, 0]);
    expect((await call('inspect_object', { id: object.id })).result).toEqual(patch.result);
    expect((await call('list_objects')).sceneRevision).toBe(2);
    expect((await call('delete_object', { id: object.id })).sceneRevision).toBe(3);
    const missing = await call('inspect_object', { id: object.id });
    expect(missing.error?.code).toBe('OBJECT_NOT_FOUND');
    expect(missing.sceneRevision).toBe(3);
    expect((await get<Scene>('/api/state')).objects).toEqual([]);
    const events = await get<ToolEvent[]>('/api/events');
    expect(events).toHaveLength(6);
    const disk = (await readFile(path.join(service.runDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(disk).toEqual(events);
  });
  it('validates all primitives and returns actionable errors without mutation', async () => {
    for (const type of ['box', 'sphere', 'cone', 'cylinder', 'plane'])
      expect((await call('create_object', { name: type, type })).success).toBe(true);
    const before = await get<Scene>('/api/state');
    for (const [tool, args] of [
      ['create_object', { name: 'Bad', type: 'torus' }],
      ['update_object', { id: before.objects[0].id, dimensions: [0, 1, 1] }],
      ['set_camera', { position: before.camera.target }],
      ['set_lighting', { ambient: { intensity: -1 } }],
      ['save_scene', { name: '../outside' }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.sceneRevision).toBe(before.revision);
    }
    expect(await get('/api/state')).toEqual(before);
    expect((await call('surprise')).error?.code).toBe('UNKNOWN_TOOL');
    expect((await call('toString')).error?.code).toBe('UNKNOWN_TOOL');
  });
  it('searches the original catalog and places assets without changing primitive semantics', async () => {
    const search = await call('search_assets', { query: 'pnw craftsman', kind: 'model' });
    expect(search.success).toBe(true);
    const matches = search.result as { id: string; bounds: number[] }[];
    expect(matches.some((asset) => asset.id === 'builtin:pnw-craftsman-shell')).toBe(true);
    expect(search.sceneRevision).toBe(0);
    const created = await call('create_object', {
      name: 'Craftsman shell',
      type: 'asset',
      assetId: 'builtin:pnw-craftsman-shell',
    });
    expect(created.success).toBe(true);
    expect(created.sceneRevision).toBe(1);
    expect(created.result).toMatchObject({
      type: 'asset',
      assetId: 'builtin:pnw-craftsman-shell',
      assetBounds: [8, 6.6, 6.2],
      dimensions: [8, 6.6, 6.2],
      color: '#ffffff',
    });
    const material = await call('create_object', {
      name: 'Siding test',
      type: 'box',
      materialId: 'builtin:cedar-siding',
    });
    expect(material.success).toBe(true);
    expect(
      (await call('set_lighting', { environmentAssetId: 'builtin:pnw-overcast' })).success,
    ).toBe(true);
    const cleared = await call('set_lighting', { environmentAssetId: null });
    expect((cleared.result as Scene['lighting']).environmentAssetId).toBeUndefined();
    const missing = await call('create_object', {
      name: 'Missing',
      type: 'asset',
      assetId: 'local:not-here',
    });
    expect(missing.success).toBe(false);
    expect(missing.error?.code).toBe('ASSET_NOT_FOUND');
    expect(missing.sceneRevision).toBe(4);
  });
  it('searches a local catalog and rejects paths that escape its directory', async () => {
    const assets = path.join(root, 'data', 'workspaces', 'default', 'assets');
    await mkdir(path.join(assets, 'models'), { recursive: true });
    await mkdir(path.join(assets, 'textures'), { recursive: true });
    await mkdir(path.join(assets, 'lighting'), { recursive: true });
    await writeFile(path.join(assets, 'models', 'test.glb'), 'not-a-glb');
    await writeFile(path.join(assets, 'textures', 'cedar.png'), 'texture');
    await writeFile(path.join(assets, 'lighting', 'overcast.hdr'), 'environment');
    await writeFile(
      path.join(assets, 'catalog.json'),
      JSON.stringify({
        assets: [
          {
            id: 'local:cedar-house',
            name: 'Cedar house',
            description: 'User supplied model',
            kind: 'model',
            tags: ['pnw', 'home'],
            source: 'local',
            format: 'glb',
            file: 'models/test.glb',
            bounds: [4, 3, 5],
          },
          {
            id: 'local:cedar-surface',
            name: 'Cedar surface',
            description: 'User supplied texture',
            kind: 'material',
            tags: ['wood', 'pnw'],
            source: 'local',
            format: 'png',
            file: 'textures/cedar.png',
            baseColor: '#aa7755',
            roughness: 0.8,
            metalness: 0,
          },
          {
            id: 'local:overcast',
            name: 'Overcast',
            description: 'User supplied environment',
            kind: 'environment',
            tags: ['pnw', 'sky'],
            source: 'local',
            format: 'hdr',
            file: 'lighting/overcast.hdr',
          },
        ],
      }),
    );
    const search = await call('search_assets', { query: 'cedar pnw', kind: 'model' });
    expect(search.result).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'local:cedar-house' })]),
    );
    const created = await call('create_object', {
      name: 'User house',
      type: 'asset',
      assetId: 'local:cedar-house',
    });
    expect(created.success).toBe(true);
    const file = await fetch(`${base}/api/assets/local%3Acedar-house/file`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('not-a-glb');
    const material = await call('create_object', {
      name: 'Local texture',
      type: 'box',
      materialId: 'local:cedar-surface',
    });
    expect(material.success).toBe(true);
    expect(
      (await fetch(`${base}/api/assets/local%3Acedar-surface/file`)).headers.get('content-type'),
    ).toContain('image/png');
    expect((await call('set_lighting', { environmentAssetId: 'local:overcast' })).success).toBe(
      true,
    );
    await writeFile(
      path.join(assets, 'catalog.json'),
      JSON.stringify({
        assets: [
          {
            id: 'local:escape',
            name: 'Escape',
            description: '',
            kind: 'model',
            tags: [],
            source: 'local',
            format: 'glb',
            file: '../secret.glb',
            bounds: [1, 1, 1],
          },
        ],
      }),
    );
    const invalid = await call('search_assets', {});
    expect(invalid.success).toBe(false);
    expect(invalid.error?.code).toBe('INVALID_ASSET_CATALOG');
  });
  it('imports local GLB, HDR and image assets for public-tool use without mutating the scene', async () => {
    const startingRevision = (await get<Scene>('/api/state')).revision;
    const houseResponse = await uploadAsset(
      'cedar-house.glb',
      'Cedar PNW house',
      ['house', 'pnw'],
      tinyGlb(),
    );
    expect(houseResponse.status).toBe(201);
    const house = (
      (await houseResponse.json()) as {
        asset: { id: string; bounds: number[]; file: string; originalFileName: string };
      }
    ).asset;
    expect(house).toMatchObject({
      name: 'Cedar PNW house',
      bounds: [2, 2, 2],
      file: expect.stringMatching(/^models\//),
      originalFileName: 'cedar-house.glb',
    });
    const search = await call('search_assets', { query: 'pnw house', kind: 'model' });
    expect(search.result).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: house.id })]),
    );
    const placed = await call('create_object', {
      name: 'Imported home',
      type: 'asset',
      assetId: house.id,
    });
    expect(placed.success).toBe(true);
    expect((placed.result as SceneObject).dimensions).toEqual([2, 2, 2]);

    const hdrResponse = await uploadAsset(
      'overcast.hdr',
      'Local overcast sky',
      ['pnw', 'sky'],
      tinyHdr(),
    );
    expect(hdrResponse.status).toBe(201);
    const hdr = ((await hdrResponse.json()) as { asset: { id: string; kind: string } }).asset;
    expect(hdr.kind).toBe('environment');
    expect((await call('set_lighting', { environmentAssetId: hdr.id })).success).toBe(true);

    const textureResponse = await uploadAsset('cedar.png', 'Cedar color map', ['wood'], tinyPng());
    expect(textureResponse.status).toBe(201);
    const texture = ((await textureResponse.json()) as { asset: { id: string; kind: string } })
      .asset;
    expect(texture.kind).toBe('material');
    expect(
      (await call('create_object', { name: 'Textured cedar', type: 'box', materialId: texture.id }))
        .success,
    ).toBe(true);
    expect((await get<Scene>('/api/state')).revision).toBe(startingRevision + 3);

    const invalid = await uploadAsset('fake.png', 'Fake image', [], Buffer.from('not an image'));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_ASSET_FILE' } });
    const truncated = await uploadAsset(
      'truncated.png',
      'Truncated image',
      [],
      tinyPng().subarray(0, 30),
    );
    expect(truncated.status).toBe(400);
    expect(await truncated.json()).toMatchObject({ error: { code: 'INVALID_ASSET_FILE' } });
    const catalog = JSON.parse(
      await readFile(
        path.join(root, 'data', 'workspaces', 'default', 'assets', 'catalog.json'),
        'utf8',
      ),
    ) as { assets: { id: string }[] };
    expect(catalog.assets.map((asset) => asset.id)).toEqual([house.id, hdr.id, texture.id]);
  });
  it('exports only visible scene meshes as a revision-linked GLB artifact', async () => {
    await call('create_object', {
      name: 'Visible stone',
      type: 'sphere',
      position: [2, 1, -3],
      color: '#336699',
    });
    await call('create_object', { name: 'Hidden stone', type: 'box', visible: false });
    const exported = await call('export_scene');
    expect(exported.success).toBe(true);
    expect(exported.sceneRevision).toBe(2);
    const result = exported.result as {
      format: string;
      artifactUrl: string;
      sceneRevision: number;
      objectCount: number;
      bytes: number;
    };
    expect(result).toMatchObject({ format: 'glb', sceneRevision: 2, objectCount: 1 });
    const response = await fetch(`${base}${result.artifactUrl}`);
    expect(response.headers.get('content-type')).toContain('model/gltf-binary');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('glTF');
    expect(bytes.readUInt32LE(4)).toBe(2);
    expect(bytes.readUInt32LE(8)).toBe(bytes.length);
    expect(bytes.length).toBe(result.bytes);
    const jsonLength = bytes.readUInt32LE(12);
    const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()) as {
      nodes: { name?: string; mesh?: number }[];
      meshes: unknown[];
      materials: { pbrMetallicRoughness: { baseColorFactor: number[] } }[];
    };
    expect(document.nodes.map((node) => node.name)).toContain('Visible stone');
    expect(document.nodes.map((node) => node.name)).not.toContain('Hidden stone');
    expect(document.meshes).toHaveLength(1);
    expect(document.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([
      expect.closeTo(0.0331, 3),
      expect.closeTo(0.1329, 3),
      expect.closeTo(0.3185, 3),
      1,
    ]);
  });
  it('streams an initial snapshot, running tool action, and completion update', async () => {
    const response = await fetch(`${base}/api/stream`);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextEvent = async (name: string) => {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.startsWith(`event: ${name}\n`)) return block;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Stream closed before ${name}`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      expect(await nextEvent('snapshot')).toContain('"runId":"test"');
      const action = call('create_object', { name: 'Live action', type: 'box' });
      expect(await nextEvent('tool-start')).toContain('"tool":"create_object"');
      await action;
      expect(await nextEvent('update')).toContain('"sceneRevision":1');
    } finally {
      await reader.cancel();
    }
  });
  it('serializes concurrent mutations and merges partial lighting', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => call('create_object', { name: `Box ${i}`, type: 'box' })),
    );
    expect(results.map((r) => r.sceneRevision).sort()).toEqual([1, 2, 3, 4, 5]);
    const lighting = await call('set_lighting', { ambient: { intensity: 0.5 } });
    expect(lighting.sceneRevision).toBe(6);
    const state = await get<Scene>('/api/state');
    expect(state.objects).toHaveLength(5);
    expect(state.lighting.ambient.color).toBe('#ffffff');
    expect((await call('set_camera', { verticalSize: 12 })).sceneRevision).toBe(7);
  });
  it('validates, merges and persists background and shadow lighting controls', async () => {
    const initial = await get<Scene>('/api/state');
    expect(initial.lighting.backgroundMode).toBe('solid');
    expect(initial.lighting.backgroundColor).toBeUndefined();
    expect(initial.lighting.directional.shadowSoftness).toBe(0);

    const changed = await call('set_lighting', {
      backgroundMode: 'environment',
      backgroundColor: '#123456',
      directional: { shadowSoftness: 3 },
    });
    expect(changed.success).toBe(true);
    const changedScene = await get<Scene>('/api/state');
    expect(changedScene.lighting).toMatchObject({
      backgroundMode: 'environment',
      backgroundColor: '#123456',
      directional: {
        shadowSoftness: 3,
        color: initial.lighting.directional.color,
        intensity: initial.lighting.directional.intensity,
        position: initial.lighting.directional.position,
      },
    });
    const partial = await call('set_lighting', { ambient: { intensity: 0.7 } });
    expect(partial.success).toBe(true);
    expect((await get<Scene>('/api/state')).lighting).toMatchObject({
      backgroundMode: 'environment',
      backgroundColor: '#123456',
      directional: { shadowSoftness: 3 },
    });

    for (const args of [
      { backgroundMode: 'gradient' },
      { backgroundColor: 'blue' },
      { directional: { shadowSoftness: -0.1 } },
      { directional: { shadowSoftness: 4.1 } },
    ]) {
      const rejected = await call('set_lighting', args);
      expect(rejected.success).toBe(false);
      expect(rejected.error?.code).toBe('VALIDATION_ERROR');
    }
    const saved = await call('save_scene', { name: 'lighting-controls' });
    const fresh = await createApp({
      ...service.options,
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'lighting-controls-fresh',
    });
    const loaded = await fresh.service.execute({
      tool: 'load_scene',
      arguments: { name: 'lighting-controls' },
    });
    expect(loaded.success).toBe(true);
    expect(fresh.service.engine.snapshot().lighting).toEqual(
      (await get<Scene>('/api/state')).lighting,
    );

    expect((await call('set_lighting', { backgroundColor: null })).success).toBe(true);
    expect((await get<Scene>('/api/state')).lighting.backgroundColor).toBeUndefined();
    expect(saved.success).toBe(true);
  });
  it('persists partial perspective camera updates and rejects invalid FOV', async () => {
    const initial = await get<Scene>('/api/state');
    const projection = await call('set_camera', { projection: 'perspective' });
    expect(projection.success).toBe(true);
    const fov = await call('set_camera', { fov: 38 });
    expect(fov.success).toBe(true);
    expect(fov.sceneRevision).toBe(2);
    const camera = (await get<Scene>('/api/state')).camera;
    expect(camera).toEqual({ ...initial.camera, projection: 'perspective', fov: 38 });
    const invalid = await call('set_camera', { fov: 101 });
    expect(invalid.success).toBe(false);
    expect((await get<Scene>('/api/state')).camera).toEqual(camera);

    await call('save_scene', { name: 'perspective-camera' });
    const fresh = await createApp({
      ...service.options,
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'perspective-camera-fresh',
    });
    const loaded = await fresh.service.execute({
      tool: 'load_scene',
      arguments: { name: 'perspective-camera' },
    });
    expect(loaded.success).toBe(true);
    expect(fresh.service.engine.snapshot().camera).toEqual(camera);
  });
  it('saves with provenance and loads content into a fresh server session', async () => {
    await call('create_object', { name: 'Bench', type: 'box', dimensions: [3, 0.2, 1] });
    const expected = await get<Scene>('/api/state');
    const saved = await call('save_scene', { name: 'garden' });
    expect(saved.sceneRevision).toBe(1);
    const fresh = await createApp({
      ...service.options,
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'fresh',
    });
    const loaded = await fresh.service.execute({
      tool: 'load_scene',
      arguments: { name: 'garden' },
    });
    expect(loaded.success).toBe(true);
    expect(fresh.service.engine.snapshot()).toEqual({
      ...expected,
      revision: expected.revision + 1,
    });
    const provenance = JSON.parse(
      await readFile(path.join(service.runDir, `save-${saved.executionId}.json`), 'utf8'),
    );
    expect(provenance.executionId).toBe(saved.executionId);
    expect(provenance.scene).toEqual(expected);
    await call('set_camera', { verticalSize: 30 });
    const result = await call('load_scene', { name: 'garden' });
    expect(result.sceneRevision).toBe(3);
    expect((await get<Scene>('/api/state')).camera).toEqual(expected.camera);
  });
  it('rejects missing, corrupt and unsupported saves without changing state', async () => {
    expect((await call('load_scene', { name: 'missing' })).error?.code).toBe('SAVE_NOT_FOUND');
    await writeFile(path.join(root, 'data/workspaces/default/scenes/corrupt.json'), '{');
    expect((await call('load_scene', { name: 'corrupt' })).error?.code).toBe('INVALID_SCENE');
    await writeFile(
      path.join(root, 'data/workspaces/default/scenes/future.json'),
      JSON.stringify({ schemaVersion: 9 }),
    );
    expect((await call('load_scene', { name: 'future' })).error?.code).toBe('UNSUPPORTED_VERSION');
    expect((await get<Scene>('/api/state')).revision).toBe(0);
  });
  it('recovers committed create, update, camera, lighting, delete and load operations at the same revision', async () => {
    const created = await call('create_object', { name: 'Original', type: 'box' });
    const object = created.result as SceneObject;
    await call('save_scene', { name: 'recovery-base' });
    await call('update_object', { id: object.id, position: [2, 1, -3] });
    await call('set_camera', { target: [1, 0, 0], projection: 'perspective', fov: 38 });
    await call('set_lighting', { ambient: { intensity: 1.7 } });
    const temporary = await call('create_object', { name: 'Temporary', type: 'sphere' });
    await call('delete_object', { id: (temporary.result as SceneObject).id });
    const loaded = await call('load_scene', { name: 'recovery-base' });
    expect(loaded.success).toBe(true);
    expect(loaded.sceneRevision).toBe(7);
    const committedScene = await get<Scene>('/api/state');

    const fresh = await createApp({
      ...service.options,
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'recovery-restart-one',
    });
    expect(fresh.service.engine.snapshot()).toEqual(committedScene);
    expect(
      JSON.parse(await readFile(path.join(fresh.service.runDir, 'run.json'), 'utf8')),
    ).toMatchObject({
      recovery: {
        status: 'restored',
        executionId: loaded.executionId,
        runId: service.options.runId,
        sceneRevision: 7,
      },
    });
    const recoveryRoot = path.join(root, 'data/workspaces/default/recovery');
    const pointer = JSON.parse(await readFile(path.join(recoveryRoot, 'current.json'), 'utf8')) as {
      executionId: string;
      previousExecutionId: string;
    };
    expect(pointer.executionId).toBe(loaded.executionId);
    expect(pointer.previousExecutionId).toBeDefined();
    expect(await readdir(path.join(recoveryRoot, 'snapshots'))).toHaveLength(2);
    const oldRunEvents = (await readFile(path.join(service.runDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ToolEvent);
    expect(oldRunEvents).toContainEqual(
      expect.objectContaining({
        executionId: loaded.executionId,
        tool: 'load_scene',
        success: true,
        sceneRevision: 7,
      }),
    );
    const activity = await fresh.workspaces.context('default');
    expect(activity.recentActivity).toContainEqual(
      expect.objectContaining({ executionId: loaded.executionId, tool: 'load_scene' }),
    );

    const nextChange = await fresh.service.execute({
      tool: 'set_camera',
      arguments: { target: [4, 2, 1] },
    });
    expect(nextChange.sceneRevision).toBe(8);
    const freshAgain = await createApp({
      ...service.options,
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'recovery-restart-two',
    });
    expect(freshAgain.service.engine.snapshot()).toEqual(fresh.service.engine.snapshot());
  });
  it('freezes render snapshots and records checkpoint-linked reviews and tool feedback', async () => {
    const created = await call('create_object', { name: 'Stone', type: 'sphere' });
    const rendered = await call('render_scene', { label: 'Before' });
    expect(rendered.success).toBe(true);
    expect(rendered.sceneRevision).toBe(1);
    const checkpoint = rendered.result as Checkpoint;
    expect(checkpoint.status).toBe('complete');
    await call('update_object', { id: (created.result as SceneObject).id, position: [5, 0, 0] });
    expect((await get<Scene>(checkpoint.sceneUrl)).objects[0].position).toEqual([0, 0, 0]);
    const review = await call('record_review', {
      kind: 'evaluation',
      author: 'agent',
      text: 'Stone needs moving.',
      checkpointId: checkpoint.id,
    });
    expect(review.success).toBe(true);
    expect(review.sceneRevision).toBe(2);
    expect((review.result as { sceneRevision: number }).sceneRevision).toBe(1);
    const feedback = await call('record_review', {
      kind: 'tool_issue',
      author: 'agent',
      text: 'Repeated positioning calculations.',
      executionIds: [created.executionId],
      suggestion: 'Add alignment tools.',
      impact: 'Reduce errors.',
    });
    expect(feedback.success).toBe(true);
    expect(await readFile(path.join(service.runDir, 'tool-feedback.md'), 'utf8')).toContain(
      created.executionId,
    );
    const invalid = await call('record_review', {
      kind: 'tool_issue',
      author: 'agent',
      text: 'No evidence',
    });
    expect(invalid.error?.code).toBe('VALIDATION_ERROR');
    expect(
      (
        await call('record_review', {
          kind: 'approval',
          author: 'human',
          text: 'Yes',
          checkpointId: crypto.randomUUID(),
        })
      ).error?.code,
    ).toBe('CHECKPOINT_NOT_FOUND');
    expect(
      (
        await call('record_review', {
          kind: 'tool_issue',
          author: 'agent',
          text: 'Missing',
          executionIds: [crypto.randomUUID()],
          suggestion: 'X',
          impact: 'Y',
        })
      ).error?.code,
    ).toBe('EXECUTION_NOT_FOUND');
  });
  it('retains failed-render evidence and keeps the queue usable', async () => {
    failCapture = true;
    const result = await call('render_scene');
    expect(result.error?.code).toBe('RENDER_FAILED');
    expect(result.sceneRevision).toBe(0);
    const checkpoints = await get<Checkpoint[]>('/api/checkpoints');
    expect(checkpoints[0].status).toBe('failed');
    expect(checkpoints[0].screenshotUrl).toBeUndefined();
    expect(
      (
        await call('record_review', {
          kind: 'approval',
          author: 'human',
          text: 'Cannot approve failed image',
          checkpointId: checkpoints[0].id,
        })
      ).error?.code,
    ).toBe('CHECKPOINT_INCOMPLETE');
    expect((await call('create_object', { name: 'After failure', type: 'box' })).success).toBe(
      true,
    );
  });
  it('logs malformed JSON with the same structured error returned to the caller', async () => {
    const response = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(response.status).toBe(400);
    const result = (await response.json()) as ToolResponse;
    expect(result.error?.code).toBe('INVALID_REQUEST');
    const events = await get<ToolEvent[]>('/api/events');
    expect(events[0].error).toEqual(result.error);
  });
  it('surfaces storage failures without changing scene state', async () => {
    await call('create_object', { name: 'Keep me', type: 'box' });
    const before = await get<Scene>('/api/state');
    await rename(
      path.join(root, 'data/workspaces/default/scenes'),
      path.join(root, 'data/workspaces/default/scenes-offline'),
    );
    const result = await call('save_scene', { name: 'unavailable' });
    expect(result.error?.code).toBe('IO_ERROR');
    expect(await get('/api/state')).toEqual(before);
  });
  it('recovers a committed mutation when its event projection is temporarily unavailable', async () => {
    await rename(
      path.join(service.runDir, 'events.jsonl'),
      path.join(service.runDir, 'events-offline.jsonl'),
    );
    await mkdir(path.join(service.runDir, 'events.jsonl'));
    const result = await call('create_object', { name: 'Must not commit', type: 'box' });
    expect(result.success).toBe(true);
    expect(result.sceneRevision).toBe(1);
    expect((await get<Scene>('/api/state')).objects).toHaveLength(1);
    expect((await get<ToolEvent[]>('/api/events')).map((event) => event.executionId)).toContain(
      result.executionId,
    );
    await rm(path.join(service.runDir, 'events.jsonl'), { recursive: true, force: true });
    await rename(
      path.join(service.runDir, 'events-offline.jsonl'),
      path.join(service.runDir, 'events.jsonl'),
    );
    const fresh = await createApp({
      ...service.options,
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'recovery-after-event-sink',
    });
    expect(fresh.service.engine.snapshot()).toEqual(await get<Scene>('/api/state'));
    const repairedEvents = (await readFile(path.join(service.runDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ToolEvent);
    expect(repairedEvents).toContainEqual(
      expect.objectContaining({ executionId: result.executionId, success: true }),
    );
  });
  it('rolls back a scene mutation when the recovery pointer cannot be committed', async () => {
    const pointerPath = path.join(root, 'data/workspaces/default/recovery/current.json');
    await mkdir(pointerPath, { recursive: true });
    const failed = await call('create_object', { name: 'Not committed', type: 'box' });
    expect(failed.success).toBe(false);
    expect(failed.error?.code).toBe('RECOVERY_WRITE_FAILED');
    expect(failed.sceneRevision).toBe(0);
    expect((await get<Scene>('/api/state')).objects).toEqual([]);
    await rm(pointerPath, { recursive: true, force: true });
    const accepted = await call('create_object', { name: 'Committed', type: 'box' });
    expect(accepted.success).toBe(true);
    expect(accepted.sceneRevision).toBe(1);
  });
  it('keeps a corrupt workspace available with visible recovery error and blocks scene publication', async () => {
    const isolatedRoot = await mkdtemp(path.join(tmpdir(), 'fieldwork-corrupt-recovery-'));
    const dataDir = path.join(isolatedRoot, 'data');
    const artifactsDir = path.join(isolatedRoot, 'runs');
    const pointerPath = path.join(dataDir, 'workspaces/default/recovery/current.json');
    await mkdir(path.dirname(pointerPath), { recursive: true });
    await writeFile(pointerPath, '{bad json');
    const broken = await createApp({
      dataDir,
      artifactsDir,
      runId: 'recovery-error-run',
      clientUrl: '',
    });
    const brokenServer = broken.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => brokenServer.on('listening', resolve));
    const address = brokenServer.address() as AddressInfo;
    const brokenBase = `http://127.0.0.1:${address.port}`;
    try {
      const health = (await (await fetch(`${brokenBase}/api/health`)).json()) as {
        ready: boolean;
        recoveryError?: { code: string };
      };
      expect(health).toMatchObject({ ready: true, recoveryError: { code: 'RECOVERY_CORRUPT' } });
      expect((await broken.workspaces.context('default')).recoveryError).toMatchObject({
        code: 'RECOVERY_CORRUPT',
      });
      const write = await broken.service.execute({
        tool: 'create_object',
        arguments: { name: 'Must not overwrite recovery', type: 'box' },
      });
      expect(write.success).toBe(false);
      expect(write.error?.code).toBe('RECOVERY_UNAVAILABLE');
      const save = await broken.service.execute({
        tool: 'save_scene',
        arguments: { name: 'empty' },
      });
      expect(save.error?.code).toBe('RECOVERY_UNAVAILABLE');
      const other = await broken.workspaces.create({ name: 'Healthy workspace', goal: 'test' });
      expect((await broken.workspaces.context(other.id)).recoveryError).toBeUndefined();
      expect(broken.service.engine.snapshot().objects).toEqual([]);
      expect(await readFile(pointerPath, 'utf8')).toBe('{bad json');
    } finally {
      await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
  it('retains the previous recovery snapshot when the current snapshot is damaged', async () => {
    const isolatedRoot = await mkdtemp(path.join(tmpdir(), 'fieldwork-damaged-snapshot-'));
    const dataDir = path.join(isolatedRoot, 'data');
    const artifactsDir = path.join(isolatedRoot, 'runs');
    const first = await createApp({
      dataDir,
      artifactsDir,
      runId: 'snapshot-source',
      clientUrl: '',
    });
    const acceptedOne = await first.service.execute({
      tool: 'create_object',
      arguments: { name: 'First', type: 'box' },
    });
    const acceptedTwo = await first.service.execute({
      tool: 'create_object',
      arguments: { name: 'Second', type: 'box' },
    });
    expect(acceptedOne.success && acceptedTwo.success).toBe(true);
    const recoveryDir = path.join(dataDir, 'workspaces/default/recovery');
    const pointer = JSON.parse(await readFile(path.join(recoveryDir, 'current.json'), 'utf8')) as {
      executionId: string;
      previousExecutionId: string;
    };
    const currentSnapshot = path.join(recoveryDir, 'snapshots', `${pointer.executionId}.json`);
    await writeFile(currentSnapshot, '{damaged');
    const reopened = await createApp({
      dataDir,
      artifactsDir,
      runId: 'snapshot-reopen',
      clientUrl: '',
    });
    try {
      expect(reopened.service.recoveryError).toMatchObject({ code: 'RECOVERY_CORRUPT' });
      expect(await readdir(path.join(recoveryDir, 'snapshots'))).toContain(
        `${pointer.previousExecutionId}.json`,
      );
      expect(
        JSON.parse(await readFile(path.join(reopened.service.runDir, 'run.json'), 'utf8')),
      ).toMatchObject({ recovery: { status: 'error', code: 'RECOVERY_CORRUPT' } });
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});
