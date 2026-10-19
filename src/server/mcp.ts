import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFieldworkMcpServer } from './mcp-server.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ProjectStore } from './project.js';

let binding: { api?: string; workspaceId?: string } = {};
if (process.env.FIELDWORK_WORKDIR || process.env.FIELDWORK_SESSION_ID) {
  const root = process.env.FIELDWORK_WORKDIR;
  const workspaceId = process.env.FIELDWORK_SESSION_ID;
  if (!root || !workspaceId) throw new Error('Incomplete Fieldwork project MCP binding.');
  const project = await new ProjectStore(root).read();
  if (!(await stat(path.join(root, `session-${workspaceId}`)).catch(() => null))?.isDirectory())
    throw new Error(`Session ${workspaceId} does not belong to this project.`);
  const runtime = JSON.parse(
    await readFile(path.join(root, '.fieldwork/runtime.json'), 'utf8'),
  ) as {
    projectId: string;
    runId: string;
    apiUrl: string;
  };
  if (runtime.projectId !== project.project_id)
    throw new Error('Fieldwork project binding mismatch.');
  const response = await fetch(`${runtime.apiUrl}/api/project`, {
    signal: AbortSignal.timeout(3000),
  });
  const active = (await response.json()) as { project?: { project_id: string }; runId?: string };
  if (
    !response.ok ||
    active.project?.project_id !== project.project_id ||
    active.runId !== runtime.runId
  )
    throw new Error('Fieldwork run binding is stale or points to another server.');
  const workspace = await fetch(`${runtime.apiUrl}/api/workspaces/${workspaceId}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  const health = (await workspace.json()) as { workspaceId?: string };
  if (!workspace.ok || health.workspaceId !== workspaceId)
    throw new Error('Fieldwork session binding mismatch.');
  binding = { api: runtime.apiUrl, workspaceId };
}
const server = createFieldworkMcpServer(binding);
await server.connect(new StdioServerTransport());
