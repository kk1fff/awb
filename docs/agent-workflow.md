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

For concurrent specialist work, create one workspace per specialist through `npm run workspace -- create --name "..." --goal "..."` or `POST /api/workspaces`. Start each specialist's MCP/scene CLI process with its own UUID `SCENE_WORKSPACE_ID`; tool calls do not carry a workspace selector. The browser uses `/?workspace=<uuid>`. Read/update the workspace brief and progress with `get_workspace_context` and `update_workspace_context`. Each workspace has an independent active scene and local catalog. In `promote_asset`, `sourceWorkspaceId` selects the source; the destination is the bound workspace. The promoted GLB is copied under a new target catalog ID with lineage, then placed using `search_assets` and `create_object`. Workspaces reopen with a new run after restart. Every accepted scene change is recoverable, so restart restores the exact last committed revision and object IDs; the new run's `run.json` records the source execution, run, and revision. Named saves and prior run evidence also persist. If recovery metadata or the current snapshot is corrupt or missing, health/context report `recoveryError`, and scene changes, saves, renders, and exports fail with `RECOVERY_UNAVAILABLE` until repaired rather than silently opening an empty scene.
