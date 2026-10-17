# Fieldwork · Agent World Builder

A local 3D workspace for an external AI agent to create, render, inspect, and revise scenes. Humans see the same scene, inspect objects, compare immutable checkpoints, and record feedback.

## Run

Requires Node.js 22.12+ and npm. Install the matched browser once:

```bash
npm ci
npx playwright install chromium
npm run dev
```

Open **http://127.0.0.1:5173**. The tool API listens at **http://127.0.0.1:3001**. On a minimal Linux host, install browser OS dependencies using `npx playwright install --with-deps chromium` if browser startup reports missing libraries.

Production-style local launch:

```bash
npm run build
npm start
```

Then open http://127.0.0.1:3001. No model credentials are needed. The application binds to localhost and has no authentication; it is intended for local use.

## Give this to your coding agent

Read [the tool contract](docs/tools.md) and [agent workflow](docs/agent-workflow.md). Discover machine-readable schemas with `GET /api/tools`. Manipulate scenes only through these tools; do not edit scene JSON or renderer source to create the scene.

```bash
npm run --silent tool -- create_object '{"name":"tree_trunk","type":"cylinder","position":[2,1,0],"dimensions":[0.3,2,0.3],"color":"#795548"}'
npm run --silent tool -- list_objects '{}'
npm run --silent tool -- render_scene '{"label":"First observation"}'
```

Open the returned `screenshotPath` with your agent's image viewer. Diagnose the image, use `update_object` or camera/lighting tools, rerender, and record your assessment with `record_review`. HTTP is the authoritative interface; the CLI is a thin wrapper. Set `SCENE_API` to change its base URL.

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

| Variable        | Default                                  | Purpose                             |
| --------------- | ---------------------------------------- | ----------------------------------- |
| `PORT`          | `3001`                                   | API / production UI port            |
| `VITE_PORT`     | `5173`                                   | Development UI port                 |
| `CLIENT_URL`    | Development UI, or production API origin | URL reachable by screenshot browser |
| `DATA_DIR`      | `data`                                   | Named saves                         |
| `ARTIFACTS_DIR` | `artifacts/runs`                         | Run directory parent                |
| `RUN_ID`        | Timestamp + random suffix                | New run identifier                  |
| `SCENE_API`     | `http://127.0.0.1:3001`                  | CLI / demo API base                 |

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

One local user, one active scene per process, five opaque primitives, an orthographic camera, flat object hierarchy, and ambient/directional lighting. No grouping, undo, animation, imported meshes, automatic tool changes, or embedded agent runner. Commands are serialized; screenshot capture briefly queues subsequent tools while read routes remain available. JSON saves and JSONL history are local files, not a transactional database.
