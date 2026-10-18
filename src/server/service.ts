import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
} from '../shared/schema.js';
import { capture, type Capture } from './capture.js';
import { exportScene } from './export.js';
import { AssetCatalog } from './asset-catalog.js';

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

export class ToolService {
  readonly engine = new SceneEngine();
  readonly events: ToolEvent[] = [];
  readonly checkpoints: Checkpoint[] = [];
  readonly reviews: Review[] = [];
  readonly assets: AssetCatalog;
  readonly runDir: string;
  private listeners = new Set<(message: LiveMessage) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly options: ServiceOptions) {
    if (!/^[a-zA-Z0-9][\w-]{0,99}$/.test(options.runId)) throw new Error('Invalid RUN_ID');
    this.runDir = path.resolve(options.artifactsDir, options.runId);
    this.assets = new AssetCatalog(options.dataDir);
  }
  async init(): Promise<void> {
    await mkdir(path.join(this.options.dataDir, 'scenes'), { recursive: true });
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
  private async run(input: unknown, rejection?: ToolError): Promise<ToolResponse> {
    const executionId = randomUUID();
    const timestamp = new Date().toISOString();
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
    const event: ToolEvent = {
      ...response,
      timestamp,
      tool,
      arguments: args,
      runId: this.options.runId,
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
    };
    try {
      await appendFile(path.join(this.runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
      this.events.push(event);
    } catch (error) {
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
