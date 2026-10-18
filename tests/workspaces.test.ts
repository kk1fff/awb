import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.js';
import type { Scene, ToolResponse } from '../src/shared/schema.js';
import { tinyGlb } from './helpers/assets.js';

describe('isolated workspaces', () => {
  let root: string;
  let server: Server | undefined;
  let base = '';
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('isolates concurrent scene/assets/events/saves/checkpoints, promotes lineage, and reopens saved work', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-workspaces-'));
    const options = {
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'default-one',
      clientUrl: '',
      capture: async (_url: string, output: string) => writeFile(output, 'captured'),
    };
    const app = await createApp(options);
    server = app.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.on('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    options.clientUrl = base;
    const request = async (route: string, init?: RequestInit) => fetch(`${base}${route}`, init);
    const createWorkspace = async (name: string) => {
      const response = await request('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, goal: `Build ${name}` }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { workspace: { id: string; runId: string } }).workspace;
    };
    const missingGoal = await request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Missing brief' }),
    });
    expect(missingGoal.status).toBe(400);
    const a = await createWorkspace('Specialist A');
    const b = await createWorkspace('Specialist B');
    const api = (id: string, suffix: string) => `/api/workspaces/${id}${suffix}`;
    const described = (await (await request(api(a.id, ''))).json()) as {
      workspace: { active: boolean; runId: string };
    };
    expect(described.workspace).toMatchObject({ active: true, runId: a.runId });
    const contextBefore = (await (await request(api(a.id, '/context'))).json()) as {
      context: { metadataRevision: number; workStatus: string };
    };
    expect(contextBefore.context).toMatchObject({ metadataRevision: 0, workStatus: 'planned' });
    const contextAfterResponse = await request(api(a.id, '/context'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentTask: 'Model siding', workStatus: 'working' }),
    });
    expect(contextAfterResponse.status).toBe(200);
    expect(await contextAfterResponse.json()).toMatchObject({
      context: { metadataRevision: 1, currentTask: 'Model siding', workStatus: 'working' },
    });
    const listed = (await (await request('/api/workspaces')).json()) as {
      workspaces: Array<{ id: string }>;
    };
    expect(listed.workspaces.map((workspace) => workspace.id)).toContain(a.id);
    const defaultEventsBeforeMalformed = (await (await request('/api/events')).json()) as unknown[];
    const malformedScoped = await request(api(a.id, '/tools'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(malformedScoped.status).toBe(400);
    expect((await (await request('/api/events')).json()) as unknown[]).toEqual(
      defaultEventsBeforeMalformed,
    );
    const invalidScopedImport = await request(api(a.id, '/assets/import'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Asset-Name': 'Invalid model',
        'X-Asset-File-Name': 'invalid.glb',
        'X-Asset-Tags': '%5B%5D',
      },
      body: Uint8Array.from(Buffer.from('invalid-glb')),
    });
    expect(invalidScopedImport.status).toBe(400);
    expect(await invalidScopedImport.json()).toMatchObject({
      error: { code: 'INVALID_ASSET_FILE' },
    });
    const tool = async (workspace: string, name: string, args: unknown = {}) => {
      const response = await request(api(workspace, '/tools'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: name, arguments: args }),
      });
      return response.json() as Promise<ToolResponse>;
    };
    const results = await Promise.all([
      tool(a.id, 'create_object', { name: 'A only', type: 'box' }),
      tool(b.id, 'create_object', { name: 'B only', type: 'sphere' }),
    ]);
    expect(results.map((result) => result.sceneRevision)).toEqual([1, 1]);
    expect(
      ((await (await request(api(a.id, '/state'))).json()) as Scene).objects.map(
        (object) => object.name,
      ),
    ).toEqual(['A only']);
    expect(
      ((await (await request(api(b.id, '/state'))).json()) as Scene).objects.map(
        (object) => object.name,
      ),
    ).toEqual(['B only']);
    await Promise.all([
      tool(a.id, 'save_scene', { name: 'same' }),
      tool(b.id, 'save_scene', { name: 'same' }),
    ]);
    expect(
      await readFile(path.join(root, 'data/workspaces', a.id, 'scenes/same.json'), 'utf8'),
    ).not.toEqual(
      await readFile(path.join(root, 'data/workspaces', b.id, 'scenes/same.json'), 'utf8'),
    );
    const importAsset = async (id: string, label: string) =>
      request(api(id, '/assets/import'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Asset-Name': encodeURIComponent(label),
          'X-Asset-File-Name': 'model.glb',
          'X-Asset-Tags': '%5B%22local%22%5D',
        },
        body: Uint8Array.from(tinyGlb()),
      });
    const imported = await importAsset(a.id, 'Specialist tree');
    expect(imported.status).toBe(201);
    const sourceAsset = ((await imported.json()) as { asset: { id: string } }).asset;
    const promoted = await tool(b.id, 'promote_asset', {
      sourceWorkspaceId: a.id,
      sourceAssetId: sourceAsset.id,
    });
    expect(promoted.success).toBe(true);
    const targetAsset = (promoted.result as { asset: { id: string }; lineage: unknown }).asset;
    expect(targetAsset.id).not.toBe(sourceAsset.id);
    expect((promoted.result as { lineage: unknown }).lineage).toEqual({
      sourceWorkspaceId: a.id,
      sourceAssetId: sourceAsset.id,
    });
    expect(
      (await tool(b.id, 'search_assets', { query: 'Specialist tree', kind: 'model' })).result,
    ).toEqual([targetAsset]);
    expect(
      (await tool(a.id, 'search_assets', { query: 'Specialist tree', kind: 'model' })).result,
    ).toEqual([sourceAsset]);
    const exportResult = await tool(a.id, 'export_scene', {});
    expect(exportResult.success).toBe(true);
    const exportValue = exportResult.result as { fileName: string };
    const promotedExport = await tool(b.id, 'promote_asset', {
      sourceWorkspaceId: a.id,
      sourceRunId: a.runId,
      sourceExportExecutionId: exportResult.executionId,
    });
    expect(promotedExport.success).toBe(true);
    expect((promotedExport.result as { lineage: unknown }).lineage).toEqual({
      sourceWorkspaceId: a.id,
      sourceRunId: a.runId,
      sourceExportExecutionId: exportResult.executionId,
    });
    expect(
      (promotedExport.result as { asset: { originalFileName: string } }).asset.originalFileName,
    ).toBe(exportValue.fileName);
    const rendered = await tool(a.id, 'render_scene', { label: 'A checkpoint' });
    expect(rendered.success).toBe(true);
    const checkpoint = rendered.result as { id: string; screenshotUrl: string };
    expect(checkpoint.screenshotUrl).toContain(`/api/workspaces/${a.id}/artifacts/${a.runId}/`);
    expect((await request(checkpoint.screenshotUrl)).status).toBe(200);
    expect((await (await request(api(b.id, '/checkpoints'))).json()) as unknown[]).toHaveLength(0);
    expect(
      ((await (await request(api(a.id, '/events'))).json()) as unknown[]).length,
    ).toBeGreaterThan(0);
    expect(
      ((await (await request(api(b.id, '/events'))).json()) as unknown[]).some(
        (entry: any) => entry.tool === 'promote_asset',
      ),
    ).toBe(true);
    const streamA = await request(api(a.id, '/stream'));
    const streamReader = streamA.body!.getReader();
    const firstStreamChunk = new TextDecoder().decode((await streamReader.read()).value);
    await streamReader.cancel();
    expect(firstStreamChunk).toContain(`"workspaceId":"${a.id}"`);

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const restarted = await createApp({ ...options, runId: 'default-two' });
    server = restarted.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.on('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const reopenedList = (await (await fetch(`${base}/api/workspaces`)).json()) as {
      workspaces: Array<{ id: string; active: boolean; runId?: string }>;
    };
    expect(reopenedList.workspaces.find((workspace) => workspace.id === a.id)).toMatchObject({
      active: false,
    });
    expect(reopenedList.workspaces.find((workspace) => workspace.id === a.id)?.runId).toBe(a.runId);
    const newHealth = (await (await fetch(`${base}${api(a.id, '/health')}`)).json()) as {
      runId: string;
    };
    expect(newHealth.runId).not.toBe(a.runId);
    const loaded = await fetch(`${base}${api(a.id, '/tools')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'load_scene', arguments: { name: 'same' } }),
    });
    const loadedResponse = (await loaded.json()) as ToolResponse;
    expect(loadedResponse.success).toBe(true);
    expect((loadedResponse.result as Scene).objects[0]?.name).toBe('A only');
    const reopenedContext = (await (await fetch(`${base}${api(a.id, '/context')}`)).json()) as {
      context: {
        runId: string;
        metadataRevision: number;
        currentTask: string;
        currentScene: { available: boolean; revision?: number; objectCount?: number };
        latestCheckpoint?: { runId: string; sceneRevision: number; screenshotUrl?: string };
        recentActivity: Array<{ runId: string; tool: string }>;
        availableSaves: string[];
      };
    };
    expect(reopenedContext.context).toMatchObject({
      runId: newHealth.runId,
      metadataRevision: 1,
      currentTask: 'Model siding',
      currentScene: { available: true, revision: 2, objectCount: 1 },
      latestCheckpoint: { runId: a.runId, screenshotUrl: expect.any(String) },
      availableSaves: ['same'],
    });
    expect(reopenedContext.context.recentActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: a.runId }),
        expect.objectContaining({ runId: newHealth.runId, tool: 'load_scene' }),
      ]),
    );
    const promotedAfterRestart = await fetch(`${base}${api(b.id, '/tools')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'promote_asset',
        arguments: {
          sourceWorkspaceId: a.id,
          sourceRunId: a.runId,
          sourceExportExecutionId: exportResult.executionId,
        },
      }),
    });
    expect(((await promotedAfterRestart.json()) as ToolResponse).success).toBe(true);
    expect(
      ((await fetch(`${base}/api/state`).then((response) => response.json())) as Scene).objects,
    ).toEqual([]);
    expect((await fetch(`${base}${api(a.id, `/artifacts/${a.runId}/events.jsonl`)}`)).status).toBe(
      200,
    );
    expect(
      (await fetch(`${base}/api/workspaces/../../../../runs/default-one/events.jsonl`)).status,
    ).not.toBe(200);
    const defaultContextUpdate = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'update_workspace_context',
        arguments: { currentTask: 'Legacy default remains reachable', workStatus: 'working' },
      }),
    });
    expect(await defaultContextUpdate.json()).toMatchObject({
      success: true,
      sceneRevision: 0,
      metadataRevision: 1,
    });
    expect(await (await fetch(`${base}/api/workspaces/default/context`)).json()).toMatchObject({
      context: { currentTask: 'Legacy default remains reachable', workStatus: 'working' },
    });

    const failingService = await restarted.workspaces.get(b.id);
    const eventPath = path.join(failingService.runDir, 'events.jsonl');
    await rm(eventPath);
    await mkdir(eventPath);
    const failedPromotion = await fetch(`${base}${api(b.id, '/tools')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'promote_asset',
        arguments: { sourceWorkspaceId: a.id, sourceAssetId: sourceAsset.id },
      }),
    });
    expect(((await failedPromotion.json()) as ToolResponse).error?.code).toBe(
      'HISTORY_WRITE_FAILED',
    );
    expect(await failingService.assets.search('Specialist tree', 'model', 20)).toEqual([
      targetAsset,
    ]);
  });

  it('archives, restores, and purges UUID workspaces with restart-safe read-only behavior', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-workspace-lifecycle-'));
    const options = {
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'lifecycle-default-one',
      clientUrl: '',
    };
    let app = await createApp(options);
    server = app.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.on('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = async (route: string, init?: RequestInit) => fetch(`${base}${route}`, init);
    const createdResponse = await request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lifecycle target', goal: 'Check lifecycle' }),
    });
    const created = (await createdResponse.json()) as { workspace: { id: string; runId: string } };
    const id = created.workspace.id;
    const toolPath = `/api/workspaces/${id}/tools`;
    const makeInitial = async (tool: string, args: unknown = {}) =>
      request(toolPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, arguments: args }),
      });
    expect(
      (await makeInitial('create_object', { name: 'Archived evidence', type: 'box' })).status,
    ).toBe(200);
    expect((await makeInitial('save_scene', { name: 'before-archive' })).status).toBe(200);
    const archiveDefault = await request('/api/workspaces/default/archive', { method: 'POST' });
    expect(archiveDefault.status).toBe(400);
    await expect(app.workspaces.purge('default', 'default')).rejects.toMatchObject({
      code: 'INVALID_WORKSPACE_LIFECYCLE',
    });

    const archivedResponse = await request(`/api/workspaces/${id}/archive`, { method: 'POST' });
    expect(archivedResponse.status).toBe(200);
    expect(await archivedResponse.json()).toMatchObject({
      workspace: { id, workspaceStatus: 'archived', active: false },
    });
    expect(await (await request(`/api/workspaces/${id}/context`)).json()).toMatchObject({
      context: {
        id,
        workspaceStatus: 'archived',
        goal: 'Check lifecycle',
        availableSaves: ['before-archive'],
      },
    });
    await expect(app.workspaces.get(id)).rejects.toMatchObject({ code: 'WORKSPACE_ARCHIVED' });
    expect((await request(`/api/workspaces/${id}/state`)).status).toBe(200);
    expect(
      ((await (await request(`/api/workspaces/${id}/events`)).json()) as unknown[]).length,
    ).toBe(2);
    expect(
      (
        await request(toolPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'create_object',
            arguments: { name: 'Blocked', type: 'box' },
          }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/api/workspaces/${id}/context`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentTask: 'Should be blocked' }),
        })
      ).status,
    ).toBe(400);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    options.runId = 'lifecycle-default-two';
    app = await createApp(options);
    server = app.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.on('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await (await request(`/api/workspaces/${id}`)).json()).toMatchObject({
      workspace: { workspaceStatus: 'archived', active: false },
    });
    expect(await (await request(`/api/workspaces/${id}/context`)).json()).toMatchObject({
      context: {
        workspaceStatus: 'archived',
        availableSaves: ['before-archive'],
        runId: created.workspace.runId,
      },
    });
    const restored = await request(`/api/workspaces/${id}/restore`, { method: 'POST' });
    expect(await restored.json()).toMatchObject({
      workspace: { id, workspaceStatus: 'active' },
    });
    expect(
      (
        await request(toolPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'create_object',
            arguments: { name: 'Restored', type: 'box' },
          }),
        })
      ).status,
    ).toBe(200);
    const unarchivedPurge = await request(`/api/workspaces/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmWorkspaceId: id }),
    });
    expect(unarchivedPurge.status).toBe(400);
    await request(`/api/workspaces/${id}/archive`, { method: 'POST' });
    const wrongConfirmation = await request(`/api/workspaces/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmWorkspaceId: randomUUID() }),
    });
    expect(wrongConfirmation.status).toBe(400);
    const purged = await request(`/api/workspaces/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmWorkspaceId: id }),
    });
    expect(purged.status).toBe(200);
    expect(await purged.json()).toEqual({ id, purged: true });
    await expect(access(path.join(root, 'data/workspaces', id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await request(`/api/workspaces/${id}`)).status).toBe(404);
  });

  it('supports lifecycle commands from the setup CLI without a running API', async () => {
    const cliRoot = await mkdtemp(path.join(tmpdir(), 'fieldwork-workspace-cli-lifecycle-'));
    const runCli = (...args: string[]) =>
      execFileSync(
        process.execPath,
        ['node_modules/tsx/dist/cli.mjs', 'src/workspace-cli.ts', ...args],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATA_DIR: path.join(cliRoot, 'data'),
            ARTIFACTS_DIR: path.join(cliRoot, 'runs'),
            SCENE_API: 'http://127.0.0.1:1',
          },
          encoding: 'utf8',
        },
      );
    const createdOutput = runCli(
      'create',
      '--name',
      'CLI lifecycle',
      '--goal',
      'Exercise setup CLI',
    );
    const created = JSON.parse(createdOutput.slice(0, createdOutput.indexOf('\n\nSet '))) as {
      workspace: { id: string };
    };
    const id = created.workspace.id;
    expect(JSON.parse(runCli('archive', '--id', id))).toMatchObject({
      workspace: { id, workspaceStatus: 'archived' },
    });
    expect(JSON.parse(runCli('restore', '--id', id))).toMatchObject({
      workspace: { id, workspaceStatus: 'active' },
    });
    runCli('archive', '--id', id);
    expect(JSON.parse(runCli('purge', '--id', id, '--confirm', id))).toEqual({ id, purged: true });
    await expect(access(path.join(cliRoot, 'data/workspaces', id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await rm(cliRoot, { recursive: true, force: true });
  }, 20_000);

  it('waits for accepted writes before archive and purge, then rejects queued/new writes', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-workspace-lifecycle-race-'));
    const options = {
      dataDir: path.join(root, 'data'),
      artifactsDir: path.join(root, 'runs'),
      runId: 'lifecycle-race-default',
      clientUrl: '',
    };
    const app = await createApp(options);
    server = app.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.on('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = async (route: string, init?: RequestInit) => fetch(`${base}${route}`, init);
    const created = (await (
      await request('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Race target', goal: 'Serialize lifecycle changes' }),
      })
    ).json()) as { workspace: { id: string } };
    const id = created.workspace.id;
    const workspaceDir = path.join(root, 'data/workspaces', id);
    const targetService = await app.workspaces.get(id);
    const originalImport = targetService.assets.importLocalAsset.bind(targetService.assets);
    let signalImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => (signalImportStarted = resolve));
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => (releaseImport = resolve));
    targetService.assets.importLocalAsset = async (input) => {
      signalImportStarted();
      await importGate;
      return originalImport(input);
    };
    const upload = request(`/api/workspaces/${id}/assets/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Asset-Name': 'Racing import',
        'X-Asset-File-Name': 'racing.glb',
        'X-Asset-Tags': '%5B%5D',
      },
      body: Uint8Array.from(tinyGlb()),
    });
    await importStarted;
    const queuedTool = request(`/api/workspaces/${id}/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'create_object',
        arguments: { name: 'Late write', type: 'box' },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    let archiveFinished = false;
    const archive = request(`/api/workspaces/${id}/archive`, { method: 'POST' }).then(
      (response) => {
        archiveFinished = true;
        return response;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(archiveFinished).toBe(false);
    releaseImport();
    expect((await upload).status).toBe(201);
    expect((await archive).status).toBe(200);
    expect((await queuedTool).status).toBe(422);
    expect(
      ((await (await request(`/api/workspaces/${id}/state`)).json()) as Scene).objects,
    ).toEqual([]);

    let signalDelayedWrite!: () => void;
    const delayedWriteStarted = new Promise<void>((resolve) => (signalDelayedWrite = resolve));
    let releaseDelayedWrite!: () => void;
    const delayedWriteGate = new Promise<void>((resolve) => (releaseDelayedWrite = resolve));
    const delayedWrite = targetService.serialize(async () => {
      signalDelayedWrite();
      await delayedWriteGate;
      await writeFile(path.join(workspaceDir, 'delayed-finish.txt'), 'finished before purge');
    });
    await delayedWriteStarted;
    let purgeFinished = false;
    const purge = request(`/api/workspaces/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmWorkspaceId: id }),
    }).then((response) => {
      purgeFinished = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(purgeFinished).toBe(false);
    releaseDelayedWrite();
    await delayedWrite;
    expect((await purge).status).toBe(200);
    await expect(access(workspaceDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
