import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolSchemas, type ToolName } from '../shared/schema.js';

export const fieldworkInstructions =
  'Fieldwork was started by a human for one project. The main agent is the lead designer; a host subagent with a reservation is a specialist. The MCP connection is bound to the current project, session, and server run. First call get_project_info, get_designer_status, and get_workspace_context. Lead: for substantial scenes, split independent parts for detail, reserve_designer_slot before spawning each host subagent, review its image and handoff, then confirm_designer_session; the concurrent limit includes the lead. Specialist: open_designer_session with the supplied reservation, pass its sessionId on every scene tool call, render and inspect, then complete_designer_session. If the project goal is empty and the human supplied one, update_project_info. Build only through public tools; combine submodule scenes through explicit handoffs. Make evidence-based corrections, save, reload, and verify from a fresh scene when testing a fix. Never download assets. Fetch the complete guide from GET ${SCENE_API}/api/instructions in the Fieldwork launcher shell; the repository copy at docs/designer-agent-bootstrap.md is not in the project workdir.';

const descriptions: Record<ToolName, string> = {
  get_project_info: 'Read the project goal, main session ID, and agent context.',
  update_project_info:
    'Set the project goal or agent context after reading its current info revision.',
  get_workspace_context:
    'Read this workspace’s goal, acceptance criteria, constraints, and work status.',
  update_workspace_context:
    'Update goal, acceptance criteria, constraints, current task, work status, or summary for this workspace.',
  create_object:
    'Create a box, sphere, cylinder, cone, plane, or searchable catalog model in the current scene.',
  update_object: 'Update a scene object by its stable ID.',
  delete_object: 'Delete a scene object by its stable ID.',
  list_objects: 'List scene objects and their current properties.',
  inspect_object: 'Inspect one scene object by ID.',
  search_assets: 'Search the local catalog for models, material presets, or lighting environments.',
  set_camera:
    'Set position, target, orthographic view size, projection, or vertical perspective field of view.',
  set_lighting:
    'Update ambient/directional lighting, shadow softness, or visible background mode/color.',
  render_scene: 'Capture a PNG checkpoint of the current scene for visual inspection.',
  export_scene: 'Export visible scene meshes and materials as a downloadable GLB file.',
  export_scene_bundle:
    'Export a portable ZIP containing the editable scene, referenced local assets, same-revision PNG preview, GLB, and provenance metadata.',
  save_scene: 'Save the current editable scene under a name.',
  load_scene: 'Load a previously saved editable scene by name.',
  promote_asset:
    'Copy a local catalog asset or verified scene export from another workspace into this workspace catalog.',
  record_review:
    'Record a scene evaluation, human decision, change request, or evidence-backed tool issue.',
};

