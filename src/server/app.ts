import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { z } from 'zod';
import { toolSchemas } from '../shared/schema.js';
import { ToolService, type ServiceOptions } from './service.js';
import { ToolError } from '../engine/scene.js';

export async function createApp(options: ServiceOptions & { clientDir?: string }) {
  const service = new ToolService(options);
  await service.init();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) =>
    res.json({ ready: true, runId: options.runId, toolVersion: '1' }),
  );
  app.get('/api/state', (_req, res) => res.json(service.engine.snapshot()));
  app.get('/api/tools', (_req, res) =>
    res.json({
      toolVersion: '1',
      tools: Object.fromEntries(
        Object.entries(toolSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
      ),
    }),
  );
  app.get('/api/events', (_req, res) => res.json(service.events));
  app.get('/api/reviews', (_req, res) => res.json(service.reviews));
  app.get('/api/checkpoints', (_req, res) => res.json(service.checkpoints));
  app.get('/api/checkpoints/:id/scene', (req, res) => {
    const checkpoint = service.checkpoints.find((c) => c.id === req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: 'Checkpoint not found' });
      return;
    }
    res.sendFile(path.join(service.runDir, 'checkpoints', checkpoint.id, 'scene.json'));
  });
  app.post('/api/tools', async (req, res) => {
    const result = await service.execute(req.body);
    res
      .status(result.success ? 200 : result.error?.code === 'VALIDATION_ERROR' ? 400 : 422)
      .json(result);
  });
  app.use('/artifacts', express.static(service.runDir, { dotfiles: 'deny' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));
  if (options.clientDir) {
    app.use(express.static(options.clientDir));
    app.get('/', (_req, res) => res.sendFile(path.join(options.clientDir!, 'index.html')));
  }
  const errors: ErrorRequestHandler = async (err, _req, res, _next) => {
    const result = await service.execute(
      { tool: 'invalid_request', arguments: { message: String(err) } },
      new ToolError('INVALID_REQUEST', 'Request must be valid JSON and no larger than 1 MB.'),
    );
    res.status(400).json(result);
  };
  app.use(errors);
  return { app, service };
}
