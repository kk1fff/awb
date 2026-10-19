import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  open,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
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
  recoveryError?: { code: string; message: string };
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
  | 'recoveryError'
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
const validRunId = (id: string) => /^[a-zA-Z0-9][\w-]{0,99}$/.test(id);
const STORAGE_MIGRATION_VERSION = 1;

async function lstatIfExists(location: string) {
  try {
    return await lstat(location);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readdirIfExists(location: string, options: { withFileTypes: true }) {
  try {
    return await readdir(location, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function acquireMigrationLock(lockPath: string): Promise<() => Promise<void>> {
  const owner = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => unlink(lockPath).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    let existing: { pid?: unknown; host?: unknown; startedAt?: unknown } | undefined;
    try {
      existing = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      const info = await lstatIfExists(lockPath);
      if (!info) continue;
      if (Date.now() - info.mtimeMs > 30_000) {
        await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        continue;
      }
      throw new ToolError(
        'STORAGE_MIGRATION_IN_PROGRESS',
        `Storage migration lock '${lockPath}' is being initialized. Wait briefly and restart Fieldwork.`,
      );
    }
    if (
      !existing ||
      !Number.isInteger(existing.pid) ||
      typeof existing.host !== 'string' ||
      typeof existing.startedAt !== 'string'
    ) {
      const info = await lstatIfExists(lockPath);
      if (!info) continue;
      if (Date.now() - info.mtimeMs > 30_000) {
        await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        continue;
      }
      throw new ToolError(
        'STORAGE_MIGRATION_IN_PROGRESS',
        `Storage migration lock '${lockPath}' has incomplete owner metadata. Wait briefly and restart Fieldwork.`,
      );
    }
    const lockOwner = existing as { pid: number; host: string; startedAt: string };
    if (lockOwner.host !== hostname())
      throw new ToolError(
        'STORAGE_MIGRATION_IN_PROGRESS',
        `Storage migration is owned by PID ${lockOwner.pid} on host '${lockOwner.host}' since ${lockOwner.startedAt}; stop or inspect that process before starting another server.`,
      );
    try {
      process.kill(lockOwner.pid, 0);
      throw new ToolError(
        'STORAGE_MIGRATION_IN_PROGRESS',
        `Storage migration is already running under PID ${lockOwner.pid} since ${lockOwner.startedAt}; wait for it to finish before starting another server.`,
      );
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk: Buffer) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function migrationConflict(source: string, destination: string): ToolError {
  return new ToolError(
    'STORAGE_MIGRATION_CONFLICT',
    `Cannot migrate '${source}' to '${destination}' because both paths contain different data. Both copies were preserved; resolve the conflict and restart Fieldwork.`,
  );
}

async function cleanupMigrationTemps(destination: string): Promise<void> {
  const parent = path.dirname(destination);
  const prefix = `.${path.basename(destination)}.fieldwork-migration-`;
  for (const entry of await readdirIfExists(parent, { withFileTypes: true })) {
    if (entry.name.startsWith(prefix))
      await rm(path.join(parent, entry.name), { recursive: true, force: true });
  }
}

async function migratePath(source: string, destination: string): Promise<void> {
  const sourceInfo = await lstatIfExists(source);
  if (!sourceInfo) return;
  if (sourceInfo.isSymbolicLink() || (!sourceInfo.isDirectory() && !sourceInfo.isFile()))
    throw new ToolError(
      'STORAGE_MIGRATION_UNSAFE',
      `Refusing to migrate unsupported path '${source}'.`,
    );
  await mkdir(path.dirname(destination), { recursive: true });
  const destinationInfo = await lstatIfExists(destination);
  if (
    destinationInfo?.isSymbolicLink() ||
    (destinationInfo && !destinationInfo.isDirectory() && !destinationInfo.isFile())
  )
    throw migrationConflict(source, destination);
  if (!destinationInfo) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }
  }
  const currentDestination = destinationInfo ?? (await lstatIfExists(destination));
  if (currentDestination && sourceInfo.isDirectory() && currentDestination.isDirectory()) {
    for (const entry of await readdir(source, { withFileTypes: true }))
      await migratePath(path.join(source, entry.name), path.join(destination, entry.name));
    await rmdir(source);
    return;
  }
  if (currentDestination && sourceInfo.isFile() && currentDestination.isFile()) {
    if ((await hashFile(source)) !== (await hashFile(destination)))
      throw migrationConflict(source, destination);
    await unlink(source);
    return;
  }
  if (currentDestination) throw migrationConflict(source, destination);

  // Cross-device directory copy: create the destination incrementally so a crash can resume.
  if (sourceInfo.isDirectory()) {
    await mkdir(destination);
    for (const entry of await readdir(source, { withFileTypes: true }))
      await migratePath(path.join(source, entry.name), path.join(destination, entry.name));
    await rmdir(source);
    return;
  }

  await cleanupMigrationTemps(destination);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.fieldwork-migration-${randomUUID()}`,
  );
  try {
    await copyFile(source, temporary);
    if ((await hashFile(source)) !== (await hashFile(temporary)))
      throw new ToolError(
        'STORAGE_MIGRATION_VERIFY_FAILED',
        `Copied data failed verification: '${source}'.`,
      );
    await rename(temporary, destination);
    await unlink(source);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class WorkspaceManager {
  readonly defaultService: ToolService;
  private readonly services = new Map<string, ToolService>();
  private readonly opening = new Map<string, Promise<ToolService>>();
  private readonly workspaceRoot: string;
  private readonly defaultRoot: string;
  private readonly metadataQueues = new Map<string, Promise<unknown>>();
  private readonly lifecycleTransitions = new Set<string>();
  private readonly projectMode: boolean;
  private readonly mainSession: string;
  constructor(
    private readonly options: ServiceOptions & { projectRoot?: string; mainSession?: string },
  ) {
    this.projectMode = Boolean(options.projectRoot);
    this.mainSession = options.mainSession ?? 'default';
    this.workspaceRoot = options.projectRoot
      ? path.resolve(options.projectRoot)
      : path.resolve(options.dataDir, 'workspaces');
    this.defaultRoot = this.workspaceDir(this.mainSession);
    this.defaultService = new ToolService({
      ...options,
      dataDir: this.defaultRoot,
      artifactsDir: path.join(this.defaultRoot, 'runs'),
    });
    this.defaultService.options.workspaceId = this.mainSession;
    this.defaultService.options.promoteAsset = (args) => this.promote(this.defaultService, args);
    this.defaultService.options.getWorkspaceContext = () => this.context(this.mainSession);
    this.defaultService.options.updateWorkspaceContext = (patch) =>
      this.updateContext(this.mainSession, patch);
    this.services.set(this.mainSession, this.defaultService);
  }

  private workspaceDir(id: string): string {
    return path.join(this.workspaceRoot, this.projectMode ? `session-${id}` : id);
  }

  setClientUrl(url: string): void {
    this.options.clientUrl = url;
    for (const service of this.services.values()) service.options.clientUrl = url;
  }

  async init(): Promise<void> {
    await this.ensureStorage();
    await this.defaultService.init();
    if (this.projectMode) {
      const manifest = await this.readManifest(this.mainSession);
      await atomicJson(path.join(this.defaultRoot, 'workspace.json'), {
        ...manifest,
        lastRunId: this.defaultService.options.runId,
      });
    }
    await mkdir(this.workspaceRoot, { recursive: true });
  }

  async ensureStorage(): Promise<void> {
    if (this.projectMode) {
      await mkdir(this.defaultRoot, { recursive: true });
      const manifestPath = path.join(this.defaultRoot, 'workspace.json');
      const existing = await lstatIfExists(manifestPath);
      if (!existing) {
        const now = new Date().toISOString();
        await atomicJson(manifestPath, {
          id: this.mainSession,
          name: 'Main session',
          workspaceStatus: 'active',
          workStatus: 'planned',
          goal: '',
          acceptanceCriteria: [],
          constraints: [],
          currentTask: '',
          summary: '',
          metadataRevision: 0,
          updatedAt: now,
          createdAt: now,
        } satisfies WorkspaceManifest);
      }
      await this.readManifest(this.mainSession);
      return;
    }
    await mkdir(this.workspaceRoot, { recursive: true });
    const releaseLock = await acquireMigrationLock(
      path.join(this.workspaceRoot, '.storage-migration.lock'),
    );
    try {
      await mkdir(this.defaultRoot, { recursive: true });
      const markerPath = path.join(this.workspaceRoot, '.storage-migration.json');
      let migrationComplete = false;
      try {
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { version?: unknown };
        migrationComplete = marker.version === STORAGE_MIGRATION_VERSION;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
          throw error;
      }
      // The marker records a completed pass, but legacy roots are still scanned on every startup:
      // an older process may have written into them since the last pass.
      await this.migrateLegacyStorage();
      await mkdir(path.join(this.defaultRoot, 'scenes'), { recursive: true });
      await mkdir(path.join(this.defaultRoot, 'assets'), { recursive: true });
      await mkdir(path.join(this.defaultRoot, 'runs'), { recursive: true });
      const defaultManifest = path.join(this.defaultRoot, 'workspace.json');
      if (!(await lstatIfExists(defaultManifest)))
        await atomicJson(defaultManifest, {
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
        });
      if (!migrationComplete)
        await atomicJson(markerPath, {
          version: STORAGE_MIGRATION_VERSION,
          completedAt: new Date().toISOString(),
        });
    } finally {
      await releaseLock();
    }
  }

  private async migrateLegacyStorage(): Promise<void> {
    await migratePath(
      path.join(this.options.dataDir, 'scenes'),
      path.join(this.defaultRoot, 'scenes'),
    );
    await migratePath(
      path.join(this.options.dataDir, 'assets'),
      path.join(this.defaultRoot, 'assets'),
    );
    await this.migrateLegacyRuns(
      'default',
      this.options.artifactsDir,
      path.join(this.defaultRoot, 'runs'),
      true,
    );
    const workspaceIds = new Set<string>();
    for (const directory of [
      this.workspaceRoot,
      path.join(this.options.artifactsDir, 'workspaces'),
    ]) {
      const entries = await readdirIfExists(directory, { withFileTypes: true });
      for (const entry of entries)
        if (entry.isDirectory() && validWorkspace(entry.name) && entry.name !== 'default')
          workspaceIds.add(entry.name);
    }
    for (const workspaceId of workspaceIds) {
      const legacyRuns = path.join(this.options.artifactsDir, 'workspaces', workspaceId, 'runs');
      const canonicalRuns = path.join(this.workspaceRoot, workspaceId, 'runs');
      await this.migrateLegacyRuns(workspaceId, legacyRuns, canonicalRuns);
      await this.removeEmptyDirectory(legacyRuns);
      await this.removeEmptyDirectory(path.dirname(legacyRuns));
    }
    await this.removeEmptyDirectory(path.join(this.options.artifactsDir, 'workspaces'));
  }

  private async migrateLegacyRuns(
    workspaceId: string,
    sourceRoot: string,
    destinationRoot: string,
    includesWorkspaceContainer = false,
  ): Promise<void> {
    const entries = await readdirIfExists(sourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (includesWorkspaceContainer && entry.name === 'workspaces') continue;
      if (!entry.isDirectory() || !validRunId(entry.name)) {
        throw new ToolError(
          'STORAGE_MIGRATION_UNSUPPORTED',
          `Unexpected entry '${path.join(sourceRoot, entry.name)}' in legacy run storage for '${workspaceId}'. Resolve it before starting Fieldwork.`,
        );
      }
      await migratePath(path.join(sourceRoot, entry.name), path.join(destinationRoot, entry.name));
    }
  }

  private async removeEmptyDirectory(directory: string): Promise<void> {
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    });
  }

  async list(): Promise<Array<WorkspaceManifest & { runId?: string; active: boolean }>> {
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true }).catch(() => []);
    const result: Array<WorkspaceManifest & { runId?: string; active: boolean }> = [
      {
        ...(await this.context(this.mainSession)),
        runId: this.defaultService.options.runId,
        active: true,
      },
    ];
    for (const entry of entries) {
      const id = this.projectMode ? entry.name.replace(/^session-/, '') : entry.name;
      if (
        !entry.isDirectory() ||
        (this.projectMode && entry.name !== `session-${id}`) ||
        !validWorkspace(id) ||
        id === this.mainSession
      )
        continue;
      try {
        const manifest = await this.readManifest(id);
        if (manifest.id === id) {
          const activeService = this.services.get(id);
          result.push({
            ...manifest,
            ...((activeService?.options.runId ?? manifest.lastRunId)
              ? { runId: activeService?.options.runId ?? manifest.lastRunId }
              : {}),
            active: manifest.workspaceStatus === 'active' && Boolean(activeService),
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
    if (id === this.mainSession)
      return {
        ...(await this.context(this.mainSession)),
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
      active: manifest.workspaceStatus === 'active' && Boolean(activeService),
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
    const dir = this.workspaceDir(id);
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await mkdir(path.join(dir, 'scenes'), { recursive: true });
    await atomicJson(path.join(dir, 'workspace.json'), manifest);
    const service = await this.open(manifest);
    return { ...manifest, runId: service.options.runId };
  }

  async context(id: string): Promise<WorkspaceContext> {
    const manifest = await this.readManifest(id);
    // Context is an explicit agent entry point; opening the workspace lets it report recovery
    // health as well as persisted metadata. Listing workspaces remains lazy and does not open runs.
    if (manifest.workspaceStatus === 'active') await this.getForBrowsing(id);
    const context = await this.toContext(manifest);
    if (this.projectMode && id === this.mainSession && this.options.getProjectInfo) {
      const project = (await this.options.getProjectInfo()) as { goal: string };
      context.goal = project.goal;
    }
    return context;
  }

  async archive(id: string): Promise<WorkspaceManifest & { active: false }> {
    if (id === this.mainSession || !validWorkspace(id))
      throw new ToolError(
        'INVALID_WORKSPACE_LIFECYCLE',
        'The default workspace cannot be archived.',
      );
    this.beginLifecycleTransition(id);
    try {
      const result = await this.queueMetadataChange(id, async () => {
        await this.opening.get(id);
        const persistArchive = async () => {
          const manifest = await this.readManifest(id);
          if (manifest.workspaceStatus === 'archived') return;
          await atomicJson(path.join(this.workspaceDir(id), 'workspace.json'), {
            ...manifest,
            workspaceStatus: 'archived',
            metadataRevision: manifest.metadataRevision + 1,
            updatedAt: new Date().toISOString(),
          });
        };
        const service = this.services.get(id);
        if (service) await service.serialize(persistArchive);
        else await persistArchive();
        return this.describe(id);
      });
      return { ...result, active: false };
    } finally {
      this.lifecycleTransitions.delete(id);
    }
  }

  async restore(id: string): Promise<WorkspaceManifest & { active: boolean }> {
    if (id === this.mainSession || !validWorkspace(id))
      throw new ToolError(
        'INVALID_WORKSPACE_LIFECYCLE',
        'The default workspace cannot be restored.',
      );
    this.beginLifecycleTransition(id);
    try {
      return await this.queueMetadataChange(id, async () => {
        await this.opening.get(id);
        const manifest = await this.readManifest(id);
        if (manifest.workspaceStatus !== 'active') {
          await atomicJson(path.join(this.workspaceDir(id), 'workspace.json'), {
            ...manifest,
            workspaceStatus: 'active',
            metadataRevision: manifest.metadataRevision + 1,
            updatedAt: new Date().toISOString(),
          });
        }
        return this.describe(id);
      });
    } finally {
      this.lifecycleTransitions.delete(id);
    }
  }

  async purge(id: string, confirmation: string): Promise<{ id: string; purged: true }> {
    if (id === this.mainSession || !validWorkspace(id))
      throw new ToolError('INVALID_WORKSPACE_LIFECYCLE', 'The default workspace cannot be purged.');
    if (confirmation !== id)
      throw new ToolError(
        'PURGE_CONFIRMATION_REQUIRED',
        `Confirm purge by providing the exact workspace ID '${id}'.`,
      );
    this.beginLifecycleTransition(id);
    try {
      return await this.queueMetadataChange(id, async () => {
        await this.opening.get(id);
        const manifest = await this.readManifest(id);
        if (manifest.workspaceStatus !== 'archived')
          throw new ToolError('WORKSPACE_NOT_ARCHIVED', 'Archive the workspace before purging it.');
        const service = this.services.get(id);
        if (service) await service.serialize(async () => undefined);
        const directory = this.workspaceDir(id);
        if (path.dirname(directory) !== this.workspaceRoot)
          throw new ToolError(
            'INVALID_WORKSPACE_LIFECYCLE',
            'Workspace path failed safety checks.',
          );
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new ToolError(
            'INVALID_WORKSPACE_LIFECYCLE',
            'Workspace path is not a safe directory.',
          );
        this.services.delete(id);
        await rm(directory, { recursive: true, force: false });
        return { id, purged: true as const };
      });
    } finally {
      this.lifecycleTransitions.delete(id);
    }
  }

  private beginLifecycleTransition(id: string): void {
    if (this.lifecycleTransitions.has(id))
      throw new ToolError(
        'WORKSPACE_LIFECYCLE_BUSY',
        'Another lifecycle operation is in progress.',
      );
    this.lifecycleTransitions.add(id);
  }

  private async queueMetadataChange<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.metadataQueues.get(id) ?? Promise.resolve();
    const task = previous.then(operation);
    this.metadataQueues.set(id, task);
    try {
      return await task;
    } finally {
      if (this.metadataQueues.get(id) === task) this.metadataQueues.delete(id);
    }
  }

  async updateContext(
    id: string,
    patch: Partial<Omit<WorkspaceContext, 'id' | 'createdAt' | 'metadataRevision'>>,
  ): Promise<WorkspaceContext> {
    const previous = this.metadataQueues.get(id) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (this.projectMode && id === this.mainSession && patch.goal !== undefined)
        throw new ToolError('PROJECT_GOAL_ONLY', 'Update the main goal with update_project_info.');
      const manifest = await this.readManifest(id);
      if (this.lifecycleTransitions.has(id))
        throw new ToolError(
          'WORKSPACE_LIFECYCLE_BUSY',
          'A workspace lifecycle change is in progress.',
        );
      if (manifest.workspaceStatus === 'archived')
        throw new ToolError(
          'WORKSPACE_ARCHIVED',
          'Restore the workspace before changing its context.',
        );
      const next = {
        ...manifest,
        ...patch,
        metadataRevision: manifest.metadataRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      const workspaceDir = this.workspaceDir(id);
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

  async assertWritable(id: string): Promise<void> {
    if (this.lifecycleTransitions.has(id))
      throw new ToolError(
        'WORKSPACE_LIFECYCLE_BUSY',
        'A workspace lifecycle change is in progress.',
      );
    const manifest = await this.readManifest(id);
    if (manifest.workspaceStatus === 'archived')
      throw new ToolError('WORKSPACE_ARCHIVED', 'Restore the workspace before making changes.');
    if (this.lifecycleTransitions.has(id))
      throw new ToolError(
        'WORKSPACE_LIFECYCLE_BUSY',
        'A workspace lifecycle change is in progress.',
      );
  }

  private async readManifest(id: string): Promise<WorkspaceManifest> {
    if (!validWorkspace(id))
      throw new ToolError('WORKSPACE_NOT_FOUND', `Invalid workspace ID '${id}'.`);
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(path.join(this.workspaceDir(id), 'workspace.json'), 'utf8'));
    } catch {
      if (id === 'default' && !this.projectMode) return defaultContext();
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
      id === this.mainSession
        ? path.join(this.defaultRoot, 'scenes')
        : path.join(this.workspaceDir(id), 'scenes');
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
      ...(active?.recoveryError ? { recoveryError: active.recoveryError } : {}),
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
      workspaceId === this.mainSession
        ? path.join(this.defaultRoot, 'runs')
        : path.join(this.workspaceDir(workspaceId), 'runs');
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
    if (id === this.mainSession) return this.defaultService;
    if (this.lifecycleTransitions.has(id))
      throw new ToolError(
        'WORKSPACE_LIFECYCLE_BUSY',
        'A workspace lifecycle change is in progress.',
      );
    const manifest = await this.readManifest(id);
    if (this.lifecycleTransitions.has(id))
      throw new ToolError(
        'WORKSPACE_LIFECYCLE_BUSY',
        'A workspace lifecycle change is in progress.',
      );
    if (manifest.workspaceStatus === 'archived')
      throw new ToolError(
        'WORKSPACE_ARCHIVED',
        'Restore the workspace before binding an agent to it.',
      );
    const existing = this.services.get(id);
    if (existing) return existing;
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

  async getForBrowsing(id: string): Promise<ToolService> {
    if (!validWorkspace(id))
      throw new ToolError('WORKSPACE_NOT_FOUND', `Invalid workspace ID '${id}'.`);
    if (id === this.mainSession) return this.defaultService;
    if (this.lifecycleTransitions.has(id))
      throw new ToolError(
        'WORKSPACE_LIFECYCLE_BUSY',
        'A workspace lifecycle change is in progress.',
      );
    const existing = this.services.get(id);
    if (existing) return existing;
    const manifest = await this.readManifest(id);
    if (this.lifecycleTransitions.has(id))
      throw new ToolError(
        'WORKSPACE_LIFECYCLE_BUSY',
        'A workspace lifecycle change is in progress.',
      );
    if (manifest.workspaceStatus === 'archived')
      throw new ToolError(
        'WORKSPACE_ARCHIVED_HISTORY_ONLY',
        'Archived workspace metadata and historical artifacts remain available; restore it to open a live scene view.',
      );
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
    const manifest = await this.readManifest(id);
    return this.open(manifest);
  }

  private async open(manifest: WorkspaceManifest): Promise<ToolService> {
    const id = manifest.id;
    const dataDir = this.workspaceDir(id);
    const artifactsDir = path.join(dataDir, 'runs');
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
      assertWorkspaceWritable: () => this.assertWritable(id),
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
      workspaceId === this.mainSession
        ? path.join(this.defaultRoot, 'runs')
        : path.join(this.workspaceDir(workspaceId), 'runs');
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