const validWorkspaceId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function createFieldworkMcpServer(options: { api?: string; workspaceId?: string } = {}) {
  const api =
    options.api ?? process.env.SCENE_API ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
  const defaultWorkspaceId = options.workspaceId ?? process.env.SCENE_WORKSPACE_ID;
  if (!defaultWorkspaceId || !validWorkspaceId(defaultWorkspaceId)) {
    throw new Error(
      'Fieldwork MCP requires SCENE_WORKSPACE_ID to be a workspace UUID. Run `npm run workspace -- create --name "My workspace" --goal "..."` (it can create directly in DATA_DIR without a running API), then set SCENE_WORKSPACE_ID to the returned UUID.',
    );
  }
  const server = new McpServer(
    { name: 'fieldwork', version: '2.0.0' },
    { instructions: fieldworkInstructions },
  );
  for (const [name, schema] of Object.entries(toolSchemas) as [
    ToolName,
    (typeof toolSchemas)[ToolName],
  ][]) {
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema:
          name === 'get_project_info' || name === 'update_project_info'
            ? schema.shape
            : { ...schema.shape, sessionId: z.uuid().optional() },
      },
      async (args: unknown) => {
        try {
          const supplied =
            args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
          const { sessionId, ...toolArguments } = supplied;
          const workspaceId = typeof sessionId === 'string' ? sessionId : defaultWorkspaceId;
          const workspaceEndpoint = `${api}/api/workspaces/${encodeURIComponent(workspaceId)}`;
          const workspaceResponse = await fetch(workspaceEndpoint, {
            signal: AbortSignal.timeout(10_000),
          });
          if (!workspaceResponse.ok) {
            const details = (await workspaceResponse.json().catch(() => ({}))) as {
              error?: { code?: string; message?: string };
            };
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      workspaceId,
                      error: {
                        code: details.error?.code ?? 'WORKSPACE_NOT_FOUND',
                        message:
                          details.error?.message ??
                          `Workspace ${workspaceId} is unavailable. Create it with the workspace setup CLI.`,
                      },
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
          const toolEndpoint = `${workspaceEndpoint}/tools`;
          const response = await fetch(toolEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Fieldwork-Designer': '1' },
            body: JSON.stringify({ tool: name, arguments: toolArguments }),
            signal: AbortSignal.timeout(120_000),
          });
          const result = await response.json();
          const success = Boolean((result as { success?: boolean }).success);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  result && typeof result === 'object'
                    ? { ...result, workspaceId }
                    : { result, workspaceId },
                  null,
                  2,
                ),
              },
            ],
            isError: !success,
          };
        } catch (error) {
          return {
            content: [
              { type: 'text' as const, text: `Fieldwork request failed: ${String(error)}` },
            ],
            isError: true,
          };
        }
      },
    );
  }
  const registerDesigner = (
    name: string,
    description: string,
    shape: Record<string, z.ZodType>,
    method: 'GET' | 'POST',
    route: (args: Record<string, unknown>) => string,
    body?: (args: Record<string, unknown>) => unknown,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: shape },
      async (args: Record<string, unknown>) => {
        try {
          const response = await fetch(`${api}${route(args)}`, {
            method,
            ...(body
              ? {
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body(args)),
                }
              : {}),
            signal: AbortSignal.timeout(30_000),
          });
          const result = await response.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            isError: !response.ok,
          };
        } catch (error) {
          return {
            content: [
              { type: 'text' as const, text: `Fieldwork request failed: ${String(error)}` },
            ],
            isError: true,
          };
        }
      },
    );
  registerDesigner(
    'get_designer_status',
    'Read the current designer limit, occupied slots, and reservations.',
    {},
    'GET',
    () => '/api/designers',
  );
  registerDesigner(
    'reserve_designer_slot',
    'Lead designer: reserve a slot before creating a subagent.',
    { task: z.string().trim().min(1).max(2000) },
    'POST',
    () => '/api/designers/reservations',
    (args) => ({ task: args.task }),
  );
  registerDesigner(
    'open_designer_session',
    'Subagent: create or resume a session from a lead reservation.',
    {
      reservationId: z.uuid(),
      name: z.string().trim().min(1).max(100),
      goal: z.string().trim().min(1).max(2000),
      existingSessionId: z.uuid().optional(),
    },
    'POST',
    (args) => `/api/designers/reservations/${args.reservationId}/open`,
    (args) => ({
      name: args.name,
      goal: args.goal,
      ...(args.existingSessionId ? { existingSessionId: args.existingSessionId } : {}),
    }),
  );
  registerDesigner(
    'complete_designer_session',
    'Subagent: mark session work ready for lead review.',
    { sessionId: z.uuid(), summary: z.string().trim().min(1).max(4000) },
    'POST',
    (args) => `/api/designers/sessions/${args.sessionId}/complete`,
    (args) => ({ summary: args.summary }),
  );
  registerDesigner(
    'confirm_designer_session',
    'Lead designer: confirm reviewed work and free its slot.',
    { sessionId: z.uuid() },
    'POST',
    (args) => `/api/designers/sessions/${args.sessionId}/confirm`,
  );
  registerDesigner(
    'abort_designer_slot',
    'Lead designer: free an unused or failed reservation.',
    { reservationId: z.uuid(), reason: z.string().trim().min(1).max(2000) },
    'POST',
    (args) => `/api/designers/reservations/${args.reservationId}/abort`,
    (args) => ({ reason: args.reason }),
  );
  return server;
}
