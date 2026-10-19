import express, { type ErrorRequestHandler, type Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { toolSchemas } from '../shared/schema.js';
import { ToolService, type ServiceOptions } from './service.js';
import { WorkspaceManager } from './workspaces.js';
import { ToolError } from '../engine/scene.js';
import { importSceneBundle } from './scene-bundle.js';
import type { ProjectStore } from './project.js';

async function registerServiceRoutes(router: Router, service: ToolService, workspaceId: string) {
  const scoped = workspaceId !== 'default';
  router.post(
    '/bundles/import',
    express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '250mb' }),
    async (req, res, next) => {
      try {
        if (service.recoveryError?.code === 'BUNDLE_IMPORT_RECOVERY_FAILED')
          throw new ToolError(
            'BUNDLE_IMPORT_RECOVERY_FAILED',
            `Bundle import recovery needs repair before another import can run: ${service.recoveryError.message}`,
          );
        if (!Buffer.isBuffer(req.body))
          throw new ToolError('INVALID_BUNDLE', 'Upload the bundle ZIP as application/zip.');
        const sceneName = req.header('x-scene-name')?.trim();
        if (!sceneName)
          throw new ToolError(
            'INVALID_SCENE_NAME',
            'Provide the target save name in X-Scene-Name.',
          );
        const result = await service.serialize(() =>
          service
            .assertWorkspaceWritable()
            .then(() => importSceneBundle(service, req.body as Buffer, sceneName)),
        );
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/assets/import',
    express.raw({ type: 'application/octet-stream', limit: '100mb' }),
    async (req, res, next) => {
      try {
        const decode = (value: string | undefined, label: string) => {
          if (!value) throw new ToolError('INVALID_ASSET_METADATA', `Missing ${label}.`);
          try {
            return decodeURIComponent(value);
          } catch {
            throw new ToolError('INVALID_ASSET_METADATA', `Invalid ${label} encoding.`);
          }
        };
        const tagsValue = decode(req.header('x-asset-tags'), 'asset tags');
        let tags: unknown;
        try {
          tags = JSON.parse(tagsValue);
        } catch {
          throw new ToolError('INVALID_ASSET_METADATA', 'Asset tags must be a JSON array.');
        }
        if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))
          throw new ToolError(
            'INVALID_ASSET_METADATA',
            'Asset tags must be a JSON array of strings.',
          );
        if (!Buffer.isBuffer(req.body))
          throw new ToolError('INVALID_ASSET_FILE', 'Upload a file as application/octet-stream.');
        const asset = await service.serialize(() =>
          service.assertWorkspaceWritable().then(() =>
            service.assets.importLocalAsset({
              name: decode(req.header('x-asset-name'), 'asset name'),
              fileName: decode(req.header('x-asset-file-name'), 'file name'),
              tags,
              data: req.body as Buffer,
            }),
          ),
        );
        res.status(201).json({ asset });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/health', (_req, res) =>
    res.json({
      ready: true,
      runId: service.options.runId,
      workspaceId,
      toolVersion: '2',
      ...(service.recoveryError ? { recoveryError: service.recoveryError } : {}),
    }),
  );
  router.get('/state', (_req, res) => res.json(service.engine.snapshot()));
  router.get('/assets/:id/file', async (req, res, next) => {
    try {
      const file = await service.assets.filePath(req.params.id);
      const extension = path.extname(file).toLowerCase();
      const type =
        extension === '.glb'
          ? 'model/gltf-binary'
          : extension === '.png'
            ? 'image/png'
            : ['.jpg', '.jpeg'].includes(extension)
              ? 'image/jpeg'
              : extension === '.webp'
                ? 'image/webp'
                : 'application/octet-stream';
      res.type(type).sendFile(file);
    } catch (error) {
      next(error);
    }
  });
  router.get('/assets/:id', async (req, res, next) => {
    try {
      res.json(await service.assets.get(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  router.get('/tools', (_req, res) =>
    res.json({
      toolVersion: '2',
      tools: Object.fromEntries(
        Object.entries(toolSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
      ),
    }),
  );
  router.get('/events', (_req, res) => res.json(service.events));
  router.get('/reviews', (_req, res) => res.json(service.reviews));
  router.get('/checkpoints', (_req, res) => res.json(service.checkpoints));
  router.get('/stream', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const unsubscribe = service.subscribe((message) => send(message.type, message));
    send('snapshot', {
      workspaceId,
      runId: service.options.runId,
      scene: service.engine.snapshot(),
      events: service.events,
      checkpoints: service.checkpoints,
      reviews: service.reviews,
    });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  router.get('/checkpoints/:id/scene', (req, res) => {
    const checkpoint = service.checkpoints.find((c) => c.id === req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: 'Checkpoint not found' });
      return;
    }
    res.sendFile(path.join(service.runDir, 'checkpoints', checkpoint.id, 'scene.json'));
  });
  router.post('/tools', async (req, res) => {
    const result = await service.execute(req.body);
    res
      .status(result.success ? 200 : result.error?.code === 'VALIDATION_ERROR' ? 400 : 422)
      .json(result);
  });
}

export async function createApp(
  options: ServiceOptions & { clientDir?: string; projectStore?: ProjectStore },
) {
  const projectInfo = options.projectStore ? await options.projectStore.read() : undefined;
  const manager = new WorkspaceManager({
    ...options,
    ...(projectInfo
      ? {
          projectRoot: options.projectStore!.root,
          mainSession: projectInfo.main_session,
          getProjectInfo: () => options.projectStore!.read(),
          updateProjectInfo: (patch) => options.projectStore!.update(patch),
        }
      : {}),
  });
  await manager.init();
  const service = manager.defaultService;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  if (!options.projectStore) app.get('/api/project', (_req, res) => res.json({ project: null }));
  if (options.projectStore && projectInfo) {
    app.get('/api/project', async (_req, res, next) => {
      try {
        res.json({ project: await options.projectStore!.read(), runId: options.runId });
      } catch (error) {
        next(error);
      }
    });
    app.patch('/api/project', async (req, res, next) => {
      try {
        const schema = z
          .object({
            expectedRevision: z.number().int().nonnegative(),
            goal: z.string().trim().max(2000).optional(),
            agentContext: z.record(z.string(), z.json()).optional(),
          })
          .strict()
          .refine((value) => value.goal !== undefined || value.agentContext !== undefined);
        res.json({ project: await options.projectStore!.update(schema.parse(req.body)) });
      } catch (error) {
        next(error);
      }
    });
  }

  app.get('/api/instructions', async (_req, res, next) => {
    try {
      const guide = await readFile(path.resolve(process.cwd(), 'docs/designer-agent-bootstrap.md'));
      res.type('text/markdown').send(guide);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/workspaces', async (_req, res, next) => {
    try {
      res.json({ workspaces: await manager.list() });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/workspaces/:workspaceId', async (req, res, next) => {
    try {
      res.json({ workspace: await manager.describe(String(req.params.workspaceId)) });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/workspaces/:workspaceId/context', async (req, res, next) => {
    try {
      res.json({ context: await manager.context(String(req.params.workspaceId)) });
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/workspaces/:workspaceId/context', async (req, res, next) => {
    try {
      const schema = z
        .object({
          goal: z.string().trim().min(1).max(2000).optional(),
          acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
          constraints: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
          currentTask: z.string().trim().max(2000).optional(),
          workStatus: z.enum(['planned', 'working', 'blocked', 'needs_review', 'done']).optional(),
          summary: z.string().trim().max(4000).optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0, 'Provide at least one context field.');
      res.json({
        context: await manager.updateContext(
          String(req.params.workspaceId),
          schema.parse(req.body),
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/workspaces', async (req, res, next) => {
    try {
      const schema = z
        .object({
          name: z.string().trim().min(1).max(100),
          owner: z.string().max(120).optional(),
          goal: z.string().trim().min(1).max(2000),
          acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
          constraints: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
        })
        .strict();
      const input = schema.parse(req.body);
      res.status(201).json({ workspace: await manager.create(input) });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/workspaces/:workspaceId/archive', async (req, res, next) => {
    try {
      res.json({ workspace: await manager.archive(String(req.params.workspaceId)) });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/workspaces/:workspaceId/restore', async (req, res, next) => {
    try {
      res.json({ workspace: await manager.restore(String(req.params.workspaceId)) });
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/workspaces/:workspaceId', async (req, res, next) => {
    try {
      const confirmation = z
        .object({ confirmWorkspaceId: z.string().uuid() })
        .strict()
        .parse(req.body);
      res.json(
        await manager.purge(String(req.params.workspaceId), confirmation.confirmWorkspaceId),
      );
    } catch (error) {
      next(error);
    }
  });
  const defaultRouter = express.Router();
  await registerServiceRoutes(defaultRouter, service, projectInfo?.main_session ?? 'default');
  app.use('/api', defaultRouter);
  app.use('/artifacts', express.static(service.runDir, { dotfiles: 'deny' }));

  const scopedRouter = express.Router({ mergeParams: true });
  scopedRouter.use(async (req, res, next) => {
    try {
      const id = req.params.workspaceId;
      if (!id || id === 'default') {
        res.status(404).json({ error: 'Use /api/* for the default workspace.' });
        return;
      }
      const descriptor = await manager.describe(String(id));
      if (descriptor.workspaceStatus === 'archived' && req.method !== 'GET') {
        res.status(409).json({
          error: {
            code: 'WORKSPACE_ARCHIVED',
            message: 'Restore the workspace before making changes.',
          },
        });
        return;
      }
      const target = await manager.getForBrowsing(String(id));
      res.locals.workspaceService = target;
      next();
    } catch (error) {
      next(error);
    }
  });
  // Register all ordinary API endpoints against the selected service.
  scopedRouter.use(async (req, res, next) => {
    try {
      const target = res.locals.workspaceService as ToolService;
      const handler = express.Router();
      await registerServiceRoutes(handler, target, target.options.workspaceId!);
      handler(req, res, next);
    } catch (error) {
      next(error);
    }
  });
  app.use('/api/workspaces/:workspaceId/artifacts/:runId', async (req, res, next) => {
    try {
      const dir = await manager.historicalRunDir(
        String(req.params.workspaceId),
        String(req.params.runId),
      );
      express.static(dir, { dotfiles: 'deny' })(req, res, next);
    } catch (error) {
      next(error);
    }
  });
  app.use('/api/workspaces/:workspaceId', scopedRouter);

  if (options.clientDir) {
    app.use(express.static(options.clientDir, { index: false }));
    app.get('/', (req, res) => {
      if (projectInfo && !req.query.workspace) {
        res.redirect(`/?workspace=${projectInfo.main_session}`);
        return;
      }
      res.sendFile(path.join(options.clientDir!, 'index.html'));
    });
  }
  const errors: ErrorRequestHandler = async (err, req, res, _next) => {
    if (req.path.endsWith('/bundles/import')) {
      const tooLarge =
        (err as { type?: string; status?: number }).type === 'entity.too.large' ||
        (err as { status?: number }).status === 413;
      const code = tooLarge
        ? 'BUNDLE_TOO_LARGE'
        : err instanceof ToolError
          ? err.code
          : err instanceof z.ZodError
            ? 'INVALID_BUNDLE'
            : 'INVALID_BUNDLE';
      res
        .status(
          tooLarge ? 413 : err instanceof ToolError && err.code.endsWith('_COLLISION') ? 409 : 400,
        )
        .json({
          error: {
            code,
            message: tooLarge
              ? 'Bundles must be 250 MiB or smaller.'
              : err instanceof Error
                ? err.message
                : String(err),
          },
        });
      return;
    }
    if (req.path.endsWith('/assets/import')) {
      const tooLarge =
        (err as { type?: string; status?: number }).type === 'entity.too.large' ||
        (err as { status?: number }).status === 413;
      const code = tooLarge
        ? 'ASSET_TOO_LARGE'
        : err instanceof ToolError
          ? err.code
          : err instanceof z.ZodError
            ? 'VALIDATION_ERROR'
            : 'INVALID_ASSET_FILE';
      const message = tooLarge
        ? 'Files must be 100 MiB or smaller.'
        : err instanceof Error
          ? err.message
          : String(err);
      res.status(tooLarge ? 413 : 400).json({ error: { code, message } });
      return;
    }
    const scopedPath = req.path.startsWith('/api/workspaces/');
    if (scopedPath) {
      const target = res.locals.workspaceService as ToolService | undefined;
      if (target) {
        const result = await target.execute(
          { tool: 'invalid_request', arguments: { message: String(err) } },
          new ToolError('INVALID_REQUEST', 'Request must be valid JSON and no larger than 1 MB.'),
        );
        res.status(400).json(result);
        return;
      }
      if (err instanceof ToolError) {
        res
          .status(err.code.endsWith('_NOT_FOUND') ? 404 : 400)
          .json({ error: { code: err.code, message: err.message } });
        return;
      }
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: err.issues } });
        return;
      }
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: String(err) } });
      return;
    }
    if (err instanceof ToolError) {
      res
        .status(err.code.endsWith('_NOT_FOUND') ? 404 : 400)
        .json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: err.issues } });
      return;
    }
    const result = await service.execute(
      { tool: 'invalid_request', arguments: { message: String(err) } },
      new ToolError('INVALID_REQUEST', 'Request must be valid JSON and no larger than 1 MB.'),
    );
    res.status(400).json(result);
  };
  app.use(errors);
  return { app, service, workspaces: manager };
}
