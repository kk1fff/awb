import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WorkspaceManager } from './server/workspaces.js';

const [command, ...args] = process.argv.slice(2);
const api = process.env.SCENE_API ?? 'http://127.0.0.1:3001';

function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function apiIsRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

function localManager(): WorkspaceManager {
  return new WorkspaceManager({
    dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
    artifactsDir: path.resolve(process.env.ARTIFACTS_DIR ?? 'artifacts/runs'),
    runId: `setup-${Date.now()}-${randomUUID().slice(0, 8)}`,
    clientUrl: process.env.CLIENT_URL ?? api,
  });
}

if (command === 'create') {
  const name = option('name');
  const goal = option('goal');
  if (!name || !goal?.trim()) {
    console.error(
      'Usage: npm run workspace -- create --name "Fir specialist" --goal "Build the fir submodel"',
    );
    process.exitCode = 2;
  } else {
    const input = {
      name,
      goal,
      owner: option('owner'),
      acceptanceCriteria: option('acceptance') ? [option('acceptance')!] : [],
    };
    let result: unknown;
    if (await apiIsRunning()) {
      const response = await fetch(`${api}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      result = await response.json();
      if (!response.ok) {
        console.error(JSON.stringify(result, null, 2));
        process.exitCode = 1;
      }
    } else {
      const manager = localManager();
      await manager.ensureStorage();
      const workspace = await manager.create(input);
      result = { workspace };
    }
    if (process.exitCode !== 1) {
      const workspace = (result as { workspace: { id: string } }).workspace;
      console.log(JSON.stringify(result, null, 2));
      console.log(
        `\nSet this for a dedicated MCP/scene CLI process:\nSCENE_WORKSPACE_ID=${workspace.id}`,
      );
    }
  }
} else if (command === 'list') {
  let result: unknown;
  if (await apiIsRunning()) {
    const response = await fetch(`${api}/api/workspaces`);
    result = await response.json();
    if (!response.ok) process.exitCode = 1;
  } else {
    const manager = localManager();
    await manager.ensureStorage();
    result = { workspaces: await manager.list() };
  }
  console.log(JSON.stringify(result, null, 2));
} else if (['archive', 'restore', 'purge'].includes(command ?? '')) {
  const id = option('id');
  if (!id) {
    console.error(
      `Usage: npm run workspace -- ${command} --id <workspace-uuid>${command === 'purge' ? ' --confirm <same-workspace-uuid>' : ''}`,
    );
    process.exitCode = 2;
  } else {
    let result: unknown;
    if (await apiIsRunning()) {
      const response = await fetch(
        `${api}/api/workspaces/${encodeURIComponent(id)}${command === 'archive' ? '/archive' : command === 'restore' ? '/restore' : ''}`,
        {
          method: command === 'purge' ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(command === 'purge'
            ? { body: JSON.stringify({ confirmWorkspaceId: option('confirm') ?? '' }) }
            : { body: '{}' }),
        },
      );
      result = await response.json();
      if (!response.ok) process.exitCode = 1;
    } else {
      const manager = localManager();
      await manager.ensureStorage();
      if (command === 'archive') result = { workspace: await manager.archive(id) };
      else if (command === 'restore') result = { workspace: await manager.restore(id) };
      else result = await manager.purge(id, option('confirm') ?? '');
    }
    console.log(JSON.stringify(result, null, 2));
  }
} else {
  console.log(
    'Usage: npm run workspace -- <create|list|archive|restore|purge> ...\nCreate requires --name and --goal. Lifecycle commands require --id; purge also requires --confirm <same-workspace-uuid>. Set SCENE_API to choose a live API; without one, the command uses DATA_DIR and ARTIFACTS_DIR directly.',
  );
  process.exitCode = command ? 2 : 0;
}
