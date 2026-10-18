import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.js';
import { WorkspaceManager } from '../src/server/workspaces.js';
import type { ToolResponse } from '../src/shared/schema.js';
import { tinyGlb } from './helpers/assets.js';

describe('canonical workspace storage migration', () => {
  let root = '';
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('moves legacy default and UUID data, serves historical artifacts, and promotes an old export', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-migration-'));
    const workspaceId = 'dbd2517f-1163-4b39-975d-f48ed3c9a82c';
    const oldRunId = 'workspace-old-run';
    const executionId = 'e735b665-5d81-49ea-89da-810877f0735f';
    const dataDir = path.join(root, 'data');
    const artifactsDir = path.join(root, 'artifacts');
    const legacyDefaultRun = path.join(artifactsDir, 'default-old-run');
    const legacyWorkspaceRun = path.join(artifactsDir, 'workspaces', workspaceId, 'runs', oldRunId);
    await mkdir(path.join(dataDir, 'scenes'), { recursive: true });
    await mkdir(path.join(dataDir, 'assets', 'models'), { recursive: true });
    await mkdir(path.join(dataDir, 'workspaces', workspaceId), { recursive: true });
    await mkdir(legacyDefaultRun, { recursive: true });
    await mkdir(path.join(legacyWorkspaceRun, 'exports'), { recursive: true });
    await writeFile(path.join(dataDir, 'scenes', 'legacy.json'), '{"objects":[]}');
    await writeFile(
      path.join(dataDir, 'assets', 'catalog.json'),
      JSON.stringify({
        assets: [
          {
            id: 'local:legacy-fixture',
            name: 'Legacy fixture',
            description: 'Moved from the legacy catalog.',
            kind: 'model',
            tags: ['legacy'],
            source: 'local',
            format: 'glb',
            file: 'models/fixture.glb',
            bounds: [1, 1, 1],
          },
        ],
      }),
    );
    await writeFile(path.join(dataDir, 'assets', 'models', 'fixture.glb'), tinyGlb());
    await writeFile(path.join(legacyDefaultRun, 'events.jsonl'), '{"tool":"legacy"}\n');
    await writeFile(path.join(legacyDefaultRun, 'marker.txt'), 'default artifact');
    await writeFile(
      path.join(dataDir, 'workspaces', workspaceId, 'workspace.json'),
      JSON.stringify({
        id: workspaceId,
        name: 'Legacy specialist',
        createdAt: '2026-01-01T00:00:00.000Z',
        goal: 'Promote a saved export',
        acceptanceCriteria: [],
        constraints: [],
        currentTask: '',
        summary: '',
        workspaceStatus: 'active',
        workStatus: 'done',
        metadataRevision: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await writeFile(
      path.join(legacyWorkspaceRun, 'exports', `scene-${executionId}.glb`),
      tinyGlb(),
    );
    await writeFile(
      path.join(legacyWorkspaceRun, 'events.jsonl'),
      `${JSON.stringify({
        runId: oldRunId,
        workspaceId,
        executionId,
        tool: 'export_scene',
        success: true,
        sceneRevision: 4,
        result: { fileName: `scene-${executionId}.glb` },
      })}\n`,
    );

    const options = {
      dataDir,
      artifactsDir,
      runId: 'migration-test-run',
      clientUrl: '',
      capture: async (_url: string, output: string) => writeFile(output, 'captured'),
    };
    const app = await createApp(options);
    server = app.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.on('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const canonicalDefault = path.join(dataDir, 'workspaces', 'default');
    const canonicalSpecialistRun = path.join(dataDir, 'workspaces', workspaceId, 'runs', oldRunId);
    expect(await readFile(path.join(canonicalDefault, 'scenes', 'legacy.json'), 'utf8')).toBe(
      '{"objects":[]}',
    );
    expect(await readFile(path.join(canonicalDefault, 'assets', 'models', 'fixture.glb'))).toEqual(
      tinyGlb(),
    );
    expect(
      await readFile(path.join(canonicalDefault, 'runs', 'default-old-run', 'marker.txt'), 'utf8'),
    ).toBe('default artifact');
    expect(await readFile(path.join(canonicalSpecialistRun, 'events.jsonl'), 'utf8')).toContain(
      executionId,
    );
    const catalogSearch = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'search_assets',
        arguments: { query: 'Legacy fixture', kind: 'model' },
      }),
    }).then((response) => response.json() as Promise<ToolResponse>);
    expect(catalogSearch.success).toBe(true);
    expect(catalogSearch.result).toContainEqual(
      expect.objectContaining({ id: 'local:legacy-fixture', file: 'models/fixture.glb' }),
    );
    await expect(stat(path.join(dataDir, 'scenes'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(dataDir, 'assets'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(legacyDefaultRun)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(artifactsDir, 'workspaces'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const historicalArtifact = await fetch(
      `${base}/api/workspaces/${workspaceId}/artifacts/${oldRunId}/events.jsonl`,
    );
    expect(historicalArtifact.status).toBe(200);
    const promotion = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'promote_asset',
        arguments: {
          sourceWorkspaceId: workspaceId,
          sourceRunId: oldRunId,
          sourceExportExecutionId: executionId,
        },
      }),
    });
    const promoted = (await promotion.json()) as ToolResponse;
    expect(promotion.status, JSON.stringify(promoted)).toBe(200);
    expect(promoted.success).toBe(true);
    expect(promoted.result).toMatchObject({
      lineage: {
        sourceWorkspaceId: workspaceId,
        sourceRunId: oldRunId,
        sourceExportExecutionId: executionId,
      },
    });
    const promotedAssetId = (promoted.result as { asset: { id: string } }).asset.id;
    expect(promotedAssetId).toMatch(/^local:/);
    expect(
      await readFile(path.join(canonicalSpecialistRun, 'exports', `scene-${executionId}.glb`)),
    ).toEqual(tinyGlb());
  });

  it('resumes an interrupted migration after a collision is resolved and is idempotent', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-migration-resume-'));
    const dataDir = path.join(root, 'data');
    const artifactsDir = path.join(root, 'artifacts');
    await mkdir(path.join(artifactsDir, 'a-moved'), { recursive: true });
    await mkdir(path.join(artifactsDir, 'z-collision'), { recursive: true });
    await mkdir(path.join(dataDir, 'workspaces', 'default', 'runs', 'z-collision'), {
      recursive: true,
    });
    await writeFile(path.join(artifactsDir, 'a-moved', 'data.txt'), 'moved first');
    await writeFile(path.join(artifactsDir, 'z-collision', 'data.txt'), 'legacy version');
    await writeFile(
      path.join(dataDir, 'workspaces', 'default', 'runs', 'z-collision', 'data.txt'),
      'canonical version',
    );
    const options = { dataDir, artifactsDir, runId: 'resume-one', clientUrl: '' };
    const firstAttempt = await createApp(options).then(
      () => null,
      (error: Error & { code?: string }) => error,
    );
    expect(firstAttempt).toMatchObject({ code: 'STORAGE_MIGRATION_CONFLICT' });
    expect(
      await readFile(path.join(dataDir, 'workspaces/default/runs/a-moved/data.txt'), 'utf8'),
    ).toBe('moved first');
    await expect(
      readFile(path.join(artifactsDir, 'a-moved/data.txt'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(artifactsDir, 'z-collision/data.txt'), 'utf8')).toBe(
      'legacy version',
    );
    expect(
      await readFile(path.join(dataDir, 'workspaces/default/runs/z-collision/data.txt'), 'utf8'),
    ).toBe('canonical version');

    await rm(path.join(dataDir, 'workspaces/default/runs/z-collision'), {
      recursive: true,
      force: true,
    });
    const restarted = await createApp({ ...options, runId: 'resume-two' });
    const restartedServer = restarted.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => {
      server = restartedServer;
      restartedServer.on('listening', resolve);
    });
    const secondAttempt = await fetch(
      `http://127.0.0.1:${(restartedServer.address() as AddressInfo).port}/api/state`,
    );
    expect(secondAttempt.status).toBe(200);
    expect(
      await readFile(path.join(dataDir, 'workspaces/default/runs/z-collision/data.txt'), 'utf8'),
    ).toBe('legacy version');
    await expect(stat(path.join(artifactsDir, 'z-collision'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await restarted.workspaces.ensureStorage();
    expect(
      await readFile(path.join(dataDir, 'workspaces/default/runs/a-moved/data.txt'), 'utf8'),
    ).toBe('moved first');
  });

  it('rejects a concurrent migration owner and recovers a stale lock before marking completion', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-migration-lock-'));
    const dataDir = path.join(root, 'data');
    const artifactsDir = path.join(root, 'artifacts');
    const workspaceRoot = path.join(dataDir, 'workspaces');
    const lockPath = path.join(workspaceRoot, '.storage-migration.lock');
    await mkdir(workspaceRoot, { recursive: true });
    const options = { dataDir, artifactsDir, runId: 'lock-test', clientUrl: '' };
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: (await import('node:os')).hostname(),
        startedAt: 'now',
      }),
    );
    const manager = new WorkspaceManager(options);
    await expect(manager.ensureStorage()).rejects.toMatchObject({
      code: 'STORAGE_MIGRATION_IN_PROGRESS',
    });
    await expect(stat(path.join(workspaceRoot, '.storage-migration.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        host: (await import('node:os')).hostname(),
        startedAt: 'stale',
      }),
    );
    await manager.ensureStorage();
    const marker = JSON.parse(
      await readFile(path.join(workspaceRoot, '.storage-migration.json'), 'utf8'),
    ) as { version: number };
    expect(marker.version).toBe(1);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await manager.ensureStorage();
  });

  it('migrates newly written legacy runs even when the completion marker already exists', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-migration-marker-'));
    const dataDir = path.join(root, 'data');
    const artifactsDir = path.join(root, 'artifacts');
    const workspaceRoot = path.join(dataDir, 'workspaces');
    const staleRun = path.join(artifactsDir, 'late-legacy-run');
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(staleRun, { recursive: true });
    await writeFile(path.join(staleRun, 'events.jsonl'), '{"tool":"late write"}\n');
    await writeFile(
      path.join(workspaceRoot, '.storage-migration.json'),
      JSON.stringify({ version: 1, completedAt: 'earlier' }),
    );

    const manager = new WorkspaceManager({
      dataDir,
      artifactsDir,
      runId: 'marker-test',
      clientUrl: '',
    });
    await manager.ensureStorage();
    expect(
      await readFile(
        path.join(workspaceRoot, 'default', 'runs', 'late-legacy-run', 'events.jsonl'),
        'utf8',
      ),
    ).toBe('{"tool":"late write"}\n');
    await expect(stat(staleRun)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
