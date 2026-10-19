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
const post = async (route: string, body: unknown) => {
  const response = await fetch(`${runtime.apiUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, any>;
  if (!response.ok) throw new Error(result.error?.message ?? JSON.stringify(result));
  return result;
};
if (
  group !== 'session' ||
  !['shell', 'create', 'complete', 'confirm', 'abort', 'status'].includes(action ?? '')
) {
  console.log(
    'Usage: fieldwork session create --name <name> --goal <goal> [--reservation <uuid>] | shell <uuid> | complete <uuid> --summary <text> | confirm <uuid> | abort <reservation-uuid> --reason <text> | status',
  );
  process.exitCode = 2;
} else if (action === 'status') {
  const response = await fetch(`${runtime.apiUrl}/api/designers`);
  console.log(JSON.stringify(await response.json(), null, 2));
} else if (action === 'create') {
  const option = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index < 0 ? undefined : args[index + 1];
  };
  const name = option('name');
  const goal = option('goal');
  if (!name || !goal) throw new Error('Session creation requires --name and --goal.');
  let reservationId = option('reservation');
  const automatic = !reservationId;
  if (!reservationId)
    reservationId = (await post('/api/designers/reservations', { task: goal })).reservation
      .reservationId;
  try {
    const sessionId = (
      await post(`/api/designers/reservations/${reservationId}/open`, { name, goal })
    ).reservation.sessionId;
    await refreshAgentConfig(root, sessionId, appRoot, path.join(root, `session-${sessionId}`));
    console.log(`Created session ${sessionId} using reservation ${reservationId}`);
    console.log(`Enter it with: fieldwork session shell ${sessionId}`);
  } catch (error) {
    if (automatic)
      await post(`/api/designers/reservations/${reservationId}/abort`, {
        reason: 'Session creation failed.',
      });
    throw error;
  }
} else if (action === 'complete' || action === 'confirm' || action === 'abort') {
  const id = args[0];
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('A session UUID is required.');
  const result =
    action === 'complete'
      ? await post(`/api/designers/sessions/${id}/complete`, {
          summary: args[args.indexOf('--summary') + 1],
        })
      : action === 'abort'
        ? await post(`/api/designers/reservations/${id}/abort`, {
            reason: args[args.indexOf('--reason') + 1],
          })
        : await post(`/api/designers/sessions/${id}/confirm`, {});
  console.log(JSON.stringify(result, null, 2));
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
  let resumedReservationId: string | undefined;
  if (id !== info.main_session) {
    const status = (await fetch(`${runtime.apiUrl}/api/designers`).then((response) =>
      response.json(),
    )) as {
      reservations: { sessionId?: string; state: string }[];
    };
    if (!status.reservations.some((entry) => entry.sessionId === id && entry.state === 'active')) {
      const existing = (await descriptor.json()) as { workspace: { name: string; goal: string } };
      const reservationId = (
        await post('/api/designers/reservations', { task: `Continue ${existing.workspace.name}` })
      ).reservation.reservationId;
      resumedReservationId = reservationId;
      try {
        await post(`/api/designers/reservations/${reservationId}/open`, {
          name: existing.workspace.name,
          goal: existing.workspace.goal,
          existingSessionId: id,
        });
      } catch (error) {
        await post(`/api/designers/reservations/${reservationId}/abort`, {
          reason: 'Could not continue the session.',
        });
        throw error;
      }
      console.log(
        `Reserved slot ${reservationId} to continue session ${id}. Complete and confirm it to free capacity.`,
      );
    }
  }
  try {
    await refreshAgentConfig(root, id, appRoot, sessionDir);
  } catch (error) {
    if (resumedReservationId)
      await post(`/api/designers/reservations/${resumedReservationId}/abort`, {
        reason: 'Could not prepare session configuration.',
      });
    throw error;
  }
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
