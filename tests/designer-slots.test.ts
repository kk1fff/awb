import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../src/server/project.js';
import { createApp } from '../src/server/app.js';
import { createFieldworkMcpServer } from '../src/server/mcp-server.js';
import { refreshDesignerInstructions } from '../src/server/agent-config.js';

describe('designer capacity and delegation', () => {
  let parent = '';
  let listener: Server | undefined;
  let client: Client | undefined;
  let mcp: ReturnType<typeof createFieldworkMcpServer> | undefined;
  afterEach(async () => {
    if (client) await client.close();
    if (mcp) await mcp.close();
    if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()));
    if (parent) await rm(parent, { recursive: true, force: true });
  });

  it('reserves before spawn, routes a specialist, and frees capacity only after lead confirmation', async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'fieldwork-designers-'));
    const root = path.join(parent, 'project');
    const store = await ProjectStore.initialize(root);
    const main = (await store.read()).main_session;
    const application = await createApp({
      dataDir: path.join(root, '.fieldwork'),
      artifactsDir: path.join(root, '.fieldwork/runs'),
      runId: 'designer-test',
      clientUrl: '',
      projectStore: store,
      concurrentLimit: 2,
    });
    listener = application.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener!.once('listening', resolve));
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    mcp = createFieldworkMcpServer({ api: base, workspaceId: main });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'designer-test', version: '1' });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = (await client!.callTool({ name, arguments: args })) as {
        content: { text?: string }[];
        isError?: boolean;
      };
      return { ...response, value: JSON.parse(response.content[0]!.text!) as Record<string, any> };
    };
    expect((await call('get_designer_status')).value).toMatchObject({
      limit: 2,
      used: 1,
      available: 1,
    });
    const reserved = await call('reserve_designer_slot', { task: 'Design the pond' });
    const reservationId = reserved.value.reservation.reservationId as string;
    expect(reserved.value.status).toMatchObject({ used: 2, available: 0 });
    const overLimit = await call('reserve_designer_slot', { task: 'Design trees' });
    expect(overLimit.isError).toBe(true);
    expect(overLimit.value.error.code).toBe('DESIGNER_LIMIT_REACHED');
    const opened = await call('open_designer_session', {
      reservationId,
      name: 'Pond designer',
      goal: 'Build a pond',
    });
    const sessionId = opened.value.reservation.sessionId as string;
    expect(
      await readFile(path.join(root, `session-${sessionId}`, 'workspace.json'), 'utf8'),
    ).toContain('Build a pond');
    const created = await call('create_object', { sessionId, name: 'water', type: 'sphere' });
    expect(created.value).toMatchObject({
      success: true,
      sceneRevision: 1,
      workspaceId: sessionId,
    });
    const mainState = (await fetch(`${base}/api/state`).then((response) => response.json())) as {
      objects: unknown[];
    };
    expect(mainState.objects).toHaveLength(0);
    const completed = await call('complete_designer_session', {
      sessionId,
      summary: 'Pond scene saved for lead review.',
    });
    expect(completed.value.status).toMatchObject({ used: 2, available: 0 });
    const rejected = await call('create_object', { sessionId, name: 'late', type: 'box' });
    expect(rejected.isError).toBe(true);
    expect(rejected.value.error.code).toBe('DESIGNER_SESSION_CLOSED');
    expect((await call('list_objects', { sessionId })).value.result).toHaveLength(1);
    const confirmed = await call('confirm_designer_session', { sessionId });
    expect(confirmed.value.status).toMatchObject({ used: 1, available: 1 });
    const next = await call('reserve_designer_slot', { task: 'Refine the pond' });
    const nextReservationId = next.value.reservation.reservationId as string;
    const mainAttempt = await call('open_designer_session', {
      reservationId: nextReservationId,
      name: 'Invalid lead takeover',
      goal: 'Try to claim the lead session',
      existingSessionId: main,
    });
    expect(mainAttempt.isError).toBe(true);
    expect(mainAttempt.value.error.code).toBe('MAIN_SESSION_RESERVED');
    const resumed = await call('open_designer_session', {
      reservationId: nextReservationId,
      name: 'Pond designer',
      goal: 'Refine the pond',
      existingSessionId: sessionId,
    });
    expect(resumed.value.reservation.sessionId).toBe(sessionId);
    const refinement = await call('create_object', {
      sessionId,
      name: 'lily',
      type: 'sphere',
    });
    expect(refinement.value).toMatchObject({ success: true, sceneRevision: 2 });
    expect(
      (await call('complete_designer_session', { sessionId, summary: 'Refined pond.' })).value
        .reservation.state,
    ).toBe('awaiting_confirmation');
    expect((await call('confirm_designer_session', { sessionId })).value.status).toMatchObject({
      used: 1,
      available: 1,
    });
  });

  it('keeps user instructions and resets run-scoped reservations after restart', async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'fieldwork-designers-'));
    const root = path.join(parent, 'project');
    const store = await ProjectStore.initialize(root);
    await writeFile(path.join(root, 'AGENTS.md'), '# User rules\nKeep this project local.\n');
    await refreshDesignerInstructions(root);
    await refreshDesignerInstructions(root);
    const text = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(text).toContain('Keep this project local.');
    expect(text.match(/BEGIN FIELDWORK DESIGNER/g)).toHaveLength(1);
    const options = {
      dataDir: path.join(root, '.fieldwork'),
      artifactsDir: path.join(root, '.fieldwork/runs'),
      clientUrl: '',
      projectStore: store,
    };
    const first = await createApp({ ...options, runId: 'first-run', concurrentLimit: 2 });
    listener = first.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener!.once('listening', resolve));
    let base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const racing = await Promise.all(
      ['Trees', 'Bench'].map((task) =>
        fetch(`${base}/api/designers/reservations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task }),
        }),
      ),
    );
    expect(racing.map((response) => response.status).sort()).toEqual([201, 400]);
    expect(
      (
        (await fetch(`${base}/api/designers`).then((response) => response.json())) as {
          used: number;
        }
      ).used,
    ).toBe(2);
    await new Promise<void>((resolve) => listener!.close(() => resolve()));
    listener = undefined;
    const second = await createApp({ ...options, runId: 'second-run', concurrentLimit: 3 });
    listener = second.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener!.once('listening', resolve));
    base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    expect(await fetch(`${base}/api/designers`).then((response) => response.json())).toMatchObject({
      limit: 3,
      used: 1,
      available: 2,
    });
    await new Promise<void>((resolve) => listener!.close(() => resolve()));
    listener = undefined;
    const defaultLimit = await createApp({ ...options, runId: 'default-limit-run' });
    listener = defaultLimit.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener!.once('listening', resolve));
    base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    expect(await fetch(`${base}/api/designers`).then((response) => response.json())).toMatchObject({
      limit: 4,
      used: 1,
      available: 3,
    });
  });
});
