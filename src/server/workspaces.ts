import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../engine/scene.js';
import { atomicJson, ToolService, type ServiceOptions } from './service.js';

export type WorkspaceWorkStatus = 'planned' | 'working' | 'blocked' | 'needs_review' | 'done';
export interface WorkspaceContext {
  id: string;
  name: string;
  owner?: string;
  workspaceStatus: 'active' | 'archived';
  workStatus: WorkspaceWorkStatus;
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  currentTask: string;
  summary: string;
  metadataRevision: number;
  updatedAt: string;
  createdAt: string;
  lastRunId?: string;
  runId?: string;
  currentScene: { available: boolean; revision?: number; objectCount?: number };
  latestCheckpoint?: {
    id: string;
    label: string;
    sceneRevision: number;
    status: string;
    screenshotUrl?: string;
    runId: string;
  };
  recentActivity: Array<{
    runId: string;
    executionId: string;
    tool: string;
    timestamp: string;
    success: boolean;
    sceneRevision: number;
  }>;
  availableSaves: string[];
  workflowSteps: string[];
}

export interface WorkspaceManifest extends Omit<
  WorkspaceContext,
  | 'runId'
  | 'currentScene'
  | 'latestCheckpoint'
  | 'recentActivity'
  | 'availableSaves'
  | 'workflowSteps'
> {}

const isWorkStatus = (value: unknown): value is WorkspaceWorkStatus =>
  value === 'planned' ||
  value === 'working' ||
  value === 'blocked' ||
  value === 'needs_review' ||
  value === 'done';
const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const defaultContext = (): WorkspaceContext => ({
  id: 'default',
  name: 'Default workspace',
  workspaceStatus: 'active',
  workStatus: 'planned',
  goal: '',
  acceptanceCriteria: [],
  constraints: [],
  currentTask: '',
  summary: '',
  metadataRevision: 0,
  updatedAt: 'legacy',
  createdAt: 'legacy',
  currentScene: { available: true, revision: 0, objectCount: 0 },
  recentActivity: [],
  availableSaves: [],
  workflowSteps: [
    'Read the scene and context.',
    'Build with public tools.',
    'Render and inspect the PNG.',
    'Save and verify the scene.',
  ],
});

