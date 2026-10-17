import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../engine/scene.js';
import { ToolService, type ServiceOptions } from './service.js';

export interface WorkspaceManifest {
  id: string;
  name: string;
  owner?: string;
  createdAt: string;
}

const validWorkspace = (id: string) =>
  id === 'default' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export class WorkspaceManager {
  readonly defaultService: ToolService;
  private readonly services = new Map<string, ToolService>();
  private readonly opening = new Map<string, Promise<ToolService>>();
  private readonly workspaceRoot: string;
  constructor(private readonly options: ServiceOptions) {
    this.workspaceRoot = path.resolve(options.dataDir, 'workspaces');
    this.defaultService = new ToolService(options);
    this.defaultService.options.workspaceId = 'default';
    this.defaultService.options.promoteAsset = (args) => this.promote(this.defaultService, args);
    this.services.set('default', this.defaultService);
  }

  async init(): Promise<void> {
    await this.defaultService.init();
    await mkdir(this.workspaceRoot, { recursive: true });
  }

  async list(): Promise<Array<WorkspaceManifest & { runId?: string; active: boolean }>> {
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true }).catch(() => []);
    const result: Array<WorkspaceManifest & { runId?: string; active: boolean }> = [
      {
        id: 'default',
        name: 'Default workspace',
        createdAt: 'legacy',
        runId: this.defaultService.options.runId,
        active: true,
      },
    ];
    for (const entry of entries) {
      if (!entry.isDirectory() || !validWorkspace(entry.name) || entry.name === 'default') continue;
      try {
        const manifest = JSON.parse(
          await readFile(path.join(this.workspaceRoot, entry.name, 'workspace.json'), 'utf8'),
        ) as WorkspaceManifest;
        if (manifest.id === entry.name) {
          const activeService = this.services.get(entry.name);
          result.push({
            ...manifest,
            ...(activeService ? { runId: activeService.options.runId } : {}),
            active: Boolean(activeService),
          });
        }
      } catch {
        /* Ignore incomplete workspace directories. */
      }
    }
    return result;
  }

  async describe(id: string): Promise<WorkspaceManifest & { runId?: string; active: boolean }> {
    if (!validWorkspace(id))
      throw new ToolError('WORKSPACE_NOT_FOUND', `Invalid workspace ID '${id}'.`);
    if (id === 'default')
      return {
        id,
        name: 'Default workspace',
        createdAt: 'legacy',
        runId: this.defaultService.options.runId,
        active: true,
      };
    const activeService = this.services.get(id);
    let manifest: WorkspaceManifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(this.workspaceRoot, id, 'workspace.json'), 'utf8'),
      ) as WorkspaceManifest;
    } catch {
      throw new ToolError('WORKSPACE_NOT_FOUND', `No workspace named '${id}'.`);
    }
    if (manifest.id !== id || !manifest.name || !manifest.createdAt)
      throw new ToolError('INVALID_WORKSPACE', 'Workspace manifest is invalid.');
    return {
      ...manifest,
      ...(activeService ? { runId: activeService.options.runId } : {}),
      active: Boolean(activeService),
    };
  }

  async create(input: {
    name: string;
    owner?: string;
  }): Promise<WorkspaceManifest & { runId: string }> {
    const name = input.name.trim();
    if (!name || name.length > 100)
      throw new ToolError('INVALID_WORKSPACE', 'Workspace name must contain 1–100 characters.');
    if (input.owner && input.owner.length > 120)
      throw new ToolError('INVALID_WORKSPACE', 'Workspace owner must be 120 characters or fewer.');
    const id = randomUUID();
    const manifest: WorkspaceManifest = {
      id,
      name,
      ...(input.owner ? { owner: input.owner } : {}),
      createdAt: new Date().toISOString(),
    };
    const dir = path.join(this.workspaceRoot, id);
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await mkdir(path.join(dir, 'scenes'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'workspace.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx',
    });
    const service = await this.open(manifest);
    return { ...manifest, runId: service.options.runId };
  }

  async get(id: string): Promise<ToolService> {
    if (!validWorkspace(id))
      throw new ToolError('WORKSPACE_NOT_FOUND', `Invalid workspace ID '${id}'.`);
    const existing = this.services.get(id);
    if (existing) return existing;
    if (id === 'default') return this.defaultService;
    const pending = this.opening.get(id);
    if (pending) return pending;
    const task = this.openManifest(id);
    this.opening.set(id, task);
    try {
      return await task;
    } finally {
      this.opening.delete(id);
    }
  }

  private async openManifest(id: string): Promise<ToolService> {
    const file = path.join(this.workspaceRoot, id, 'workspace.json');
    let manifest: WorkspaceManifest;
    try {
      manifest = JSON.parse(await readFile(file, 'utf8')) as WorkspaceManifest;
    } catch {
      throw new ToolError('WORKSPACE_NOT_FOUND', `No workspace named '${id}'.`);
    }
    if (manifest.id !== id || !manifest.name || !manifest.createdAt)
      throw new ToolError('INVALID_WORKSPACE', 'Workspace manifest is invalid.');
    return this.open(manifest);
  }

  private async open(manifest: WorkspaceManifest): Promise<ToolService> {
    const id = manifest.id;
    const dataDir = path.join(this.workspaceRoot, id);
    const artifactsDir = path.join(this.options.artifactsDir, 'workspaces', id, 'runs');
    const runId = `workspace-${id.slice(0, 8)}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const service = new ToolService({
      ...this.options,
      dataDir,
      artifactsDir,
      runId,
      workspaceId: id,
      promoteAsset: (args) => this.promote(service, args),
    });
    await service.init();
    this.services.set(id, service);
    return service;
  }

  async historicalRunDir(workspaceId: string, runId: string): Promise<string> {
    if (!validWorkspace(workspaceId))
      throw new ToolError('WORKSPACE_NOT_FOUND', 'Invalid workspace ID.');
    if (!/^[a-zA-Z0-9][\w-]{0,99}$/.test(runId))
      throw new ToolError('RUN_NOT_FOUND', 'Invalid run ID.');
    const base =
      workspaceId === 'default'
        ? path.resolve(this.options.artifactsDir)
        : path.resolve(this.options.artifactsDir, 'workspaces', workspaceId, 'runs');
    const candidate = path.resolve(base, runId);
    if (path.dirname(candidate) !== base) throw new ToolError('RUN_NOT_FOUND', 'Invalid run ID.');
    if (!(await stat(candidate).catch(() => null))?.isDirectory())
      throw new ToolError('RUN_NOT_FOUND', `No run '${runId}' in workspace '${workspaceId}'.`);
    return candidate;
  }

  private async promote(target: ToolService, args: Record<string, unknown>): Promise<unknown> {
    const sourceId = String(args.sourceWorkspaceId);
    if (!validWorkspace(sourceId))
      throw new ToolError('WORKSPACE_NOT_FOUND', `Invalid source workspace '${sourceId}'.`);
    const source = await this.get(sourceId);
    let data: Buffer;
    let fileName: string;
    let name: string;
    let lineage: Record<string, string>;
    if (typeof args.sourceAssetId === 'string') {
      const record = await source.assets.get(args.sourceAssetId);
      if (record.source !== 'local')
        throw new ToolError('ASSET_NOT_FOUND', 'Only local catalog assets can be promoted.');
      data = await readFile(await source.assets.filePath(record.id));
      fileName = record.originalFileName ?? path.basename(record.file ?? 'asset.glb');
      name = record.name;
      lineage = { sourceWorkspaceId: sourceId, sourceAssetId: record.id };
    } else {
      const sourceRunId = String(args.sourceRunId);
      const executionId = String(args.sourceExportExecutionId);
      const runDir = await this.historicalRunDir(sourceId, sourceRunId);
      let events: Array<Record<string, unknown>>;
      try {
        events = (await readFile(path.join(runDir, 'events.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        throw new ToolError('EXPORT_NOT_FOUND', 'Source run has no readable event log.');
      }
      const event = events.find(
        (entry) =>
          entry.executionId === executionId &&
          entry.tool === 'export_scene' &&
          entry.runId === sourceRunId &&
          (entry.workspaceId === undefined || entry.workspaceId === sourceId) &&
          entry.success === true,
      ) as Record<string, unknown> | undefined;
      if (!event)
        throw new ToolError(
          'EXPORT_NOT_FOUND',
          'No successful export_scene execution with that ID exists in the source run.',
        );
      const exportResult = event.result as { fileName?: string } | undefined;
      const expectedFile = `scene-${executionId}.glb`;
      if (exportResult?.fileName !== expectedFile)
        throw new ToolError(
          'EXPORT_NOT_FOUND',
          'The recorded export does not name the expected GLB.',
        );
      const file = path.join(runDir, 'exports', expectedFile);
      data = await readFile(file).catch(() => {
        throw new ToolError('EXPORT_NOT_FOUND', 'The verified GLB file is missing.');
      });
      fileName = expectedFile;
      name = `Promoted scene ${sourceRunId.slice(0, 24)}`;
      lineage = { sourceWorkspaceId: sourceId, sourceRunId, sourceExportExecutionId: executionId };
    }
    const asset = await target.assets.importLocalAsset({
      name,
      fileName,
      tags: ['promoted'],
      data,
    });
    return { asset, lineage };
  }
}
