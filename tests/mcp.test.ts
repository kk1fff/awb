import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.js';
import { createFieldworkMcpServer } from '../src/server/mcp-server.js';
import type { Scene, ToolEvent } from '../src/shared/schema.js';
import { tinyGlb } from './helpers/assets.js';

describe('MCP workspace routing', () => {
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

  async function startMcp(workspaceId?: string) {
    mcpServer = createFieldworkMcpServer({ api: base, workspaceId });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'workspace-routing-test', version: '1.0.0' });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  async function startApp() {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-mcp-routing-'));
    const options = {
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'mcp-routing-default',
      clientUrl: '',
      capture: async (_url: string, output: string) => writeFile(output, 'captured'),
    };
    const app = await createApp(options);
    httpServer = app.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => httpServer!.on('listening', resolve));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    options.clientUrl = base;
  }

  async function request(route: string, init?: RequestInit) {
    return fetch(`${base}${route}`, init);
  }

  async function createWorkspace(name: string) {
    const response = await request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { workspace: { id: string } }).workspace;
  }

  async function tool(name: string, args: Record<string, unknown> = {}) {
    const response = (await client!.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = response.content.find((item) => item.type === 'text');
    if (!text || text.type !== 'text') throw new Error(`No text result for ${name}`);
    let value: Record<string, any>;
    try {
      value = JSON.parse(text.text!) as Record<string, any>;
    } catch {
      value = { raw: text.text };
    }
    return { response, value };
  }

  it('routes concurrent tool calls independently and exposes an optional selector in every MCP schema', async () => {
    await startApp();
    const a = await createWorkspace('MCP A');
    const b = await createWorkspace('MCP B');
    const peer = await startMcp();
    const listed = await peer.listTools();
    expect(listed.tools).toHaveLength(14);
    for (const entry of listed.tools) {
      const input = entry.inputSchema as {
        properties?: Record<string, { type?: string; pattern?: string }>;
        required?: string[];
      };
      expect(input.properties?.workspaceId).toMatchObject({ type: 'string' });
      expect(input.properties?.workspaceId?.pattern).toContain('default');
      expect(input.required ?? []).not.toContain('workspaceId');
    }

    const [resultA, resultB] = await Promise.all([
      tool('create_object', {
        workspaceId: a.id,
        name: 'A object',
        type: 'box',
      }),
      tool('create_object', {
        workspaceId: b.id,
        name: 'B object',
        type: 'sphere',
      }),
    ]);
    expect(resultA.value).toMatchObject({ success: true, workspaceId: a.id, sceneRevision: 1 });
    expect(resultB.value).toMatchObject({ success: true, workspaceId: b.id, sceneRevision: 1 });

    for (const [id, name] of [
      [a.id, 'A object'],
      [b.id, 'B object'],
    ]) {
      const state = (await (await request(`/api/workspaces/${id}/state`)).json()) as Scene;
      expect(state.objects.map((object) => object.name)).toEqual([name]);
      const events = (await (await request(`/api/workspaces/${id}/events`)).json()) as ToolEvent[];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ workspaceId: id, tool: 'create_object' });
      expect(events[0]?.arguments).not.toHaveProperty('workspaceId');
    }
    expect(((await (await request('/api/state')).json()) as Scene).objects).toEqual([]);

    const publicResponse = await request('/api/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'create_object',
        arguments: { workspaceId: a.id, name: 'Not public metadata', type: 'box' },
      }),
    });
    expect(((await publicResponse.json()) as { error?: { code: string } }).error?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('promotes into the selected target, rejects unknown targets, and reports routing identity', async () => {
    await startApp();
    const source = await createWorkspace('Promotion source');
    const target = await createWorkspace('Promotion target');
    const upload = await request(`/api/workspaces/${source.id}/assets/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Asset-Name': 'Specialist asset',
        'X-Asset-File-Name': 'specialist.glb',
        'X-Asset-Tags': '%5B%22local%22%5D',
      },
      body: Uint8Array.from(tinyGlb()),
    });
    expect(upload.status).toBe(201);
    const sourceAsset = ((await upload.json()) as { asset: { id: string } }).asset;
    const peer = await startMcp();
    const promoted = await tool('promote_asset', {
      workspaceId: target.id,
      sourceWorkspaceId: source.id,
      sourceAssetId: sourceAsset.id,
    });
    expect(promoted.response.isError).not.toBe(true);
    expect(promoted.value.workspaceId).toBe(target.id);
    expect(promoted.value.result.lineage).toEqual({
      sourceWorkspaceId: source.id,
      sourceAssetId: sourceAsset.id,
    });
    const promotedAssetId = promoted.value.result.asset.id as string;
    expect(promotedAssetId).not.toBe(sourceAsset.id);
    const targetCatalog = await tool('search_assets', {
      workspaceId: target.id,
      query: 'Specialist asset',
      kind: 'model',
    });
    const sourceCatalog = await tool('search_assets', {
      workspaceId: source.id,
      query: 'Specialist asset',
      kind: 'model',
    });
    const defaultCatalog = await tool('search_assets', {
      workspaceId: 'default',
      query: 'Specialist asset',
      kind: 'model',
    });
    expect(targetCatalog.value.result.map((asset: { id: string }) => asset.id)).toEqual([
      promotedAssetId,
    ]);
    expect(sourceCatalog.value.result.map((asset: { id: string }) => asset.id)).toEqual([
      sourceAsset.id,
    ]);
    expect(defaultCatalog.value.result).toEqual([]);
    const targetEvents = (await (
      await request(`/api/workspaces/${target.id}/events`)
    ).json()) as ToolEvent[];
    expect(targetEvents.find((event) => event.tool === 'promote_asset')).toMatchObject({
      workspaceId: target.id,
      tool: 'promote_asset',
      result: { asset: { id: promotedAssetId }, lineage: { sourceWorkspaceId: source.id } },
    });

    const missingId = 'f1111111-1111-4111-8111-111111111111';
    const unknown = await tool('create_object', {
      workspaceId: missingId,
      name: 'Must not be created',
      type: 'box',
    });
    expect(unknown.response.isError).toBe(true);
    expect(unknown.value.workspaceId).toBe(missingId);
    expect(unknown.value.error.code).toBe('WORKSPACE_NOT_FOUND');
    expect(
      ((await (await request(`/api/workspaces/${target.id}/state`)).json()) as Scene).objects,
    ).toEqual([]);
    expect(((await (await request('/api/state')).json()) as Scene).objects).toEqual([]);

    const invalid = await tool('create_object', {
      workspaceId: '../default',
      name: 'Invalid route',
      type: 'box',
    });
    expect(invalid.response.isError).toBe(true);
    expect(invalid.value.raw).toContain('workspaceId');
    expect(((await (await request('/api/state')).json()) as Scene).objects).toEqual([]);
  });

  it('preserves configured workspace fallback and supports explicit default routing', async () => {
    await startApp();
    const bound = await createWorkspace('Configured binding');
    const previousWorkspaceId = process.env.SCENE_WORKSPACE_ID;
    process.env.SCENE_WORKSPACE_ID = bound.id;
    await startMcp();
    if (previousWorkspaceId === undefined) delete process.env.SCENE_WORKSPACE_ID;
    else process.env.SCENE_WORKSPACE_ID = previousWorkspaceId;
    const fallback = await tool('create_object', { name: 'Bound workspace', type: 'box' });
    expect(fallback.value).toMatchObject({ success: true, workspaceId: bound.id });
    const explicitDefault = await tool('create_object', {
      workspaceId: 'default',
      name: 'Default workspace',
      type: 'box',
    });
    expect(explicitDefault.value).toMatchObject({ success: true, workspaceId: 'default' });
    expect(
      ((await (await request(`/api/workspaces/${bound.id}/state`)).json()) as Scene).objects,
    ).toHaveLength(1);
    expect(((await (await request('/api/state')).json()) as Scene).objects).toHaveLength(1);

    await client!.close();
    await mcpServer!.close();
    client = undefined;
    mcpServer = undefined;
    await startMcp();
    const defaultFallback = await tool('create_object', { name: 'Default fallback', type: 'box' });
    expect(defaultFallback.value).toMatchObject({ success: true, workspaceId: 'default' });
    expect(((await (await request('/api/state')).json()) as Scene).objects).toHaveLength(2);
  });
});
