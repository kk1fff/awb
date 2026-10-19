import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from './project.js';
import { refreshAgentConfig } from './agent-config.js';

const root = process.env.FIELDWORK_WORKDIR;
if (!root) throw new Error('FIELDWORK_WORKDIR is required.');
const store = new ProjectStore(root);
const info = await store.read();
const runtime = JSON.parse(await readFile(path.join(root, '.fieldwork/runtime.json'), 'utf8')) as {
  projectId: string;
  apiUrl: string;
  runId: string;
};
if (runtime.projectId !== info.project_id)
  throw new Error('Fieldwork runtime belongs to another project.');
const health = await fetch(`${runtime.apiUrl}/api/project`, { signal: AbortSignal.timeout(3000) });
const active = (await health.json()) as { project: { project_id: string }; runId: string };
if (!health.ok || active.project.project_id !== info.project_id || active.runId !== runtime.runId)
  throw new Error('Fieldwork runtime is stale or unavailable.');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const [group, action, ...args] = process.argv.slice(2);
if (group !== 'session' || !['shell', 'create'].includes(action ?? '')) {
  console.log(
    'Usage: fieldwork session shell <uuid> | fieldwork session create --name <name> --goal <goal>',
  );
  process.exitCode = 2;
} else if (action === 'create') {
  const option = (name: string) => args[args.indexOf(`--${name}`) + 1];
  const name = option('name');
  const goal = option('goal');
  if (!name || !goal) throw new Error('Session creation requires --name and --goal.');
  const response = await fetch(`${runtime.apiUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, goal }),
  });
  const result = (await response.json()) as { workspace?: { id: string }; error?: unknown };
  if (!response.ok || !result.workspace) throw new Error(JSON.stringify(result.error));
  await refreshAgentConfig(
    root,
    result.workspace.id,
    appRoot,
    path.join(root, `session-${result.workspace.id}`),
  );
  console.log(`Created session ${result.workspace.id}`);
  console.log(`Enter it with: fieldwork session shell ${result.workspace.id}`);
} else {
  const id = args[0];
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('A session UUID is required.');
  const sessionDir = path.join(root, `session-${id}`);
  if (!(await stat(sessionDir).catch(() => null))?.isDirectory())
    throw new Error(`Unknown session ${id}.`);
  const descriptor = await fetch(`${runtime.apiUrl}/api/workspaces/${id}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!descriptor.ok) throw new Error(`Session ${id} is unavailable.`);
  await refreshAgentConfig(root, id, appRoot, sessionDir);
  const shell = process.env.SHELL || '/bin/bash';
  const child = spawn(shell, ['-i'], {
    cwd: sessionDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      FIELDWORK_SESSION_ID: id,
      SCENE_WORKSPACE_ID: id,
      SCENE_API: runtime.apiUrl,
      PATH: `${path.join(root, '.fieldwork/bin')}:${process.env.PATH ?? ''}`,
    },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  process.exitCode = code;
}
