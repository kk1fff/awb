# Designer agent bootstrap

Use this guide when asked to build or improve a scene with Fieldwork. The host agent runtime owns agent delegation; Fieldwork provides scene workspaces and public tools, but does not spawn or schedule agents.

## Before scene work

1. Identify the task mode. Build or edit a scene through public tools and the UI. Change application source only when the user asks for a product, interface, or workflow change.
2. Read the current scene and workspace before changing anything. Each MCP or scene CLI process is bound to one UUID workspace by `SCENE_WORKSPACE_ID`; it is required and cannot be changed per tool call. Create a workspace with `npm run workspace -- create --name "..." --goal "..."` (or `POST /api/workspaces`) and configure the returned UUID before connecting. Use `get_workspace_context` to read its goal, criteria, constraints, task, status and summary. The browser uses `/?workspace=<uuid>`. The legacy default remains available through HTTP `/api/*` and the web UI, not MCP or scene CLI.
3. If the work needs specialists, delegate through the host runtime. Create one workspace per specialist with the setup CLI or `POST /api/workspaces`, then give each specialist its own workspace UUID and task. Workspaces isolate app state logically; they are not OS or security boundaries.
4. Keep designer scene work paused while an engineer is changing shared application source. Resume after review/commit and rerun the scene from a fresh scene using the accepted goal and criteria.

## Build with public tools

Use the Fieldwork public scene tools (`get_workspace_context`, `update_workspace_context`, `create_object`, `update_object`, `delete_object`, `list_objects`, `inspect_object`, `search_assets`, `set_camera`, `set_lighting`, `render_scene`, `export_scene`, `save_scene`, `load_scene`, and `record_review`) or the browser UI. Both submit edits through the same server-owned scene API. Context updates change `metadataRevision`, not `sceneRevision`. Do not edit scene JSON or renderer source to work around a scene-building limitation.

For each requested scene:

1. Build the requested result, then call `render_scene`.
2. Open and inspect the actual PNG. Report concrete findings about composition, visibility, materials, and geometry. A successful API call, export, or generated PNG alone does not establish visual quality.
3. Make an evidence-based correction through public tools, render again, and inspect the new PNG. If the first render already meets every criterion, use a purpose-built known-defect test scene for the correction loop rather than making an arbitrary edit.
4. Save the editable scene with `save_scene`; reload it with `load_scene` and verify object IDs/count, key properties, and renderability. Keep screenshots, scene state, events, and a short review together under the run's artifact directory when available.
5. State what was visually inspected, what checks ran, and what remains below the requested quality bar. Never claim an image was inspected unless it was actually opened.

## Specialist handoff and asset promotion

Each specialist should work in its own workspace and keep that workspace focused on one intended submodel. After saving the scene, the specialist can call `export_scene`. Export includes visible scene geometry, so unrelated visible objects will also be in the handoff.

Promote explicitly into the target (usually `default`) workspace with its `promote_asset` tool. For an exported scene, provide the source workspace ID, source run ID, and the successful `export_scene` execution ID. A local catalog asset can also be promoted from its source workspace. Promotion copies the artifact into the target catalog under a new target asset ID and records its source lineage. In the target workspace, use `search_assets` to find the new ID and `create_object` to place it. Do not assume catalogs are shared or mutate another workspace's catalog implicitly.

## Asset and feedback rules

- Do not download models, textures, HDRs, or other artifacts from the internet. Use locally authored geometry/materials/textures or assets the user supplied.
- Retry recoverable authoring mistakes through existing tools. If a valid public operation fails reproducibly, produces wrong state/rendering, or requires a fragile workaround, record the exact workspace/run, call and arguments, response/error, relevant screenshot, impact, and proposed interface change in `feedback.md` using `record_review` where appropriate. Tell the engineer; do not disguise an app limitation as an asset-quality issue.
- Distinguish tool quality from scene quality. A scene that exports successfully can still miss the requested visual goal.

## Acceptance bar: photorealistic PNW single-family house

For the PNW house task, judge the actual rendered image against photographic plausibility. Look for convincing construction scale and detail (siding/trim, roof/eaves, windows, porch), natural varied foliage and ground, coherent soft daylight, believable perspective/framing, and no obvious overlaps or missing elements. State explicitly if the result remains stylized or otherwise falls short. Preserve this bar across reruns; do not lower it because an asset imports, a scene saves, or a tool call succeeds.

## API and workspace references

- `GET /api/tools` lists public tool schemas. `POST /api/tools` calls the default workspace; `POST /api/workspaces/<uuid>/tools` calls a specialist workspace.
- `GET /api/instructions` returns this bootstrap as Markdown for API-only agents.
- `docs/agent-workflow.md` and `docs/tools.md` describe the broader app workflow and tool contracts.
- Every accepted scene-changing command is committed with a recovery snapshot. After restart, the workspace opens a new run with the exact last committed scene revision and object IDs restored. The new run's `run.json` records whether recovery occurred and, if so, the source execution ID, run ID, and revision. Named saves and prior run evidence persist too.
- If recovery metadata or the current snapshot is corrupt or missing, the app still starts and exposes `recoveryError` in health and workspace context. Scene mutations, saves, renders, and exports then return `RECOVERY_UNAVAILABLE` until the recovery issue is repaired; do not proceed as if an empty scene were recovered.
