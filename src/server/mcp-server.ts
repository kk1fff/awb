import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolSchemas, type ToolName } from '../shared/schema.js';

export const fieldworkInstructions =
  'Build scenes through Fieldwork public tools and UI. Before scene work, read docs/designer-agent-bootstrap.md (also available at GET /api/instructions). Each MCP process is bound to one UUID workspace through SCENE_WORKSPACE_ID; create/configure a workspace with the setup CLI before connecting. Delegate specialists through your host agent runtime, not through this app; give each specialist a separate workspace. Read workspace goal, acceptance criteria, constraints, task and status with get_workspace_context; update task progress with update_workspace_context. Promote assets or scene exports explicitly and preserve source lineage. Render, open and inspect the actual PNG, make evidence-based corrections, save, reload, and verify the scene. Never download assets. Escalate reproducible app limitations with calls and evidence. Pause designer scene work during shared engineer source changes, then rerun from a fresh scene. For the PNW house, retain the photographic acceptance bar and state any shortfall.';

const descriptions: Record<ToolName, string> = {
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
        inputSchema: schema.shape,
      },
      async (args: unknown) => {
        try {
          const workspaceId = defaultWorkspaceId;
          const toolArguments = args && typeof args === 'object' ? args : {};
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
            headers: { 'Content-Type': 'application/json' },
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
  return server;
}
