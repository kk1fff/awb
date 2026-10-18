import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { SceneEngine, ToolError } from '../engine/scene.js';
import {
  toolSchemas,
  type Checkpoint,
  type Review,
  type ToolEvent,
  type ToolName,
  type ToolResponse,
  type AssetRecord,
  type Scene,
  sceneSchema,
} from '../shared/schema.js';
import { capture, type Capture } from './capture.js';
import { exportScene } from './export.js';
import { AssetCatalog } from './asset-catalog.js';
import {
  createSceneBundle,
  recoverInterruptedBundleImports,
  SCENE_BUNDLE_MAX_FILES,
  SCENE_BUNDLE_MAX_UNCOMPRESSED_BYTES,
} from './scene-bundle.js';

export interface LiveMessage {
  type: 'tool-start' | 'update';
  executionId?: string;
  tool?: string;
  sceneRevision: number;
  event?: ToolEvent;
}

export interface ServiceOptions {
  dataDir: string;
  artifactsDir: string;
  runId: string;
  clientUrl: string;
  capture?: Capture;
  workspaceId?: string;
  promoteAsset?: (args: Record<string, unknown>) => Promise<unknown>;
  getWorkspaceContext?: () => Promise<unknown>;
  updateWorkspaceContext?: (patch: Record<string, unknown>) => Promise<unknown>;
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, file);
}
const envelope = z.object({ tool: z.string(), arguments: z.unknown() }).strict();
const sceneChangingTools = new Set<ToolName>([
  'create_object',
  'update_object',
  'delete_object',
  'set_camera',
  'set_lighting',
  'load_scene',
]);

interface RecoveryPointer {
  version: 1;
  executionId: string;
  previousExecutionId?: string;
}

interface RecoveryRecord {
  version: 1;
  executionId: string;
  previousExecutionId?: string;
  scene: Scene;
  event: ToolEvent;
}

