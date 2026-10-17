import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.js';
import type { ToolService } from '../src/server/service.js';
import type {
  Checkpoint,
  Scene,
  SceneObject,
  ToolEvent,
  ToolResponse,
} from '../src/shared/schema.js';

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
      expect(scene.schemaVersion).toBe(1); // Read routes must not block behind render's command queue.
      await writeFile(output, 'test image placeholder');
    },
  };
  const app = await createApp(options);
  service = app.service;
  server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  options.clientUrl = base;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('public tool API', () => {
  it('discovers every tool and exercises create, inspect, list, patch and delete', async () => {
    const docs = await get<{ tools: Record<string, unknown> }>('/api/tools');
    expect(Object.keys(docs.tools)).toHaveLength(12);
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
  it('saves with provenance and loads content into a fresh server session', async () => {
    await call('create_object', { name: 'Bench', type: 'box', dimensions: [3, 0.2, 1] });
    const expected = await get<Scene>('/api/state');
    const saved = await call('save_scene', { name: 'garden' });
    expect(saved.sceneRevision).toBe(1);
    const fresh = await createApp({ ...service.options, runId: 'fresh' });
    const loaded = await fresh.service.execute({
      tool: 'load_scene',
      arguments: { name: 'garden' },
    });
    expect(loaded.success).toBe(true);
    expect(fresh.service.engine.snapshot()).toEqual(expected);
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
    await writeFile(path.join(root, 'data/scenes/corrupt.json'), '{');
    expect((await call('load_scene', { name: 'corrupt' })).error?.code).toBe('INVALID_SCENE');
    await writeFile(
      path.join(root, 'data/scenes/future.json'),
      JSON.stringify({ schemaVersion: 9 }),
    );
    expect((await call('load_scene', { name: 'future' })).error?.code).toBe('UNSUPPORTED_VERSION');
    expect((await get<Scene>('/api/state')).revision).toBe(0);
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
    await rename(path.join(root, 'data/scenes'), path.join(root, 'data/scenes-offline'));
    const result = await call('save_scene', { name: 'unavailable' });
    expect(result.error?.code).toBe('IO_ERROR');
    expect(await get('/api/state')).toEqual(before);
  });
  it('rolls back a mutation when the history sink cannot accept its event', async () => {
    await rename(
      path.join(service.runDir, 'events.jsonl'),
      path.join(service.runDir, 'events-offline.jsonl'),
    );
    await mkdir(path.join(service.runDir, 'events.jsonl'));
    const result = await call('create_object', { name: 'Must not commit', type: 'box' });
    expect(result.error?.code).toBe('HISTORY_WRITE_FAILED');
    expect(result.sceneRevision).toBe(0);
    expect((await get<Scene>('/api/state')).objects).toEqual([]);
    expect(await get('/api/events')).toEqual([]);
  });
});
