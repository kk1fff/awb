# Agent workflow

Start Codex, Claude Code, or OpenCode from the repository root and give it a task. Their checked-in project configuration exposes the `fieldwork` MCP tools. On a fresh clone, the bootstrap installs project dependencies and Playwright Chromium, starts the local API and browser app, and opens the workspace. The browser receives live scene and activity updates over server-sent events.

For the persistent designer instructions supplied during MCP initialization, see [`designer-agent-bootstrap.md`](designer-agent-bootstrap.md); API-only agents can fetch the same guide from `GET /api/instructions`.

## Choose a mode from the request

- **Scene mode:** requests to create, edit, inspect, save, or export a world. Use only public scene tools for scene changes. Render and inspect a checkpoint before evaluating visual quality; make evidence-based corrections where needed.
- **Tool mode:** requests to change or improve the application, its UI, capabilities, or workflow. Work in source, add meaningful tests, and run the app/browser for visible changes.
- If the request combines both or the desired result is unclear, ask one concise question to determine the intended outcome. Do not silently switch modes or change the product during a scene task.

## Scene creation loop

1. Check the current scene and the requested result. Use `create_object`, `update_object`, `delete_object`, `set_camera`, and `set_lighting` to build through the public interface.
2. Call `render_scene`, inspect the returned PNG, and describe concrete visual findings. Correct observed issues through public tools and render again.
3. Save the editable scene with `save_scene`. Use `export_scene` when a portable mesh is requested; it returns a GLB artifact URL, file name, byte size, and scene revision. The browser's **Export GLB** action downloads the same format.
4. Record evaluations, approvals, change requests, or evidence-backed tool issues with `record_review`.
5. Report the result, artifacts, checks actually performed, and any remaining limits. Never claim visual inspection unless the image was opened and inspected.

## Tool improvement loop

1. State the user's requested behavior and acceptance criteria. Inspect the relevant implementation, tests, and current Git changes.
2. Make a focused code change and add/update tests that verify the behavior.
3. Run typecheck and the relevant unit/API/browser checks. For visible changes, inspect the running UI and browser console.
4. Report changed behavior, verification, and any limitation. Keep generated scenes and test artifacts out of commits unless they are intentional fixtures.

The local API remains the source of truth. MCP calls and browser edits use the same command endpoint, and the browser activity panel shows a tool call while it is running and after it completes.

For concurrent specialist work, create one workspace per specialist through the workspace dashboard, `npm run workspace -- create --name "..." --goal "..."`, or `POST /api/workspaces`. Fill in acceptance criteria, constraints, and owner as part of workspace setup. Start each specialist's MCP/scene CLI process with its own UUID `SCENE_WORKSPACE_ID`; tool calls do not carry a workspace selector. Verify the first `get_workspace_context` response identifies the assigned UUID and brief before edits, and confirm again after reconnect. The browser uses `/?workspace=<uuid>` and shows the workspace list, brief, active scene, current run, and live activity. Context/status edits are metadata-only and do not increment `sceneRevision`.

The host agent runtime performs specialist delegation; Fieldwork does not launch agents. Give each specialist a distinct workspace and task, have it update `currentTask`/`workStatus`/`summary`, then review its checkpoint and handoff. Workspaces have separate scenes, catalogs, runs, and events. Use `export_scene_bundle` for a portable ZIP containing an editable scene, referenced assets, preview, and GLB. Import it through the UI or `POST /api/workspaces/<target-uuid>/bundles/import` with `X-Scene-Name`; import creates a named editable save plus a new placeable GLB asset and leaves the target's active scene unchanged. Use `load_scene` to open the editable save, or `search_assets` then `create_object` to place the GLB. For in-installation asset promotion, `sourceWorkspaceId` selects the source and the bound workspace is the destination; the copied target asset has a new ID and source lineage.

Archive a completed/paused workspace from the dashboard or setup API/CLI. Archived metadata and history remain browsable, while scene/context writes are disabled. Restore before continuing. Purge is permanent, requires the exact UUID, and cannot target `default`; use the workspace list from another workspace to purge. Pause designer scene work while an engineer changes shared application source, then resume from a fresh render after review/commit. Never download scene assets; use user-supplied or locally authored files. On restart, every accepted scene change is recoverable and restores the exact last committed revision and object IDs; the new run's `run.json` records recovery provenance. If recovery data is damaged, health/context expose `recoveryError` and writes fail with `RECOVERY_UNAVAILABLE` instead of silently opening an empty scene.
