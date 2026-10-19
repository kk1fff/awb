import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProjectStore } from '../src/server/project.js';
import { createApp } from '../src/server/app.js';
import { refreshAgentConfig } from '../src/server/agent-config.js';

describe('workdir projects', () => {
  let root = '';
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('initializes only a new folder, validates ownership, and preserves unrelated agent settings', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-project-parent-'));
    const workdir = path.join(root, 'new-project');
    const store = await ProjectStore.initialize(workdir);
    const info = await store.read();
    expect(info).toMatchObject({
      kind: 'fieldwork-project',
      goal: '',
      agent_context: {},
      info_revision: 0,
    });
    await expect(ProjectStore.initialize(root)).rejects.toThrow(/not a valid Fieldwork project/);
    await writeFile(
      path.join(workdir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
    );
    await writeFile(path.join(workdir, 'opencode.json'), JSON.stringify({ theme: 'dark' }));
    await refreshAgentConfig(workdir, info.main_session, process.cwd());
    const claude = JSON.parse(await readFile(path.join(workdir, '.mcp.json'), 'utf8'));
    const openCode = JSON.parse(await readFile(path.join(workdir, 'opencode.json'), 'utf8'));
    expect(claude.mcpServers.other.command).toBe('other');
    expect(claude.mcpServers.fieldwork.env.FIELDWORK_SESSION_ID).toBe(info.main_session);
    expect(openCode.theme).toBe('dark');
    expect(openCode.instructions).toContain('AGENTS.md');
    expect(openCode.mcp.fieldwork.environment.FIELDWORK_WORKDIR).toBe(workdir);
    const specialistDir = path.join(workdir, `session-${info.main_session}`);
    await refreshAgentConfig(workdir, info.main_session, process.cwd(), specialistDir);
    const specialistOpenCode = JSON.parse(
      await readFile(path.join(specialistDir, 'opencode.json'), 'utf8'),
    );
    expect(specialistOpenCode.instructions).toContain('../AGENTS.md');
    await refreshAgentConfig(workdir, info.main_session, process.cwd());
    expect(
      (await readFile(path.join(workdir, '.codex/config.toml'), 'utf8')).match(
        /BEGIN FIELDWORK MANAGED/g,
      ),
    ).toHaveLength(1);
    await writeFile(
      path.join(workdir, '.mcp.json'),
      JSON.stringify({ mcpServers: { fieldwork: { command: 'other' } } }),
    );
    await expect(refreshAgentConfig(workdir, info.main_session, process.cwd())).rejects.toThrow(
      /unmanaged fieldwork/,
    );
  });

  it('serves project info and isolates main and submodule scenes across a restart', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldwork-project-parent-'));
    const workdir = path.join(root, 'project');
    const store = await ProjectStore.initialize(workdir);
    const info = await store.read();
    const start = async (runId: string) => {
      const application = await createApp({
        dataDir: path.join(workdir, '.fieldwork'),
        artifactsDir: path.join(workdir, '.fieldwork/runs'),
        runId,
        clientUrl: '',
        projectStore: store,
      });
      server = application.app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.on('listening', resolve));
      return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    };
    let base = await start('first');
    const request = (route: string, init?: RequestInit) => fetch(`${base}${route}`, init);
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const project = (await (await request('/api/project')).json()) as { project: typeof info };
    expect(project.project.main_session).toBe(info.main_session);
    const update = (await (
      await request(
        '/api/workspaces/' + info.main_session + '/tools',
        json('POST', {
          tool: 'update_project_info',
          arguments: {
            expectedRevision: 0,
            goal: 'Build a small garden',
            agentContext: { phase: 'design' },
          },
        }),
      )
    ).json()) as { success: boolean; result: typeof info };
    expect(update.success).toBe(true);
    expect(update.result).toMatchObject({
      goal: 'Build a small garden',
      info_revision: 1,
      agent_context: { phase: 'design' },
    });
    expect((await store.read()).goal).toBe('Build a small garden');
    const conflict = await request(
      '/api/project',
      json('PATCH', { expectedRevision: 0, goal: 'stale' }),
    );
    expect(conflict.status).toBe(400);
    const mainContext = (await (
      await request(`/api/workspaces/${info.main_session}/context`)
    ).json()) as { context: { goal: string } };
    expect(mainContext.context.goal).toBe('Build a small garden');
    const created = (await (
      await request('/api/workspaces', json('POST', { name: 'Pond', goal: 'Design a pond' }))
    ).json()) as { workspace: { id: string } };
    const sub = created.workspace.id;
    expect(await readFile(path.join(workdir, `session-${sub}/workspace.json`), 'utf8')).toContain(
      'Design a pond',
    );
    const tool = (id: string, name: string) =>
      request(
        `/api/workspaces/${id}/tools`,
        json('POST', { tool: name, arguments: { name: 'stone', type: 'sphere' } }),
      );
    expect(
      ((await (await tool(sub, 'create_object')).json()) as { sceneRevision: number })
        .sceneRevision,
    ).toBe(1);
    const mainState = (await (
      await request(`/api/workspaces/${info.main_session}/state`)
    ).json()) as { objects: unknown[] };
    expect(mainState.objects).toHaveLength(0);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    base = await start('second');
    const recovered = (await (await request(`/api/workspaces/${sub}/state`)).json()) as {
      objects: { name: string }[];
    };
    expect(recovered.objects.map((object) => object.name)).toEqual(['stone']);
    const workspaces = (await (await request('/api/workspaces')).json()) as {
      workspaces: { id: string }[];
    };
    expect(workspaces.workspaces.map((workspace) => workspace.id).sort()).toEqual(
      [info.main_session, sub].sort(),
    );
  });
});