export class ToolService {
  readonly engine = new SceneEngine();
  readonly events: ToolEvent[] = [];
  readonly checkpoints: Checkpoint[] = [];
  readonly reviews: Review[] = [];
  readonly assets: AssetCatalog;
  readonly runDir: string;
  private listeners = new Set<(message: LiveMessage) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private recoveryExecutionId?: string;
  private recoveryPreviousExecutionId?: string;
  recoveryError?: { code: string; message: string };
  private recoveredFrom?: { executionId: string; runId: string; sceneRevision: number };
  private pendingRecoveryProjection = false;
  constructor(readonly options: ServiceOptions) {
    if (!/^[a-zA-Z0-9][\w-]{0,99}$/.test(options.runId)) throw new Error('Invalid RUN_ID');
    this.runDir = path.resolve(options.artifactsDir, options.runId);
    this.assets = new AssetCatalog(options.dataDir);
  }
  async init(): Promise<void> {
    await mkdir(path.join(this.options.dataDir, 'scenes'), { recursive: true });
    try {
      await recoverInterruptedBundleImports(this.options.dataDir);
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== 'BUNDLE_IMPORT_RECOVERY_FAILED')
        throw error;
      this.recoveryError = { code: error.code, message: error.message };
    }
    try {
      await this.recoverCommittedScene();
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== 'RECOVERY_CORRUPT') throw error;
      this.recoveryError = { code: error.code, message: error.message };
    }
    await mkdir(path.dirname(this.runDir), { recursive: true });
    try {
      await mkdir(this.runDir);
    } catch (error) {
      throw new Error(
        `Cannot create run ${this.options.runId}; choose a new RUN_ID. ${String(error)}`,
      );
    }
    await mkdir(path.join(this.runDir, 'checkpoints'));
    await writeFile(path.join(this.runDir, 'events.jsonl'), '');
    await writeFile(path.join(this.runDir, 'reviews.jsonl'), '');
    await atomicJson(path.join(this.runDir, 'run.json'), {
      runId: this.options.runId,
      workspaceId: this.options.workspaceId ?? 'default',
      startedAt: new Date().toISOString(),
      recovery: this.recoveryError
        ? { status: 'error', ...this.recoveryError }
        : this.recoveredFrom
          ? { status: 'restored', ...this.recoveredFrom }
          : { status: 'none' },
    });
  }
  private get recoveryDir(): string {
    return path.join(this.options.dataDir, 'recovery');
  }
  private get recoverySnapshotsDir(): string {
    return path.join(this.recoveryDir, 'snapshots');
  }
  private get recoveryPointerPath(): string {
    return path.join(this.recoveryDir, 'current.json');
  }
  private recoverySnapshotPath(executionId: string): string {
    return path.join(this.recoverySnapshotsDir, `${executionId}.json`);
  }
  private async readRecoveryPointer(): Promise<RecoveryPointer | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.recoveryPointerPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError)
        throw new ToolError(
          'RECOVERY_CORRUPT',
          'The committed scene recovery pointer is not valid JSON.',
        );
      throw error;
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('executionId' in value) ||
      typeof value.executionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.executionId,
      )
    )
      throw new ToolError('RECOVERY_CORRUPT', 'The committed scene recovery pointer is invalid.');
    return value as RecoveryPointer;
  }
  private async readRecoveryRecord(pointer: RecoveryPointer): Promise<RecoveryRecord> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.recoverySnapshotPath(pointer.executionId), 'utf8'));
    } catch (error) {
      throw new ToolError(
        'RECOVERY_CORRUPT',
        `Cannot read committed scene snapshot '${pointer.executionId}': ${String(error)}`,
      );
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('executionId' in value) ||
      value.executionId !== pointer.executionId ||
      !('scene' in value) ||
      !('event' in value)
    )
      throw new ToolError('RECOVERY_CORRUPT', 'The committed scene recovery snapshot is invalid.');
    const scene = sceneSchema.safeParse(value.scene);
    const event = value.event as ToolEvent;
    if (
      !scene.success ||
      !event ||
      event.executionId !== pointer.executionId ||
      event.success !== true ||
      event.sceneRevision !== scene.data.revision ||
      !sceneChangingTools.has(event.tool as ToolName) ||
      !/^[a-zA-Z0-9][\w-]{0,99}$/.test(event.runId) ||
      (this.options.workspaceId &&
        event.workspaceId !== undefined &&
        event.workspaceId !== this.options.workspaceId)
    )
      throw new ToolError(
        'RECOVERY_CORRUPT',
        'The committed scene recovery record failed validation.',
      );
    return {
      version: 1,
      executionId: pointer.executionId,
      scene: scene.data,
      event,
    };
  }
  private async ensureCommittedEvent(record: RecoveryRecord): Promise<void> {
    const runDir = path.resolve(this.options.artifactsDir, record.event.runId);
    if (path.dirname(runDir) !== path.resolve(this.options.artifactsDir))
      throw new ToolError(
        'RECOVERY_CORRUPT',
        'The committed scene event points outside run storage.',
      );
    await mkdir(runDir, { recursive: true });
    const eventPath = path.join(runDir, 'events.jsonl');
    const content = await readFile(eventPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    let normalizedContent = content;
    if (content && !content.endsWith('\n')) {
      const lastLine = content.slice(content.lastIndexOf('\n') + 1);
      try {
        JSON.parse(lastLine);
        normalizedContent = `${content}\n`;
      } catch {
        normalizedContent = content.slice(0, content.lastIndexOf('\n') + 1);
      }
      const temporary = `${eventPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, normalizedContent);
      await rename(temporary, eventPath);
    }
    const alreadyRecorded = normalizedContent.split('\n').some((line) => {
      if (!line) return false;
      try {
        return (JSON.parse(line) as { executionId?: string }).executionId === record.executionId;
      } catch {
        return false;
      }
    });
    if (!alreadyRecorded) await appendFile(eventPath, `${JSON.stringify(record.event)}\n`);
  }
  private async pruneRecoverySnapshots(
    keepExecutionIds: Array<string | undefined> = [],
  ): Promise<void> {
    const keep = new Set(keepExecutionIds.filter((id): id is string => Boolean(id)));
    for (const entry of await readdir(this.recoverySnapshotsDir, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (entry.isFile() && entry.name.endsWith('.json') && !keep.has(entry.name.slice(0, -5)))
        await rm(path.join(this.recoverySnapshotsDir, entry.name), { force: true });
    }
  }
  private async recoverCommittedScene(): Promise<void> {
    await mkdir(this.recoverySnapshotsDir, { recursive: true });
    const pointer = await this.readRecoveryPointer();
    if (!pointer) {
      const snapshots = (await readdir(this.recoverySnapshotsDir)).filter((file) =>
        file.endsWith('.json'),
      );
      if (snapshots.length)
        throw new ToolError(
          'RECOVERY_CORRUPT',
          'Scene recovery snapshots exist, but the committed scene recovery pointer is missing.',
        );
      return;
    }
    const record = await this.readRecoveryRecord(pointer);
    this.engine.restore(record.scene);
    this.recoveryExecutionId = pointer.executionId;
    this.recoveryPreviousExecutionId = pointer.previousExecutionId;
    this.recoveredFrom = {
      executionId: pointer.executionId,
      runId: record.event.runId,
      sceneRevision: record.scene.revision,
    };
    await this.ensureCommittedEvent(record);
    await this.pruneRecoverySnapshots([pointer.executionId, pointer.previousExecutionId]);
  }
  private async reconcilePendingRecovery(): Promise<void> {
    if (!this.pendingRecoveryProjection || !this.recoveryExecutionId) return;
    const pointer = await this.readRecoveryPointer();
    if (!pointer || pointer.executionId !== this.recoveryExecutionId)
      throw new ToolError('RECOVERY_CORRUPT', 'The committed scene pointer changed unexpectedly.');
    const record = await this.readRecoveryRecord(pointer);
    await this.ensureCommittedEvent(record);
    await this.pruneRecoverySnapshots([pointer.executionId, pointer.previousExecutionId]);
    this.pendingRecoveryProjection = false;
  }
  private async commitScene(event: ToolEvent): Promise<void> {
    const scene = this.engine.snapshot();
    const previousExecutionId = this.recoveryExecutionId;
    const record: RecoveryRecord = {
      version: 1,
      executionId: event.executionId,
      ...(previousExecutionId ? { previousExecutionId } : {}),
      scene,
      event,
    };
    await mkdir(this.recoverySnapshotsDir, { recursive: true });
    await atomicJson(this.recoverySnapshotPath(event.executionId), record);
    await atomicJson(this.recoveryPointerPath, {
      version: 1,
      executionId: event.executionId,
      ...(previousExecutionId ? { previousExecutionId } : {}),
    } satisfies RecoveryPointer);
    this.recoveryPreviousExecutionId = previousExecutionId;
    this.recoveryExecutionId = event.executionId;
  }
  subscribe(listener: (message: LiveMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(message: LiveMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error('Cannot notify a live workspace client', error);
      }
    }
  }
  execute(input: unknown, rejection?: ToolError): Promise<ToolResponse> {
    const next = this.queue.then(() => this.run(input, rejection));
    this.queue = next.catch(() => undefined);
    return next;
  }
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async run(input: unknown, rejection?: ToolError): Promise<ToolResponse> {
    const executionId = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      await this.reconcilePendingRecovery();
    } catch (error) {
      return {
        success: false,
        executionId,
        sceneRevision: this.engine.snapshot().revision,
        error: {
          code: error instanceof ToolError ? error.code : 'RECOVERY_WRITE_FAILED',
          message: `Cannot reconcile the last committed scene operation before processing this command: ${String(error)}`,
        },
      };
    }
    const previous = this.engine.snapshot();
    let tool = 'invalid_request';
    let args: unknown = input;
    let response: ToolResponse;
    let dispatchedResult: unknown;
    try {
      const request = envelope.parse(input);
      tool = request.tool;
      args = request.arguments;
      if (rejection) throw rejection;
      if (
        this.recoveryError &&
        [
          'create_object',
          'update_object',
          'delete_object',
          'set_camera',
          'set_lighting',
          'load_scene',
          'save_scene',
          'render_scene',
          'export_scene',
          'export_scene_bundle',
        ].includes(tool)
      )
        throw new ToolError(
          'RECOVERY_UNAVAILABLE',
          `Scene recovery needs repair before '${tool}' can run: ${this.recoveryError.message}`,
        );
      if (!Object.hasOwn(toolSchemas, tool))
        throw new ToolError(
          'UNKNOWN_TOOL',
          `Unknown tool '${tool}'. Fetch GET /api/tools for supported operations.`,
        );
      const validated = toolSchemas[tool as ToolName].parse(args) as Record<string, unknown>;
      this.publish({
        type: 'tool-start',
        executionId,
        tool,
        sceneRevision: this.engine.snapshot().revision,
      });
      const result = await this.dispatch(tool as ToolName, validated, executionId, timestamp);
      dispatchedResult = result;
      response = {
        success: true,
        executionId,
        sceneRevision: this.engine.snapshot().revision,
        result,
        ...(this.options.getWorkspaceContext
          ? {
              metadataRevision: (
                (await this.options.getWorkspaceContext()) as { metadataRevision?: number }
              ).metadataRevision,
            }
          : {}),
      };
    } catch (error) {
      this.engine.restore(previous);
      const code =
        error instanceof z.ZodError
          ? 'VALIDATION_ERROR'
          : error instanceof ToolError
            ? error.code
            : 'IO_ERROR';
      response = {
        success: false,
        executionId,
        sceneRevision: previous.revision,
        error: {
          code,
          message:
            error instanceof z.ZodError
              ? 'Invalid arguments; inspect details and GET /api/tools.'
              : error instanceof Error
                ? error.message
                : String(error),
          ...(error instanceof z.ZodError
            ? { details: error.issues }
            : error instanceof ToolError && error.details
              ? { details: error.details }
              : {}),
        },
      };
    }
    if (this.options.getWorkspaceContext && response.metadataRevision === undefined) {
      try {
        response.metadataRevision = (
          (await this.options.getWorkspaceContext()) as { metadataRevision?: number }
        ).metadataRevision;
      } catch {
        // Keep command responses available if optional metadata cannot be read.
      }
    }
    let event: ToolEvent = {
      ...response,
      timestamp,
      tool,
      arguments: args,
      runId: this.options.runId,
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
    };
    let sceneCommit = false;
    if (response.success && sceneChangingTools.has(tool as ToolName)) {
      try {
        await this.commitScene(event);
        sceneCommit = true;
      } catch (error) {
        this.engine.restore(previous);
        await this.pruneRecoverySnapshots([
          this.recoveryExecutionId,
          this.recoveryPreviousExecutionId,
        ]).catch((pruneError) =>
          console.error('Cannot prune uncommitted scene recovery snapshots', pruneError),
        );
        response = {
          success: false,
          executionId,
          sceneRevision: previous.revision,
          error: {
            code: 'RECOVERY_WRITE_FAILED',
            message: `Cannot commit scene recovery state; the scene change was rolled back: ${String(error)}`,
          },
          ...(response.metadataRevision !== undefined
            ? { metadataRevision: response.metadataRevision }
            : {}),
        };
        event = {
          ...response,
          timestamp,
          tool,
          arguments: args,
          runId: this.options.runId,
          ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
        };
      }
    }
    try {
      await appendFile(path.join(this.runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
      this.events.push(event);
      if (sceneCommit) {
        this.pendingRecoveryProjection = false;
        await this.pruneRecoverySnapshots([
          event.executionId,
          this.recoveryPreviousExecutionId,
        ]).catch((error) => console.error('Cannot prune old scene recovery snapshots', error));
      }
    } catch (error) {
      if (sceneCommit) {
        // The pointer and snapshot are the commit point. Keep the accepted scene and repair the
        // append-only event projection before another operation or during the next startup.
        this.events.push(event);
        this.pendingRecoveryProjection = true;
        console.error('Cannot project committed scene event; it will be reconciled', error);
        this.publish({ type: 'update', executionId, sceneRevision: response.sceneRevision });
        return response;
      }
      this.engine.restore(previous);
      if (tool === 'promote_asset') {
        const promoted = dispatchedResult as { asset?: { id?: string } } | undefined;
        if (promoted?.asset?.id) {
          try {
            await this.assets.removeLocalAsset(promoted.asset.id);
          } catch (rollbackError) {
            console.error('Cannot roll back unrecorded asset promotion', rollbackError);
          }
        }
      }
      console.error('Cannot record execution event', error);
      this.publish({ type: 'update', executionId, sceneRevision: previous.revision });
      return {
        success: false,
        executionId,
        sceneRevision: previous.revision,
        error: {
          code: 'HISTORY_WRITE_FAILED',
          message:
            'Cannot persist execution history. Scene mutation was rolled back; check storage.',
        },
      };
    }
    this.publish({ type: 'update', executionId, sceneRevision: response.sceneRevision });
    return response;
  }
  private async dispatch(
    tool: ToolName,
    args: Record<string, unknown>,
    executionId: string,
    timestamp: string,
  ): Promise<unknown> {
    if (tool === 'promote_asset') {
      if (!this.options.promoteAsset)
        throw new ToolError(
          'PROMOTION_UNAVAILABLE',
          'Asset promotion is unavailable in this workspace.',
        );
      return this.options.promoteAsset(args);
    }
    if (tool === 'get_workspace_context') {
      if (!this.options.getWorkspaceContext)
        throw new ToolError('WORKSPACE_CONTEXT_UNAVAILABLE', 'Workspace context is unavailable.');
      return this.options.getWorkspaceContext();
    }
    if (tool === 'update_workspace_context') {
      if (!this.options.updateWorkspaceContext)
        throw new ToolError(
          'WORKSPACE_CONTEXT_UNAVAILABLE',
          'Workspace context cannot be updated.',
        );
      return this.options.updateWorkspaceContext(args);
    }
    if (tool === 'search_assets')
      return this.assets.search(
        args.query as string,
        args.kind as 'model' | 'material' | 'environment' | undefined,
        args.limit as number,
      );
    let commandArgs = args;
    if (tool === 'create_object') {
      if (args.type === 'asset') {
        const asset = await this.assets.get(args.assetId as string, 'model');
        if (!asset.bounds)
          throw new ToolError('INVALID_ASSET_CATALOG', `Model ${asset.id} has no bounds.`);
        if (asset.source === 'local') await this.assets.filePath(asset.id);
        commandArgs = {
          ...args,
          dimensions: args.dimensions ?? asset.bounds,
          assetBounds: asset.bounds,
        };
      }
      if (args.materialId) {
        const material = await this.assets.get(args.materialId as string, 'material');
        if (material.source === 'local') await this.assets.filePath(material.id);
      }
    }
    if (tool === 'update_object' && args.materialId) {
      const material = await this.assets.get(args.materialId as string, 'material');
      if (material.source === 'local') await this.assets.filePath(material.id);
    }
    if (tool === 'set_lighting' && args.environmentAssetId) {
      const environment = await this.assets.get(args.environmentAssetId as string, 'environment');
      if (environment.source === 'local') await this.assets.filePath(environment.id);
    }
    if (tool === 'save_scene') {
      const scene = this.engine.snapshot();
      const name = args.name as string;
      const file = path.resolve(this.options.dataDir, 'scenes', `${name}.json`);
      // Keep scene JSON directly loadable, with provenance alongside it.
      await atomicJson(file, scene);
      await atomicJson(path.join(this.runDir, 'scene.json'), scene);
      await atomicJson(path.join(this.runDir, `save-${executionId}.json`), {
        name,
        executionId,
        sceneRevision: scene.revision,
        timestamp,
        scene,
      });
      return { name, path: file, executionId, sceneRevision: scene.revision };
    }
    if (tool === 'load_scene') {
      const file = path.resolve(this.options.dataDir, 'scenes', `${String(args.name)}.json`);
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
          throw new ToolError(
            'SAVE_NOT_FOUND',
            `No save named '${String(args.name)}'. Create it with save_scene first.`,
          );
        throw e;
      }
      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch {
        throw new ToolError('INVALID_SCENE', 'Saved scene contains invalid JSON');
      }
      const next = value as {
        objects?: Array<{ type?: string; assetId?: string; materialId?: string }>;
        lighting?: { environmentAssetId?: string };
      };
      for (const object of next.objects ?? []) {
        if (object.type === 'asset' && object.assetId) {
          const asset = await this.assets.get(object.assetId, 'model');
          if (asset.source === 'local') await this.assets.filePath(asset.id);
        }
        if (object.materialId) {
          const material = await this.assets.get(object.materialId, 'material');
          if (material.source === 'local') await this.assets.filePath(material.id);
        }
      }
      if (next.lighting?.environmentAssetId) {
        const environment = await this.assets.get(next.lighting.environmentAssetId, 'environment');
        if (environment.source === 'local') await this.assets.filePath(environment.id);
      }
      return this.engine.load(value);
    }
    if (tool === 'render_scene')
      return this.render(args.label as string | undefined, executionId, timestamp);
    if (tool === 'export_scene') {
      const clientUrl =
        this.options.workspaceId && this.options.workspaceId !== 'default'
          ? `${this.options.clientUrl}/?workspace=${encodeURIComponent(this.options.workspaceId)}`
          : this.options.clientUrl;
      const result = await exportScene(this.engine.snapshot(), this.runDir, executionId, clientUrl);
      if (this.options.workspaceId && this.options.workspaceId !== 'default')
        result.artifactUrl = `/api/workspaces/${this.options.workspaceId}/artifacts/${this.options.runId}/exports/${result.fileName}`;
      return result;
    }
    if (tool === 'export_scene_bundle') {
      const scene = this.engine.snapshot();
      const checkpoint = await this.render(
        `Scene bundle revision ${scene.revision}`,
        executionId,
        timestamp,
      );
      if (!checkpoint.screenshotPath)
        throw new ToolError('RENDER_FAILED', 'Bundle preview was not written to disk.');
      const clientUrl =
        this.options.workspaceId && this.options.workspaceId !== 'default'
          ? `${this.options.clientUrl}/?workspace=${encodeURIComponent(this.options.workspaceId)}`
          : this.options.clientUrl;
      const glb = await exportScene(scene, this.runDir, executionId, clientUrl);
      const glbBytes = await readFile(path.join(this.runDir, 'exports', glb.fileName));
      const previewBytes = await readFile(checkpoint.screenshotPath);
      const referencedIds = new Set<string>();
      for (const object of scene.objects) {
        if (object.assetId) referencedIds.add(object.assetId);
        if (object.materialId) referencedIds.add(object.materialId);
      }
      if (scene.lighting.environmentAssetId) referencedIds.add(scene.lighting.environmentAssetId);
      if (referencedIds.size + 4 > SCENE_BUNDLE_MAX_FILES)
        throw new ToolError(
          'BUNDLE_TOO_LARGE',
          'Scene references too many catalog assets for a bundle.',
        );
      let payloadBytes =
        Buffer.byteLength(JSON.stringify(scene)) + glbBytes.length + previewBytes.length;
      const assets: Array<{ record: AssetRecord; data?: Buffer }> = [];
      for (const id of referencedIds) {
        const record = await this.assets.get(id);
        if (record.source !== 'local') {
          assets.push({ record });
          continue;
        }
        const assetPath = await this.assets.filePath(id);
        const details = await stat(assetPath);
        payloadBytes += details.size;
        if (payloadBytes > SCENE_BUNDLE_MAX_UNCOMPRESSED_BYTES)
          throw new ToolError(
            'BUNDLE_TOO_LARGE',
            'Scene bundle exceeds the uncompressed size limit.',
          );
        assets.push({ record, data: await readFile(assetPath) });
      }
      const created = await createSceneBundle({
        scene,
        preview: previewBytes,
        glb: glbBytes,
        assets,
        workspaceId: this.options.workspaceId ?? 'default',
        runId: this.options.runId,
        executionId,
        workspaceContext: this.options.getWorkspaceContext
          ? await this.options.getWorkspaceContext().then((context) => {
              const value = context as { goal?: string; currentTask?: string };
              return { goal: value.goal ?? '', currentTask: value.currentTask ?? '' };
            })
          : undefined,
      });
      const fileName = `scene-bundle-${executionId}.zip`;
      const directory = path.join(this.runDir, 'bundles');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, fileName), created.data, { flag: 'wx' });
      const artifactUrl =
        this.options.workspaceId && this.options.workspaceId !== 'default'
          ? `/api/workspaces/${this.options.workspaceId}/artifacts/${this.options.runId}/bundles/${fileName}`
          : `/artifacts/bundles/${fileName}`;
      return {
        format: 'fieldwork-scene-bundle',
        bundleId: created.manifest.bundleId,
        fileName,
        artifactUrl,
        sceneRevision: scene.revision,
        previewCheckpointId: checkpoint.id,
        previewSceneRevision: checkpoint.sceneRevision,
        glbSceneRevision: glb.sceneRevision,
        bytes: created.data.length,
        assetCount: created.manifest.referencedAssets.length,
      };
    }
    if (tool === 'record_review') {
      const review = {
        ...args,
        executionId,
        timestamp,
        sceneRevision: this.engine.snapshot().revision,
      } as Review;
      if (review.checkpointId && !this.checkpoints.some((c) => c.id === review.checkpointId))
        throw new ToolError(
          'CHECKPOINT_NOT_FOUND',
          'Use GET /api/checkpoints to find a checkpoint in this run.',
        );
      const checkpoint = this.checkpoints.find((c) => c.id === review.checkpointId);
      if (checkpoint) review.sceneRevision = checkpoint.sceneRevision;
      if (review.kind === 'approval' && checkpoint?.status !== 'complete')
        throw new ToolError(
          'CHECKPOINT_INCOMPLETE',
          'Only a successfully rendered checkpoint can be approved.',
        );
      for (const id of review.executionIds)
        if (!this.events.some((e) => e.executionId === id))
          throw new ToolError('EXECUTION_NOT_FOUND', `No execution ${id} in this run.`);
      await appendFile(path.join(this.runDir, 'reviews.jsonl'), `${JSON.stringify(review)}\n`);
      this.reviews.push(review);
      const notes = this.reviews
        .map(
          (r) =>
            `## ${r.kind} · ${r.author}\n\n${r.text}\n\nCheckpoint: ${r.checkpointId ?? '—'}\nExecution: ${r.executionId}\nEvidence: ${r.executionIds.join(', ')}\n`,
        )
        .join('\n');
      await writeFile(
        path.join(this.runDir, 'review.md'),
        `# Run ${this.options.runId}\n\n${notes}`,
      );
      const issues = this.reviews
        .filter((r) => r.kind === 'tool_issue')
        .map(
          (r) =>
            `## Issue\n\nTask / Problem:\n${r.text}\n\nSuggested Improvement:\n${r.suggestion}\n\nImpact:\n${r.impact}\n\nEvidence:\n${r.executionIds.join(', ')}\n`,
        )
        .join('\n');
      await writeFile(
        path.join(this.runDir, 'tool-feedback.md'),
        `# Tool feedback\n\nRun: ${this.options.runId}\n\n${issues}`,
      );
      return review;
    }
    return this.engine.execute(tool, commandArgs);
  }
  private async render(
    label: string | undefined,
    executionId: string,
    timestamp: string,
  ): Promise<Checkpoint> {
    const id = randomUUID();
    const scene = this.engine.snapshot();
    const dir = path.join(this.runDir, 'checkpoints', id);
    await mkdir(dir);
    const checkpoint: Checkpoint = {
      id,
      label: label ?? `Revision ${scene.revision}`,
      executionId,
      timestamp,
      sceneRevision: scene.revision,
      status: 'rendering',
      sceneUrl:
        this.options.workspaceId && this.options.workspaceId !== 'default'
          ? `/api/workspaces/${this.options.workspaceId}/checkpoints/${id}/scene`
          : `/api/checkpoints/${id}/scene`,
    };
    await atomicJson(path.join(dir, 'scene.json'), scene);
    this.checkpoints.push(checkpoint);
    await atomicJson(path.join(dir, 'checkpoint.json'), checkpoint);
    try {
      const output = path.join(dir, 'scene.png');
      await (this.options.capture ?? capture)(
        `${this.options.clientUrl}/?${this.options.workspaceId && this.options.workspaceId !== 'default' ? `workspace=${this.options.workspaceId}&` : ''}checkpoint=${id}`,
        output,
      );
      Object.assign(checkpoint, {
        status: 'complete',
        screenshotPath: output,
        screenshotUrl:
          this.options.workspaceId && this.options.workspaceId !== 'default'
            ? `/api/workspaces/${this.options.workspaceId}/artifacts/${this.options.runId}/checkpoints/${id}/scene.png`
            : `/artifacts/checkpoints/${id}/scene.png`,
      });
      await atomicJson(path.join(dir, 'checkpoint.json'), checkpoint);
      return structuredClone(checkpoint);
    } catch (error) {
      checkpoint.status = 'failed';
      checkpoint.error = String(error);
      delete checkpoint.screenshotPath;
      delete checkpoint.screenshotUrl;
      await atomicJson(path.join(dir, 'checkpoint.json'), checkpoint);
      throw new ToolError(
        'RENDER_FAILED',
        'Screenshot capture failed. Check renderer/browser diagnostics and retry.',
        { checkpointId: id, diagnostics: checkpoint.error },
      );
    }
  }
}
