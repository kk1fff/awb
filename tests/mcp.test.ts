import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.js';
import { createFieldworkMcpServer, fieldworkInstructions } from '../src/server/mcp-server.js';
import type { Scene } from '../src/shared/schema.js';
import { tinyGlb } from './helpers/assets.js';

describe('UUID-bound MCP workspace', () => {
  let root = '';
  let httpServer: Server | undefined;
  let base = '';
  let client: Client | undefined;
  let mcpServer: ReturnType<typeof createFieldworkMcpServer> | undefined;

  afterEach(async () => {
    if (client) await client.close();
    if (mcpServer) await mcpServer.close();
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function startApp() {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-mcp-bound-'));
    const options = {
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'mcp-default',
      clientUrl: '',
      capture: async (_url: string, output: string) => writeFile(output, 'captured'),
    };
    const app = await createApp(options);
    httpServer = app.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => httpServer!.on('listening', resolve));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    options.clientUrl = base;
  }

  async function createWorkspace(name: string) {
    const response = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        goal: 'Build one PNW fir submodel',
        acceptanceCriteria: ['Readable crown silhouette'],
        constraints: ['No downloaded assets'],
      }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { workspace: { id: string } }).workspace;
  }

  async function startMcp(workspaceId: string) {
    const previousWorkspaceId = process.env.SCENE_WORKSPACE_ID;
    process.env.SCENE_WORKSPACE_ID = workspaceId;
    try {
      mcpServer = createFieldworkMcpServer({ api: base });
    } finally {
      if (previousWorkspaceId === undefined) delete process.env.SCENE_WORKSPACE_ID;
      else process.env.SCENE_WORKSPACE_ID = previousWorkspaceId;
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'bound-workspace-test', version: '1.0.0' });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  async function tool(name: string, args: Record<string, unknown> = {}) {
    const response = (await client!.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = response.content.find((item) => item.type === 'text');
    if (!text || text.type !== 'text') throw new Error(`No text result for ${name}`);
    return { response, value: JSON.parse(text.text!) as Record<string, any> };
  }

  it('requires an explicit UUID binding and exposes session-aware scene tools', async () => {
    const previousWorkspaceId = process.env.SCENE_WORKSPACE_ID;
    process.env.SCENE_WORKSPACE_ID = '';
    expect(() => createFieldworkMcpServer({ api: 'http://127.0.0.1:1' })).toThrow(
      /SCENE_WORKSPACE_ID.*UUID/,
    );
    if (previousWorkspaceId === undefined) delete process.env.SCENE_WORKSPACE_ID;
    else process.env.SCENE_WORKSPACE_ID = previousWorkspaceId;
    expect(() => createFieldworkMcpServer({ workspaceId: 'default' })).toThrow(/UUID/);
    expect(fieldworkInstructions).toContain('current project, session, and server run');
    expect(fieldworkInstructions).toContain('get_workspace_context');

    await startApp();
    const workspace = await createWorkspace('MCP bound');
    await startMcp(workspace.id);
    const listed = await client!.listTools();
    expect(listed.tools).toHaveLength(26);
    expect(listed.tools.map((entry) => entry.name)).toContain('get_instruction_guide');
    expect(listed.tools.map((entry) => entry.name)).toContain('get_project_info');
    expect(listed.tools.map((entry) => entry.name)).toContain('export_scene_bundle');
    expect(listed.tools.map((entry) => entry.name)).toContain('get_workspace_context');
    expect(listed.tools.map((entry) => entry.name)).toContain('update_workspace_context');
    expect(listed.tools.map((entry) => entry.name)).toContain('reserve_designer_slot');
    for (const entry of listed.tools) {
      const input = entry.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(input.properties).not.toHaveProperty('workspaceId');
    }

    const initial = await tool('get_workspace_context');
    expect(initial.value).toMatchObject({
      success: true,
      sceneRevision: 0,
      metadataRevision: 0,
      result: {
        id: workspace.id,
        goal: 'Build one PNW fir submodel',
        acceptanceCriteria: ['Readable crown silhouette'],
        constraints: ['No downloaded assets'],
        workStatus: 'planned',
        currentScene: { available: true, revision: 0, objectCount: 0 },
        availableSaves: [],
        workflowSteps: expect.any(Array),
      },
    });
    const updated = await tool('update_workspace_context', {
      currentTask: 'Integrate locally authored fir',
      workStatus: 'working',
      summary: 'First geometry pass in progress',
    });
    expect(updated.value).toMatchObject({
      success: true,
      sceneRevision: 0,
      metadataRevision: 1,
      result: {
        currentTask: 'Integrate locally authored fir',
        workStatus: 'working',
        summary: 'First geometry pass in progress',
        metadataRevision: 1,
      },
    });
    const created = await tool('create_object', { name: 'Fir trunk', type: 'cylinder' });
    expect(created.value).toMatchObject({ success: true, sceneRevision: 1, metadataRevision: 1 });
    const state = (await (
      await fetch(`${base}/api/workspaces/${workspace.id}/state`)
    ).json()) as Scene;
    expect(state.objects.map((object) => object.name)).toEqual(['Fir trunk']);
    expect(((await (await fetch(`${base}/api/state`)).json()) as Scene).objects).toEqual([]);
    await tool('save_scene', { name: 'fir-submodel' });
    const rendered = await tool('render_scene', { label: 'Fir submodel' });
    const refreshed = await tool('get_workspace_context');
    expect(refreshed.value).toMatchObject({
      result: {
        runId: expect.any(String),
        currentScene: { available: true, revision: 1, objectCount: 1 },
        latestCheckpoint: {
          id: rendered.value.result.id,
          sceneRevision: 1,
          status: 'complete',
          screenshotUrl: expect.any(String),
        },
        availableSaves: ['fir-submodel'],
        recentActivity: expect.arrayContaining([
          expect.objectContaining({ tool: 'render_scene', sceneRevision: 1 }),
        ]),
      },
    });

    const events = (await (
      await fetch(`${base}/api/workspaces/${workspace.id}/events`)
    ).json()) as Array<Record<string, any>>;
    expect(events.slice(0, 3).map((event) => event.tool)).toEqual([
      'get_workspace_context',
      'update_workspace_context',
      'create_object',
    ]);
    expect(events.slice(0, 3).map((event) => event.metadataRevision)).toEqual([0, 1, 1]);
    const persisted = JSON.parse(
      await readFile(path.join(root, 'data/workspaces', workspace.id, 'workspace.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      metadataRevision: 1,
      workStatus: 'working',
      updatedAt: expect.any(String),
    });
  });

  it('keeps two bound MCP clients isolated and promotes into the bound target', async () => {
    await startApp();
    const sourceWorkspace = await createWorkspace('MCP source');
    const targetWorkspace = await createWorkspace('MCP target');
    const upload = await fetch(`${base}/api/workspaces/${sourceWorkspace.id}/assets/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Asset-Name': 'Fir submodel',
        'X-Asset-File-Name': 'fir.glb',
        'X-Asset-Tags': '%5B%22fir%22%5D',
      },
      body: Uint8Array.from(tinyGlb()),
    });
    expect(upload.status).toBe(201);
    const sourceAsset = ((await upload.json()) as { asset: { id: string } }).asset;
    const createBoundMcp = (workspaceId: string) => {
      const previousWorkspaceId = process.env.SCENE_WORKSPACE_ID;
      process.env.SCENE_WORKSPACE_ID = workspaceId;
      try {
        return createFieldworkMcpServer({ api: base });
      } finally {
        if (previousWorkspaceId === undefined) delete process.env.SCENE_WORKSPACE_ID;
        else process.env.SCENE_WORKSPACE_ID = previousWorkspaceId;
      }
    };
    const sourceMcp = createBoundMcp(sourceWorkspace.id);
    const targetMcp = createBoundMcp(targetWorkspace.id);
    const [sourceClientTransport, sourceServerTransport] = InMemoryTransport.createLinkedPair();
    const [targetClientTransport, targetServerTransport] = InMemoryTransport.createLinkedPair();
    const sourceClient = new Client({ name: 'source specialist', version: '1.0.0' });
    const targetClient = new Client({ name: 'target integrator', version: '1.0.0' });
    try {
      await sourceMcp.connect(sourceServerTransport);
      await targetMcp.connect(targetServerTransport);
      await sourceClient.connect(sourceClientTransport);
      await targetClient.connect(targetClientTransport);
      const create = async (clientForWorkspace: Client, name: string) => {
        const result = (await clientForWorkspace.callTool({
          name: 'create_object',
          arguments: { name, type: 'box' },
        })) as { content: Array<{ type: string; text?: string }> };
        return JSON.parse(result.content[0]!.text!) as Record<string, any>;
      };
      expect((await create(sourceClient, 'Source only')).sceneRevision).toBe(1);
      expect((await create(targetClient, 'Target only')).sceneRevision).toBe(1);
      const sourceObjects = (await (
        await fetch(`${base}/api/workspaces/${sourceWorkspace.id}/state`)
      ).json()) as Scene;
      const targetObjects = (await (
        await fetch(`${base}/api/workspaces/${targetWorkspace.id}/state`)
      ).json()) as Scene;
      expect(sourceObjects.objects.map((object) => object.name)).toEqual(['Source only']);
      expect(targetObjects.objects.map((object) => object.name)).toEqual(['Target only']);

      const promoted = (await targetClient.callTool({
        name: 'promote_asset',
        arguments: { sourceWorkspaceId: sourceWorkspace.id, sourceAssetId: sourceAsset.id },
      })) as { content: Array<{ type: string; text?: string }> };
      const promotion = JSON.parse(promoted.content[0]!.text!) as Record<string, any>;
      expect(promotion).toMatchObject({
        success: true,
        workspaceId: targetWorkspace.id,
        result: {
          lineage: { sourceWorkspaceId: sourceWorkspace.id, sourceAssetId: sourceAsset.id },
        },
      });
      const promotedAssetId = promotion.result.asset.id as string;
      expect(promotedAssetId).not.toBe(sourceAsset.id);
      const targetCatalog = (await targetClient.callTool({
        name: 'search_assets',
        arguments: { query: 'Fir submodel', kind: 'model' },
      })) as { content: Array<{ type: string; text?: string }> };
      expect(JSON.parse(targetCatalog.content[0]!.text!).result).toMatchObject([
        { id: promotedAssetId, name: 'Fir submodel' },
      ]);
      const unknownMcp = createBoundMcp('ffffffff-ffff-4fff-8fff-ffffffffffff');
      const [unknownClientTransport, unknownServerTransport] = InMemoryTransport.createLinkedPair();
      const unknownClient = new Client({ name: 'unknown workspace', version: '1.0.0' });
      try {
        await unknownMcp.connect(unknownServerTransport);
        await unknownClient.connect(unknownClientTransport);
        const rejected = (await unknownClient.callTool({
          name: 'create_object',
          arguments: { name: 'Must not exist', type: 'box' },
        })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
        expect(rejected.isError).toBe(true);
        expect(JSON.parse(rejected.content[0]!.text!)).toMatchObject({
          success: false,
          error: { code: 'WORKSPACE_NOT_FOUND' },
        });
      } finally {
        await unknownClient.close();
        await unknownMcp.close();
      }
      expect(((await (await fetch(`${base}/api/state`)).json()) as Scene).objects).toEqual([]);
      expect(
        (
          (await (
            await fetch(`${base}/api/workspaces/${targetWorkspace.id}/state`)
          ).json()) as Scene
        ).objects.map((object) => object.name),
      ).toEqual(['Target only']);
    } finally {
      await sourceClient.close();
      await targetClient.close();
      await sourceMcp.close();
      await targetMcp.close();
    }
  });
});