const validWorkspace = (id: string) =>
  id === 'default' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export class WorkspaceManager {
  readonly defaultService: ToolService;
  private readonly services = new Map<string, ToolService>();
  private readonly opening = new Map<string, Promise<ToolService>>();
  private readonly workspaceRoot: string;
  private readonly metadataQueues = new Map<string, Promise<unknown>>();
  constructor(private readonly options: ServiceOptions) {
    this.workspaceRoot = path.resolve(options.dataDir, 'workspaces');
    this.defaultService = new ToolService(options);
    this.defaultService.options.workspaceId = 'default';
    this.defaultService.options.promoteAsset = (args) => this.promote(this.defaultService, args);
    this.defaultService.options.getWorkspaceContext = () => this.context('default');
    this.defaultService.options.updateWorkspaceContext = (patch) =>
      this.updateContext('default', patch);
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
        ...(await this.context('default')),
        runId: this.defaultService.options.runId,
        active: true,
      },
    ];
    for (const entry of entries) {
      if (!entry.isDirectory() || !validWorkspace(entry.name) || entry.name === 'default') continue;
      try {
        const manifest = await this.readManifest(entry.name);
        if (manifest.id === entry.name) {
          const activeService = this.services.get(entry.name);
          result.push({
            ...manifest,
            ...((activeService?.options.runId ?? manifest.lastRunId)
              ? { runId: activeService?.options.runId ?? manifest.lastRunId }
              : {}),
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
        ...(await this.context('default')),
        runId: this.defaultService.options.runId,
        active: true,
      };
    const activeService = this.services.get(id);
    const manifest = await this.readManifest(id);
    return {
      ...manifest,
      ...((activeService?.options.runId ?? manifest.lastRunId)
        ? { runId: activeService?.options.runId ?? manifest.lastRunId }
        : {}),
      active: Boolean(activeService),
    };
  }

  async create(input: {
    name: string;
    owner?: string;
    goal?: string;
    acceptanceCriteria?: string[];
    constraints?: string[];
  }): Promise<WorkspaceManifest & { runId: string }> {
    const name = input.name.trim();
    if (!name || name.length > 100)
      throw new ToolError('INVALID_WORKSPACE', 'Workspace name must contain 1–100 characters.');
    if (!input.goal?.trim() || input.goal.trim().length > 2000)
      throw new ToolError(
        'INVALID_WORKSPACE',
        'Workspace goal is required and must be 1–2000 characters.',
      );
    if (input.owner && input.owner.length > 120)
      throw new ToolError('INVALID_WORKSPACE', 'Workspace owner must be 120 characters or fewer.');
    const id = randomUUID();
    const manifest: WorkspaceManifest = {
      id,
      name,
      ...(input.owner ? { owner: input.owner } : {}),
      workspaceStatus: 'active',
      workStatus: 'planned',
      goal: input.goal?.trim() ?? '',
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      constraints: input.constraints ?? [],
      currentTask: '',
      summary: '',
      metadataRevision: 0,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    const dir = path.join(this.workspaceRoot, id);
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await mkdir(path.join(dir, 'scenes'), { recursive: true });
    await atomicJson(path.join(dir, 'workspace.json'), manifest);
    const service = await this.open(manifest);
    return { ...manifest, runId: service.options.runId };
  }

  async context(id: string): Promise<WorkspaceContext> {
    const manifest = await this.readManifest(id);
    return this.toContext(manifest);
  }

  async updateContext(
    id: string,
    patch: Partial<Omit<WorkspaceContext, 'id' | 'createdAt' | 'metadataRevision'>>,
  ): Promise<WorkspaceContext> {
    const previous = this.metadataQueues.get(id) ?? Promise.resolve();
    const task = previous.then(async () => {
      const manifest = await this.readManifest(id);
      const next = {
        ...manifest,
        ...patch,
        metadataRevision: manifest.metadataRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      const workspaceDir = path.join(this.workspaceRoot, id);
      await mkdir(workspaceDir, { recursive: true });
      await atomicJson(path.join(workspaceDir, 'workspace.json'), next);
      return this.toContext(next);
    });
    this.metadataQueues.set(id, task);
    try {
      return await task;
    } finally {
      if (this.metadataQueues.get(id) === task) this.metadataQueues.delete(id);
    }
  }

  private async readManifest(id: string): Promise<WorkspaceManifest> {
    if (!validWorkspace(id))
      throw new ToolError('WORKSPACE_NOT_FOUND', `Invalid workspace ID '${id}'.`);
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(path.join(this.workspaceRoot, id, 'workspace.json'), 'utf8'));
    } catch {
      if (id === 'default') return defaultContext();
      throw new ToolError('WORKSPACE_NOT_FOUND', `No workspace named '${id}'.`);
    }
    if (raw.id !== id || typeof raw.name !== 'string' || typeof raw.createdAt !== 'string')
      throw new ToolError('INVALID_WORKSPACE', 'Workspace manifest is invalid.');
    const base = {
      id,
      name: raw.name,
      ...(typeof raw.owner === 'string' ? { owner: raw.owner } : {}),
      workspaceStatus: raw.workspaceStatus === 'archived' ? 'archived' : 'active',
      workStatus: isWorkStatus(raw.workStatus) ? raw.workStatus : 'planned',
      goal: typeof raw.goal === 'string' ? raw.goal : '',
      acceptanceCriteria: stringArray(raw.acceptanceCriteria),
      constraints: stringArray(raw.constraints),
      currentTask: typeof raw.currentTask === 'string' ? raw.currentTask : '',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      metadataRevision: Number.isInteger(raw.metadataRevision) ? Number(raw.metadataRevision) : 0,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : String(raw.createdAt),
      createdAt: raw.createdAt,
      lastRunId: typeof raw.lastRunId === 'string' ? raw.lastRunId : undefined,
    };
    return base as WorkspaceManifest;
  }

  private async toContext(manifest: WorkspaceManifest): Promise<WorkspaceContext> {
    const {
      id,
      name,
      owner,
      workspaceStatus,
      workStatus,
      goal,
      acceptanceCriteria,
      constraints,
      currentTask,
      summary,
      metadataRevision,
      updatedAt,
      createdAt,
    } = manifest;
    const active = this.services.get(id);
    const runId = active?.options.runId ?? manifest.lastRunId;
    const currentSnapshot = active?.engine.snapshot();
    const runDirs = await this.listRunDirs(id);
    const recentActivity: WorkspaceContext['recentActivity'] = [];
    const checkpoints: Array<
      NonNullable<WorkspaceContext['latestCheckpoint']> & { timestamp: string }
    > = [];
    for (const run of runDirs) {
      const runPath = await this.runDir(id, run.runId);
      try {
        const events = (await readFile(path.join(runPath, 'events.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .slice(-5)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        for (const event of events) {
          if (typeof event.executionId === 'string' && typeof event.tool === 'string')
            recentActivity.push({
              runId: run.runId,
              executionId: event.executionId,
              tool: event.tool,
              timestamp: String(event.timestamp ?? ''),
              success: event.success === true,
              sceneRevision: Number(event.sceneRevision ?? 0),
            });
        }
      } catch {
        // Incomplete historical runs do not prevent context inspection.
      }
      const checkpointDir = path.join(runPath, 'checkpoints');
      for (const entry of await readdir(checkpointDir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        try {
          const checkpoint = JSON.parse(
            await readFile(path.join(checkpointDir, entry.name, 'checkpoint.json'), 'utf8'),
          ) as Record<string, unknown>;
          if (typeof checkpoint.id === 'string')
            checkpoints.push({
              id: checkpoint.id,
              label: String(checkpoint.label ?? ''),
              sceneRevision: Number(checkpoint.sceneRevision ?? 0),
              status: String(checkpoint.status ?? 'unknown'),
              ...(typeof checkpoint.screenshotUrl === 'string'
                ? { screenshotUrl: checkpoint.screenshotUrl }
                : {}),
              runId: run.runId,
              timestamp: String(checkpoint.timestamp ?? ''),
            });
        } catch {
          // Ignore incomplete checkpoints.
        }
      }
    }
    recentActivity.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    checkpoints.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const saveDir =
      id === 'default'
        ? path.join(this.options.dataDir, 'scenes')
        : path.join(this.workspaceRoot, id, 'scenes');
    const availableSaves = (await readdir(saveDir).catch(() => []))
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .sort();
    return {
      id,
      name,
      ...(owner ? { owner } : {}),
      workspaceStatus,
      workStatus,
      goal,
      acceptanceCriteria,
      constraints,
      currentTask,
      summary,
      metadataRevision,
      updatedAt,
      createdAt,
      ...(runId ? { runId } : {}),
      currentScene: currentSnapshot
        ? {
            available: true,
            revision: currentSnapshot.revision,
            objectCount: currentSnapshot.objects.length,
          }
        : { available: false },
      ...(checkpoints[0]
        ? {
            latestCheckpoint: {
              id: checkpoints[0].id,
              label: checkpoints[0].label,
              sceneRevision: checkpoints[0].sceneRevision,
              status: checkpoints[0].status,
              ...(checkpoints[0].screenshotUrl
                ? { screenshotUrl: checkpoints[0].screenshotUrl }
                : {}),
              runId: checkpoints[0].runId,
            },
          }
        : {}),
      recentActivity: recentActivity.slice(0, 8),
      availableSaves,
      workflowSteps: [
        'Read this context and inspect the current scene.',
        'Build or revise through public scene tools.',
        'Render and inspect the actual PNG; correct visible issues.',
        'Save the editable scene and verify its reload.',
      ],
    };
  }

  private async listRunDirs(
    workspaceId: string,
  ): Promise<Array<{ runId: string; modified: number }>> {
    const base =
      workspaceId === 'default'
        ? path.resolve(this.options.artifactsDir)
        : path.resolve(this.options.artifactsDir, 'workspaces', workspaceId, 'runs');
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const runs = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            (workspaceId !== 'default' || entry.name !== 'workspaces') &&
            /^[a-zA-Z0-9][\w-]{0,99}$/.test(entry.name),
        )
        .map(async (entry) => ({
          runId: entry.name,
          modified: (await stat(path.join(base, entry.name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
        })),
    );
    return runs.sort((a, b) => b.modified - a.modified).slice(0, 10);
  }

  private async runDir(workspaceId: string, runId: string): Promise<string> {
    return this.historicalRunDir(workspaceId, runId);
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
    const manifest = await this.readManifest(id);
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
      getWorkspaceContext: () => this.context(id),
      updateWorkspaceContext: (patch) => this.updateContext(id, patch),
    });
    await service.init();
    await atomicJson(path.join(dataDir, 'workspace.json'), { ...manifest, lastRunId: runId });
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
