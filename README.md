# Fieldwork · Agent World Builder

A local 3D workspace for an external AI agent to create, render, inspect, and revise scenes. Humans see the same scene, inspect objects, compare immutable checkpoints, and record feedback.

## Start with an agent

After cloning, launch one of the supported agents from the project folder and give it a task:

```bash
codex
# or: claude
# or: opencode
```

On first connection, the project's MCP bootstrap installs npm dependencies and Playwright Chromium if needed, starts the local app, and opens **http://127.0.0.1:5173**. The browser shows the scene and the agent's actions live. Requires Node.js 22.12+, npm, and the selected agent CLI already installed and signed in. If Chromium reports missing Linux libraries, install them with `npx playwright install --with-deps chromium`.

The agent chooses between two modes from your request: build or edit a scene through the public tools, or improve the application/interface when you ask for that. It asks a brief clarification if the requested mode or outcome is unclear. Project-specific MCP setup is checked in for Codex, Claude Code, and OpenCode.

To run the app without an agent, install dependencies and start the development servers directly:

```bash
npm ci
npx playwright install chromium
npm run dev
```

Open **http://127.0.0.1:5173**. The tool API listens at **http://127.0.0.1:3001**.

Production-style local launch:

```bash
npm run build
npm start
```

Then open http://127.0.0.1:3001. No model credentials are needed. The application binds to localhost and has no authentication; it is intended for local use.

## Agent tools

The `fieldwork` MCP server exposes the same validated tools as the HTTP API. The tool contract and workflow are documented in [the tool guide](docs/tools.md) and [agent workflow](docs/agent-workflow.md). Scene-building agents must use public tools rather than editing scene JSON or renderer source. Create a logical workspace with `POST /api/workspaces`, open it in the UI with `/?workspace=<uuid>`, or set `SCENE_WORKSPACE_ID=<uuid>` for an MCP/CLI client. Workspaces isolate scene state, local assets, saves, events, checkpoints, and runs; `promote_asset` explicitly copies a local asset or verified scene export into another workspace.

```bash
npm run --silent tool -- create_object '{"name":"tree_trunk","type":"cylinder","position":[2,1,0],"dimensions":[0.3,2,0.3],"color":"#795548"}'
npm run --silent tool -- list_objects '{}'
npm run --silent tool -- render_scene '{"label":"First observation"}'
```

`render_scene` returns a PNG checkpoint for inspection. `export_scene` writes a `.glb` containing visible scene meshes and materials and returns its artifact URL, file name, and revision. The browser's **Export GLB** action downloads the same artifact. HTTP remains the authoritative interface; the CLI is a thin wrapper. Set `SCENE_API` to change its base URL.

For a repeatable starting construction on a **fresh scene**:

```bash
npm run demo:garden
```

This helper makes public tool calls and captures a first image. It does **not** inspect the image, make a visual correction, or prove the autonomous feedback loop. Those steps belong to the external vision-capable agent.

## Human workspace

- Select objects in the explorer or viewport and apply property edits through the public API.
- Orbit, pan, and zoom locally. **Use current view** commits the camera for future renders.
- Capture checkpoints; compare Before/After views and open each preserved scene JSON.
- Review a checkpoint using **Reviews & feedback**. Approval is a human signal, independent of automated tests.
- Save or load a named scene using the footer. A new server run starts empty; explicitly load a save to continue it.

## Storage and configuration

Named saves: `data/scenes/<name>.json`. Run evidence: `artifacts/runs/<run-id>/`, containing `events.jsonl`, checkpoint scene/PNG/metadata directories, `reviews.jsonl`, generated `review.md` and `tool-feedback.md`, and the last explicitly saved `scene.json`. Each save also gets an immutable provenance record.

Generated output is ignored by Git. Keep artifacts to revisit a run; the live API/UI expose the current run. Older runs remain available on disk. Reusing an existing `RUN_ID` is rejected to protect evidence.

| Variable             | Default                                  | Purpose                                                              |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `PORT`               | `3001`                                   | API / production UI port                                             |
| `VITE_PORT`          | `5173`                                   | Development UI port                                                  |
| `CLIENT_URL`         | Development UI, or production API origin | URL reachable by screenshot browser                                  |
| `DATA_DIR`           | `data`                                   | Named saves and optional local asset catalog (`assets/catalog.json`) |
| `ARTIFACTS_DIR`      | `artifacts/runs`                         | Run directory parent                                                 |
| `RUN_ID`             | Timestamp + random suffix                | New run identifier                                                   |
| `SCENE_API`          | `http://127.0.0.1:3001`                  | CLI / MCP API base                                                   |
| `SCENE_WORKSPACE_ID` | Required UUID for MCP / scene CLI        | Binds one MCP or scene CLI process to an isolated workspace          |

Create a workspace with `npm run workspace -- create --name "House designer" --goal "Build a photorealistic PNW house"`. The command uses a running `SCENE_API` when available or writes directly to local `DATA_DIR` when the app is stopped. Set the returned UUID as `SCENE_WORKSPACE_ID` for that MCP or scene CLI process. Use `npm run workspace -- list` to inspect workspace metadata. The legacy default remains available through the browser and HTTP `/api/*` routes.

For a custom development API port, update the Vite proxy environment as described in the tool guide.

## Verify

```bash
npm run typecheck
npm test
npm run test:api
npm run test:smoke
npm run test:e2e
```

Browser tests build and launch a disposable production server on port 4173, with isolated temporary storage. Screenshots are written to `artifacts/tests/`; failure traces go to `test-results/`. Browser tests verify behavior, not aesthetic quality. A complete MVP review also requires actual PNG inspection, an evidence-based correction, and a fresh-process reload.

See [the MVP verification report](docs/mvp-validation.md) for the checks actually run, visual findings, and local demonstration artifacts.

## Limits

One local user with path-scoped logical workspaces (not an authentication or OS security boundary), five opaque primitives, orthographic and perspective cameras (orthographic by default), flat object hierarchy, and ambient/directional lighting. No grouping, undo, animation, or imported mesh editing. Commands serialize within each workspace; separate workspace queues run independently. Screenshot capture briefly queues tools in its own workspace while read routes remain available. JSON saves and JSONL history are local files, not a transactional database. The MCP bootstrap starts the local app only; it does not install or authenticate the agent CLI.
