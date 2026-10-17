import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toolSchemas, type ToolName } from '../shared/schema.js';

const api = process.env.SCENE_API ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
const descriptions: Record<ToolName, string> = {
  create_object: 'Create a box, sphere, cylinder, cone, plane, or searchable catalog model in the current scene.',
  update_object: 'Update a scene object by its stable ID.',
  delete_object: 'Delete a scene object by its stable ID.',
  list_objects: 'List scene objects and their current properties.',
  inspect_object: 'Inspect one scene object by ID.',
  search_assets: 'Search the local catalog for models, material presets, or lighting environments.',
  set_camera: 'Set position, target, orthographic view size, projection, or vertical perspective field of view.',
  set_lighting: 'Update ambient/directional lighting, shadow softness, or visible background mode/color.',
  render_scene: 'Capture a PNG checkpoint of the current scene for visual inspection.',
  export_scene: 'Export visible scene meshes and materials as a downloadable GLB file.',
  save_scene: 'Save the current editable scene under a name.',
  load_scene: 'Load a previously saved editable scene by name.',
  record_review:
    'Record a scene evaluation, human decision, change request, or evidence-backed tool issue.',
};

const server = new McpServer({ name: 'fieldwork', version: '2.0.0' });
for (const [name, schema] of Object.entries(toolSchemas) as [
  ToolName,
  (typeof toolSchemas)[ToolName],
][]) {
  server.registerTool(
    name,
    { description: descriptions[name], inputSchema: schema.shape },
    async (args: unknown) => {
      try {
        const response = await fetch(`${api}/api/tools`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: name, arguments: args }),
          signal: AbortSignal.timeout(120_000),
        });
        const result = await response.json();
        const success = Boolean((result as { success?: boolean }).success);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: !success,
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Fieldwork request failed: ${String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
