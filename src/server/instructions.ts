import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolName } from '../shared/schema.js';

export const instructionFiles = {
  index: 'docs/designer-agent-bootstrap.md',
  scene: 'docs/instructions/scene.md',
  evidence: 'docs/instructions/evidence.md',
  assets: 'docs/instructions/assets.md',
  delegation: 'docs/instructions/delegation.md',
  tools: 'docs/tools.md',
} as const;
export type InstructionTopic = keyof typeof instructionFiles;

export const leadOverview = [
  '## Fieldwork lead designer',
  'You are the lead in the main session. A specialist works in a reserved, separate session. Start with `get_project_info`, `get_designer_status`, and `get_workspace_context`; record an empty human goal with `update_project_info`. The main goal cannot be set with `update_workspace_context`.',
  'Fieldwork tools cover project context, scene objects and assets, camera and lighting, render/save/review, and designer sessions. Scene changes go through public tools. For substantial independent parts, reserve a designer slot before delegating, review the handoff, then confirm the session.',
  'Call `get_instruction_guide` with no topic to see the instruction map. Read the relevant topic before using unfamiliar APIs: `scene` for primitives and transforms, `evidence` for visual inspection and saves, `assets` for catalogs and handoffs, and `delegation` for specialists. Use `tools` for exact HTTP and tool contracts. Render and inspect the actual PNG before judging scene quality.',
].join('\n');

export const designerToolTopics = {
  get_designer_status: 'delegation',
  reserve_designer_slot: 'delegation',
  open_designer_session: 'delegation',
  complete_designer_session: 'delegation',
  confirm_designer_session: 'delegation',
  abort_designer_slot: 'delegation',
} as const;

export const toolTopics = {
  get_project_info: 'delegation',
  update_project_info: 'delegation',
  get_workspace_context: 'delegation',
  update_workspace_context: 'delegation',
  create_object: 'scene',
  update_object: 'scene',
  delete_object: 'scene',
  list_objects: 'scene',
  inspect_object: 'scene',
  search_assets: 'assets',
  set_camera: 'scene',
  set_lighting: 'scene',
  render_scene: 'evidence',
  export_scene: 'assets',
  export_scene_bundle: 'assets',
  save_scene: 'evidence',
  load_scene: 'evidence',
  promote_asset: 'assets',
  record_review: 'evidence',
} as const satisfies Record<ToolName, InstructionTopic>;

// Every route registration in app.ts is inventoried. New routes must be classified;
// agent-facing routes must point to a reachable guide. Keys use the router variable,
// HTTP method, and literal registration path (before Express mount prefixes).
export const routeTopics: Record<string, InstructionTopic | 'internal'> = {
  'router POST /bundles/import': 'assets',
  'router POST /assets/import': 'assets',
  'router GET /health': 'tools',
  'router GET /state': 'tools',
  'router GET /assets/:id/file': 'assets',
  'router GET /assets/:id': 'assets',
  'router GET /tools': 'tools',
  'router GET /events': 'evidence',
  'router GET /reviews': 'evidence',
  'router GET /checkpoints': 'evidence',
  'router GET /stream': 'internal',
  'router GET /checkpoints/:id/scene': 'evidence',
  'router POST /tools': 'tools',
  'app GET /api/project': 'delegation',
  'app PATCH /api/project': 'delegation',
  'app GET /api/designers': 'delegation',
  'app POST /api/designers/reservations': 'delegation',
  'app POST /api/designers/reservations/:reservationId/open': 'delegation',
  'app POST /api/designers/sessions/:sessionId/complete': 'delegation',
  'app POST /api/designers/sessions/:sessionId/confirm': 'delegation',
  'app POST /api/designers/reservations/:reservationId/abort': 'delegation',
  'app GET /api/instructions': 'tools',
  'app GET /api/instructions/:topic': 'tools',
  'app GET /api/workspaces': 'delegation',
  'app GET /api/workspaces/:workspaceId': 'delegation',
  'app GET /api/workspaces/:workspaceId/context': 'delegation',
  'app PATCH /api/workspaces/:workspaceId/context': 'delegation',
  'app POST /api/workspaces': 'delegation',
  'app POST /api/workspaces/:workspaceId/archive': 'delegation',
  'app POST /api/workspaces/:workspaceId/restore': 'delegation',
  'app DELETE /api/workspaces/:workspaceId': 'delegation',
  'app GET /': 'internal',
};

export async function readInstructionTopic(topic: InstructionTopic): Promise<string> {
  return readFile(path.resolve(process.cwd(), instructionFiles[topic]), 'utf8');
}
