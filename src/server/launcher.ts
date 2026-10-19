import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { ProjectStore } from './project.js';
import {
  installSessionCommand,
  refreshAgentConfig,
  refreshDesignerInstructions,
} from './agent-config.js';
import { runTerminalShell } from './tui.js';

const argv = process.argv.slice(2);
let workdirArg: string | undefined;
let noUi = false;
let concurrentLimit = 4;
let validArgs = true;
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index];
  if (arg === '--workdir' && !workdirArg) workdirArg = argv[++index];
  else if (arg === '--concurrent') {
    const value = argv[++index];
    if (!value || !/^[1-9]\d*$/.test(value)) validArgs = false;
    else concurrentLimit = Number(value);
  } else if (arg === '--no-ui' && !noUi) noUi = true;
  else validArgs = false;
}
if (
  !validArgs ||
  !workdirArg ||
  workdirArg.startsWith('--') ||
  !Number.isSafeInteger(concurrentLimit)
) {
  console.error(
    'Usage: start.sh --workdir <project-directory> [--concurrent <positive-integer>] [--no-ui]',
  );
  process.exit(2);
}
const workdir = path.resolve(workdirArg);
const appRoot =
  process.env.FIELDWORK_APP_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const store = await ProjectStore.initialize(workdir);
const info = await store.read();
const internal = path.join(workdir, '.fieldwork');
await mkdir(internal, { recursive: true });
const lockPath = path.join(internal, 'launcher.lock');
let lockHeld = false;
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }),
    );
    await handle.close();
    lockHeld = true;
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number; host: string };
      if (owner.host === hostname() && Number.isInteger(owner.pid)) {
        try {
          process.kill(owner.pid, 0);
        } catch (checkError) {
          stale = (checkError as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
    } catch {
      stale = false;
    }
    if (!stale)
      throw new Error(
        `Fieldwork is already running for '${workdir}' or its lock needs inspection.`,
      );
    await rm(lockPath);
  }
}
if (!lockHeld) throw new Error(`Could not lock '${workdir}'.`);

const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
const runtimePath = path.join(internal, 'runtime.json');
let server: Awaited<ReturnType<typeof createApp>> | undefined;
let listener: ReturnType<Awaited<ReturnType<typeof createApp>>['app']['listen']> | undefined;
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  if (listener) {
    const current = listener;
    const timeout = setTimeout(() => current.closeAllConnections(), 2000);
    await new Promise<void>((resolve) => current.close(() => resolve()));
    clearTimeout(timeout);
  }
  await rm(runtimePath, { force: true });
  if (lockHeld) await rm(lockPath, { force: true });
};
const signal = () => {
  void cleanup();
};
process.on('SIGTERM', signal);
process.on('SIGHUP', signal);
if (noUi) process.on('SIGINT', signal);

try {
  await rm(runtimePath, { force: true });
  process.chdir(appRoot);
  server = await createApp({
    dataDir: internal,
    artifactsDir: path.join(internal, 'runs'),
    runId,
    clientUrl: '',
    clientDir: path.join(appRoot, 'dist/client'),
    projectStore: store,
    concurrentLimit,
  });
  listener = server.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    listener!.once('listening', resolve);
    listener!.once('error', reject);
  });
  const port = (listener.address() as AddressInfo).port;
  const apiUrl = `http://127.0.0.1:${port}`;
  const browserUrl = `${apiUrl}/`;
  server.workspaces.setClientUrl(apiUrl);
  await installSessionCommand(workdir, appRoot);
  await refreshDesignerInstructions(workdir);
  await refreshAgentConfig(workdir, info.main_session, appRoot);
  for (const entry of await readdir(workdir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^session-[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const id = entry.name.slice('session-'.length);
    if (!(await stat(path.join(workdir, entry.name, 'workspace.json')).catch(() => null))?.isFile())
      continue;
    await refreshAgentConfig(workdir, id, appRoot, path.join(workdir, entry.name));
  }
  const temporary = `${runtimePath}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify(
      {
        projectId: info.project_id,
        runId,
        apiUrl,
        mainSession: info.main_session,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await rename(temporary, runtimePath);
  if (noUi) {
    console.log(`Fieldwork ${browserUrl}`);
    console.log('Press Ctrl-C to stop the server.');
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.once('SIGHUP', stop);
    });
  } else {
    const log = createWriteStream(path.join(internal, 'server.log'), { flags: 'a' });
    console.log = (...values) => {
      log.write(`${values.map(String).join(' ')}\n`);
    };
    console.error = (...values) => {
      log.write(`${values.map(String).join(' ')}\n`);
    };
    process.exitCode = await runTerminalShell({
      workdir,
      sessionId: info.main_session,
      apiUrl,
      browserUrl,
    });
    log.end();
  }
} finally {
  await cleanup();
}
