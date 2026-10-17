import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);
const production = process.env.NODE_ENV === 'production';
const runId =
  process.env.RUN_ID ??
  `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const { app } = await createApp({
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  artifactsDir: path.resolve(process.env.ARTIFACTS_DIR ?? 'artifacts/runs'),
  runId,
  clientUrl:
    process.env.CLIENT_URL ??
    `http://127.0.0.1:${production ? port : (process.env.VITE_PORT ?? 5173)}`,
  clientDir: production ? path.resolve('dist/client') : undefined,
});
const server = app.listen(port, '127.0.0.1', () =>
  console.log(`Scene API http://127.0.0.1:${port} · run ${runId}`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
