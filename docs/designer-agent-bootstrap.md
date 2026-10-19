# Designer agent bootstrap

Use this guide when asked to build or improve a scene with Fieldwork. The host agent runtime owns agent delegation; Fieldwork provides scene workspaces and public tools, but does not spawn or schedule agents.

Fieldwork launches agents in a separate project workdir. This file lives in the Fieldwork application checkout, not in that workdir. From the launcher shell, read the served copy with `curl "$SCENE_API/api/instructions"`; `SCENE_API` points to the current local server. The MCP connection also provides a short startup summary. The human's request supplies the task; a new project's `info.yaml` starts with an empty goal.

## Before scene work

1. Identify the task mode. Build or edit a scene through public tools and the UI. Change application source only when the user asks for a product, interface, or workflow change.
2. Call `get_project_info`, `get_designer_status`, and `get_workspace_context` before changing the scene. If the project goal is empty, record the human's goal with `update_project_info`. The main agent is the lead designer. The concurrent limit includes the lead; default capacity is four. The browser uses `/?workspace=<uuid>` to inspect a specific session.
3. For substantial scenes, the lead divides independent parts when doing so improves detail. Before creating each host-runtime specialist, call `reserve_designer_slot` and pass the reservation ID and task directly to that subagent. The subagent calls `open_designer_session` when it starts, then passes its `sessionId` on every scene tool call. It renders, inspects, saves, and calls `complete_designer_session`. The lead inspects the actual result, combines accepted work in the main session, and calls `confirm_designer_session` to free the slot. Use `abort_designer_slot` when a subagent fails. Fieldwork tracks sessions; the host runtime creates and communicates with agents.
4. Keep designer scene work paused while an engineer is changing shared application source. Resume after review/commit and rerun the scene from a fresh scene using the accepted goal and criteria.

## Build with public tools

Use the Fieldwork public scene tools (`get_project_info`, `update_project_info`, `get_workspace_context`, `update_workspace_context`, `create_object`, `update_object`, `delete_object`, `list_objects`, `inspect_object`, `search_assets`, `set_camera`, `set_lighting`, `render_scene`, `export_scene`, `save_scene`, `load_scene`, and `record_review`) or the browser UI. Both submit edits through the same server-owned scene API. Project and context updates do not increment `sceneRevision`. Do not edit scene JSON or renderer source to work around a scene-building limitation.

For each requested scene:

1. Build the requested result, then call `render_scene`.
2. Open and inspect the actual PNG. Report concrete findings about composition, visibility, materials, and geometry. A successful API call, export, or generated PNG alone does not establish visual quality.
3. Make an evidence-based correction through public tools, render again, and inspect the new PNG. If the first render already meets every criterion, use a purpose-built known-defect test scene for the correction loop rather than making an arbitrary edit.
4. Save the editable scene with `save_scene`; reload it with `load_scene` and verify object IDs/count, key properties, and renderability. Keep screenshots, scene state, events, and a short review together under the run's artifact directory when available.
5. State what was visually inspected, what checks ran, and what remains below the requested quality bar. Never claim an image was inspected unless it was actually opened.

## Specialist handoff and asset promotion

Each specialist should work in its own session and keep that session focused on one intended submodel. After saving the scene, the specialist can call `export_scene` with its `sessionId`. Export includes visible scene geometry, so unrelated visible objects will also be in the handoff.

For a portable handoff, call `export_scene_bundle` or use **Export handoff ZIP** in the browser. Import the ZIP in the target workspace through the dashboard file picker or `POST /api/workspaces/<target-uuid>/bundles/import` with `Content-Type: application/zip` and a unique `X-Scene-Name`. The import creates two outputs: an editable named source scene (including referenced local assets) and a placeable GLB catalog asset with new target IDs and lineage. It does not switch or replace the target's active scene. Follow the success message: use `load_scene` for the editable source save, or `search_assets` then `create_object` to place the GLB. Promote explicitly for same-installation handoff with `promote_asset`, using source workspace/run/export execution IDs; the bound target receives a new catalog ID and lineage. Do not assume catalogs are shared or mutate another workspace's catalog implicitly.

## Asset and feedback rules

- Do not download models, textures, HDRs, or other artifacts from the internet. Use locally authored geometry/materials/textures or assets the user supplied.
- Use the workspace dashboard to browse active and archived sessions, review persisted briefs and activity, and archive/restore. Purge is permanent, requires typing the exact UUID, and is available from another session's list; the main session is protected. Archived sessions are read-only until restored.
- Keep the designer paused while shared source files are being changed by an engineer. Resume only after the reviewed implementation is committed; rerun from a fresh scene and inspect its PNG.
- Retry recoverable authoring mistakes through existing tools. If a valid public operation fails reproducibly, produces wrong state/rendering, or requires a fragile workaround, record the exact workspace/run, call and arguments, response/error, relevant screenshot, impact, and proposed interface change in `feedback.md` using `record_review` where appropriate. Tell the engineer; do not disguise an app limitation as an asset-quality issue.
- Distinguish tool quality from scene quality. A scene that exports successfully can still miss the requested visual goal.

## Acceptance bar: photorealistic PNW single-family house

For the PNW house task, judge the actual rendered image against photographic plausibility. Look for convincing construction scale and detail (siding/trim, roof/eaves, windows, porch), natural varied foliage and ground, coherent soft daylight, believable perspective/framing, and no obvious overlaps or missing elements. State explicitly if the result remains stylized or otherwise falls short. Preserve this bar across reruns; do not lower it because an asset imports, a scene saves, or a tool call succeeds.

## API and workspace references

- `GET /api/tools` lists public tool schemas. `POST /api/tools` calls the main session; `POST /api/workspaces/<uuid>/tools` calls a specialist session.
- `GET $SCENE_API/api/instructions` returns this bootstrap as Markdown. In the application checkout, `docs/agent-workflow.md` and `docs/tools.md` describe the broader workflow and tool contracts; these files are not copied into the project workdir.
- Every accepted scene-changing command is committed with a recovery snapshot. After restart, the workspace opens a new run with the exact last committed scene revision and object IDs restored. The new run's `run.json` records whether recovery occurred and, if so, the source execution ID, run ID, and revision. Named saves and prior run evidence persist too.
- If recovery metadata or the current snapshot is corrupt or missing, the app still starts and exposes `recoveryError` in health and workspace context. Scene mutations, saves, renders, and exports then return `RECOVERY_UNAVAILABLE` until the recovery issue is repaired; do not proceed as if an empty scene were recovered.
