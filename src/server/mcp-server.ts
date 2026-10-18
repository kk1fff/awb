import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolSchemas, type ToolName } from '../shared/schema.js';

export const fieldworkInstructions =
  'Build scenes through Fieldwork public tools and UI. Before scene work, read docs/designer-agent-bootstrap.md (also available at GET /api/instructions). Delegate specialists through your host agent runtime, not through this app; give each specialist a separate workspace. On a shared MCP connection, pass workspaceId on every call to route it independently; it selects the execution/destination workspace, while promote_asset sourceWorkspaceId remains the source. Promote assets or scene exports explicitly and preserve source lineage. Render, open and inspect the actual PNG, make evidence-based corrections, save, reload, and verify the scene. Never download assets. Escalate reproducible app limitations with calls and evidence. Pause designer scene work during shared engineer source changes, then rerun from a fresh scene. For the PNW house, retain the photographic acceptance bar and state any shortfall.';

const descriptions: Record<ToolName, string> = {
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
  save_scene: 'Save the current editable scene under a name.',
  load_scene: 'Load a previously saved editable scene by name.',
  promote_asset:
    'Copy a local catalog asset or verified scene export from another workspace into this workspace catalog.',
  record_review:
    'Record a scene evaluation, human decision, change request, or evidence-backed tool issue.',
};

const workspaceIdShape = z
  .string()
  .regex(/^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, {
    error: 'workspaceId must be "default" or a workspace UUID.',
  })
  .optional();
const validWorkspaceId = (value: string) =>
  value === 'default' ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function createFieldworkMcpServer(options: { api?: string; workspaceId?: string } = {}) {
  const api =
    options.api ?? process.env.SCENE_API ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
  const defaultWorkspaceId = options.workspaceId ?? process.env.SCENE_WORKSPACE_ID ?? 'default';
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
        description: `${descriptions[name]} Optional workspaceId selects the execution workspace for this call; omitted uses the configured MCP workspace.`,
        inputSchema: { ...schema.shape, workspaceId: workspaceIdShape },
      },
      async (args: unknown) => {
        try {
          const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
          const requestedWorkspaceId = input.workspaceId;
          if (
            requestedWorkspaceId !== undefined &&
            (typeof requestedWorkspaceId !== 'string' || !validWorkspaceId(requestedWorkspaceId))
          ) {
            const workspaceId = String(requestedWorkspaceId);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      workspaceId,
                      error: {
                        code: 'INVALID_WORKSPACE_ID',
                        message: 'workspaceId must be "default" or a workspace UUID.',
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
          const workspaceId = (requestedWorkspaceId as string | undefined) ?? defaultWorkspaceId;
          if (!validWorkspaceId(workspaceId)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      workspaceId,
                      error: {
                        code: 'INVALID_WORKSPACE_ID',
                        message: 'Configured MCP workspace must be "default" or a workspace UUID.',
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
          const toolEndpoint =
            workspaceId === 'default'
              ? `${api}/api/tools`
              : `${api}/api/workspaces/${encodeURIComponent(workspaceId)}/tools`;
          const toolArguments = { ...input };
          delete toolArguments.workspaceId;
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
