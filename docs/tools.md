# Tool contract · version 2

Submit `POST /api/tools` with JSON `{ "tool": "create_object", "arguments": { ... } }`. The maximum request body is 1 MB. Responses always include `success`, a server-generated `executionId`, `sceneRevision`, and either `result` or `error: { code, message, details? }`. Semantic validation failures return HTTP 400; other tool failures return 422. The CLI prints the same envelope and exits nonzero on failure.

Fetch `GET /api/tools` for complete JSON schemas, including validation limits. `GET /api/health` reports run ID and tool version. Read endpoints are `/api/state`, `/api/events`, `/api/checkpoints`, `/api/reviews`, and `/api/checkpoints/<id>/scene`. `GET /api/stream` is a server-sent event stream with an initial snapshot, tool-start notifications, and updates; clients reconnecting receive a fresh snapshot. Reads outside the tool endpoint do not create tool events.

## Isolated workspaces

The legacy `/api/*` routes and `/artifacts/*` remain the default workspace. Create a logical workspace with `POST /api/workspaces` and `{ "name": "Fir specialist", "goal": "Build a fir submodel", "owner": "agent-name", "acceptanceCriteria": [], "constraints": [] }`; list them with `GET /api/workspaces`. The response includes a UUID `id` and current `runId`. Workspace context is available at `GET /api/workspaces/<id>/context`; update it with `PATCH` using any subset of `goal`, `acceptanceCriteria`, `constraints`, `currentTask`, `workStatus`, and `summary`. `workStatus` is one of `planned`, `working`, `blocked`, `needs_review`, or `done`. Each metadata update increments `metadataRevision`, independently of `sceneRevision`. The browser uses `/?workspace=<id>` and its workspace selector can switch or create a workspace.

Workspaces have separate local catalogs, named saves, scene state, command queues, event streams, checkpoints, reviews, and run artifact directories. Built-in assets are shared read-only. A workspace is reopened lazily from its UUID manifest after restart, with a new unique run ID. Each accepted scene-changing command is committed with a recovery snapshot and pointer; restart restores the exact committed scene revision, including object IDs, before opening the new run. Named saves and prior run evidence persist. Each new run's `run.json` records whether recovery restored a scene and its source execution ID, run ID, and revision, or whether no recovery was needed. If recovery metadata or its current snapshot is corrupt or missing, the app still opens and reports `recoveryError` from health/workspace context; scene mutations, saves, renders, and exports return `RECOVERY_UNAVAILABLE` until recovery is repaired. The app does not silently replace a damaged recovered scene with an empty scene. Workspace separation is a local workflow boundary, not an authentication or operating-system security boundary.

MCP and scene CLI processes require `SCENE_WORKSPACE_ID=<uuid>`; they never fall back to the default workspace and scene tool arguments do not accept a workspace selector. Create/configure a workspace with `npm run workspace -- create --name "Fir specialist" --goal "Build a fir submodel"`, then set the printed UUID in that MCP process environment. The setup command uses a live API when available and otherwise creates directly in local `DATA_DIR`, so it also works before starting the app. Use `npm run workspace -- list` to inspect known workspaces. `SCENE_API` selects the API origin. The legacy default remains available through the web UI and HTTP `/api/*` routes. A specialist can hand off either a local catalog asset or an `export_scene` GLB with `promote_asset` in the target workspace. For example, first call `export_scene` in the source, then in the target call `{ "sourceWorkspaceId": "<source-uuid>", "sourceRunId": "<source-run-id>", "sourceExportExecutionId": "<export-execution-uuid>" }`. For a catalog asset, pass `sourceWorkspaceId` and `sourceAssetId` instead. Promotion copies bytes into the target catalog under a new ID and records the source lineage in the target tool event. A scene export contains all visible scene geometry, so use one specialist workspace per intended submodel.

## Coordinates and defaults

Right-handed, Y-up; positions are object centers in world units. Rotations use radians and Euler XYZ order. Dimensions are full local width/height/depth before additional scale. A cylinder/cone has its axis on Y and elliptical X/Z diameters. Spheres can be scaled into ellipsoids. A plane is local XY with no thickness; its depth is ignored. Ground plane example: dimensions `[12,10,1]`, rotation `[-1.5707963267948966,0,0]`.

Primitive defaults: position/rotation `[0,0,0]`, dimensions/scale `[1,1,1]`, color `#7a9d82`, roughness `0.86`, metalness `0`, visible `true`. Asset objects default to the model's catalog bounds and preserve the model's embedded materials; their default tint is white. Dimensions/scales must be positive finite triples, transforms finite triples, color six-digit hex, roughness and metalness range from 0 to 1, and name is a nonempty string up to 120 characters. IDs are server-generated UUIDs; names need not be unique.

Camera defaults to orthographic at position `[12,12,12]`, target `[0,0,0]`, and verticalSize `15` (visible world height at zoom 1). Perspective is optional, with vertical `fov` in degrees, default `38`, valid range `10`–`100`. `verticalSize` is inactive in perspective mode; `fov` is inactive in orthographic mode. FOV changes do not move the camera; use dolly/zoom to change framing. Near/far are `0.1`/`1000`. Position and target must differ. Camera orbit in the live viewport is temporary until **Use current view** is selected. Screenshots use the canonical saved camera. Schema v2 saves created before projection fields were added load with orthographic projection and 38° FOV defaults.

Lighting defaults: ambient `{color:"#ffffff",intensity:1.5}`, directional `{color:"#fff4dc",intensity:3,position:[8,14,5],shadowSoftness:0}`, and `backgroundMode:"solid"`. Intensities range from 0 to 10. Directional light points toward the world origin. `shadowSoftness` ranges from 0 to 4 and maps to the PCF filter radius `1 + 2 × shadowSoftness`; zero preserves the current radius, while higher values broaden the penumbra without changing shadow-map resolution or bias. `backgroundMode` can be `solid` or `environment`. In solid mode, optional `backgroundColor` selects a six-digit hex background; when omitted, the existing `#e9ede5` (no environment) or `#b9c6c5` (environment selected) fallback is retained. In environment mode, the selected `environmentAssetId` is also shown as the visible sky while continuing to light material reflections; without a selected environment, the solid fallback is shown. Pass `backgroundColor:null` to clear a custom color and `environmentAssetId:null` to clear the environment. These fields are optional in older v2 saves and default to solid background with zero softness.

## Local asset catalog

Search with `search_assets` before placing a model or choosing a material/environment. Search is local and deterministic; it matches all query terms against IDs, names, descriptions, kinds, and tags. Built-in original PNW house/landscape assets and material presets are always available.

User assets live under `DATA_DIR/assets` (default `data/assets`). In the workspace, select **Import a local asset**, choose one file, inspect its preview, set a name and optional comma-separated tags, then add it to the catalog. The app copies it into the local asset directory; it never downloads files from URLs or external catalogs. Imported assets are searchable and usable by agents through the existing `search_assets`, `create_object`, and `set_lighting` tools.

The local upload endpoint is `POST /api/assets/import` with the file bytes as `application/octet-stream` and URL-encoded UTF-8 metadata headers: `X-Asset-Name`, `X-Asset-File-Name`, and `X-Asset-Tags` (a URL-encoded JSON string array). It returns `{ "asset": <catalog record> }` with status 201. Asset imports are local catalog operations, so they do not create scene tool events or change the scene revision. Individual files are limited to 100 MiB. Unsupported, malformed, or extension-mismatched files are rejected without adding a catalog record.

The browser previews GLB models and HDR environments in a small 3D viewer and previews image maps directly before upload. For model records, bounds are derived from the GLB mesh positions and node transforms. Imported catalog records retain the original selected file name as provenance. API clients can still manage a catalog manifest directly if needed. Its entries use this format:

```json
{
  "assets": [
    {
      "id": "local:my-house",
      "name": "My house model",
      "description": "User supplied single-family home",
      "kind": "model",
      "tags": ["house", "pnw"],
      "source": "local",
      "format": "glb",
      "file": "models/my-house.glb",
      "bounds": [8, 5, 6]
    }
  ]
}
```

Supported local files are self-contained glTF 2.0 GLB models with embedded PBR textures; PNG/JPEG/WebP albedo maps for material entries; and Radiance HDR environment maps at least 8 × 4 pixels. Model entries require positive bounds in source units. Material records may set optional `baseColor`, `roughness`, and `metalness`. Files must stay within the asset directory; path traversal and symlink escapes are rejected. The app does not download or bundle third-party assets.

## Operations

| Tool             | Arguments                                                                                                                                | Result                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `create_object`  | Required `name`, `type`: box/sphere/cylinder/cone/plane/asset; asset type requires `assetId`; optional object properties above           | Complete object with UUID                                                    |
| `update_object`  | Required `id`; any subset of name, position, rotation, dimensions, scale, color, visible                                                 | Updated complete object                                                      |
| `delete_object`  | `id`                                                                                                                                     | Deleted ID                                                                   |
| `list_objects`   | `{}`                                                                                                                                     | Array of complete object records                                             |
| `inspect_object` | `id`                                                                                                                                     | Complete object record                                                       |
| `search_assets`  | `query` (defaults empty), optional `kind`: model/material/environment, `limit` (default 20, max 50)                                      | Matching catalog records with stable IDs and placement metadata              |
| `set_camera`     | Any subset of position, target, verticalSize, projection (`orthographic`/`perspective`), fov (vertical degrees, 10–100)                  | Complete canonical camera                                                    |
| `set_lighting`   | Partial ambient/directional objects (including `shadowSoftness`), optional `environmentAssetId`, `backgroundMode`, and `backgroundColor` | Complete lighting                                                            |
| `render_scene`   | Optional `label`                                                                                                                         | Complete checkpoint metadata, PNG path/URL, snapshot URL, revision           |
| `export_scene`   | `{}`                                                                                                                                     | GLB file name, artifact URL, scene revision, visible object count, byte size |
| `save_scene`     | `name`                                                                                                                                   | Save name, absolute file path, execution ID, revision                        |
| `load_scene`     | `name`                                                                                                                                   | Loaded scene with new active revision                                        |
| `record_review`  | See below                                                                                                                                | Persisted review                                                             |

All input objects reject unknown fields. Patch arrays replace whole triples. IDs/types cannot be changed by update. Scene mutations (create/update/delete/camera/lighting/load) increment revision once on success, even if values are unchanged. Read/save/render/export/review commands preserve revision. Failed commands preserve scene state and revision. The browser receives live updates while a command runs and after its result is recorded.

Saves use schemaVersion `2`. Version `1` saves migrate on load, preserving primitive IDs and properties while applying their prior fixed material defaults. Unsupported versions fail explicitly. Save names are 1–80 characters, starting with an alphanumeric character and containing only alphanumeric characters, underscores, and hyphens. Saving the same name replaces that named save atomically; immutable run provenance remains. Loading validates the whole file, including unique IDs and referenced catalog assets, preserves content/IDs, and assigns `current revision + 1` rather than restoring the saved revision.

## Render checkpoints

`render_scene` first preserves an immutable scene JSON under the run's checkpoint directory. Playwright loads that exact snapshot at 1024 × 768, device scale 1, waits for the renderer's readiness signal, and captures only the canvas. Readiness is signaled after two rendered frames. The checkpoint revision remains valid after later edits. Compare it to `/api/state` to identify stale images.

On success, result fields include `id`, `label`, `executionId`, `sceneRevision`, `timestamp`, `status:"complete"`, `screenshotPath`, `screenshotUrl`, and `sceneUrl`. PNG paths are local to the server; URLs are relative to the app origin. On failure the API returns `RENDER_FAILED` with checkpoint ID and diagnostics; its snapshot and failed metadata remain available, without a successful screenshot URL.

## GLB export

`export_scene` writes a binary glTF 2.0 (`.glb`) file under the current run's `exports/` directory. It exports visible scene meshes, transforms, and material colors from the current scene revision. The result includes `format`, `fileName`, `artifactUrl`, `sceneRevision`, `objectCount`, and `bytes`. Exports are immutable run artifacts; the browser's **Export GLB** button triggers the same public tool and downloads its file.

## Evaluations and tool feedback

`record_review` requires `kind`, `author` (`agent` or `human`), and `text`.

- `evaluation`, `approval`, `change_request`: require an existing `checkpointId`. Approvals require a completed render. The review records the checkpoint's revision, while the response envelope still reports the current scene revision.
- `tool_issue`: requires existing `executionIds`, `suggestion`, and `impact`; include the task context and concrete problem in `text`. A checkpoint reference is optional.
- Any review can include `executionIds`; references must exist in the current run. Recorded authors are labels, not authenticated identities.

Example evaluation:

```json
{
  "tool": "record_review",
  "arguments": {
    "kind": "evaluation",
    "author": "agent",
    "checkpointId": "<checkpoint UUID>",
    "text": "The bench overlaps the rightmost tree in this view. Move it toward the front before accepting the scene."
  }
}
```

Example tool feedback:

```json
{
  "tool": "record_review",
  "arguments": {
    "kind": "tool_issue",
    "author": "agent",
    "text": "Placing nine path stones required repeated world-coordinate calculations.",
    "executionIds": ["<creation execution UUID>"],
    "suggestion": "Add distribute_objects with spacing and direction.",
    "impact": "Reduce tool calls and alignment errors."
  }
}
```

Feedback appears in the human UI and generates per-run `tool-feedback.md`. Tool feedback is evidence for a later tool-mode request; it does not silently change the application during scene mode.

## CLI and errors

```bash
npm run --silent tool -- inspect_object '{"id":"<UUID>"}'
printf '%s' '{"name":"garden"}' | npm run --silent tool -- save_scene
SCENE_API=http://127.0.0.1:3001 npm run --silent tool -- list_objects '{}'
```

Common error codes: `VALIDATION_ERROR` (field-level details), `OBJECT_NOT_FOUND`, `UNKNOWN_TOOL`, `SAVE_NOT_FOUND`, `INVALID_SCENE`, `UNSUPPORTED_VERSION`, `CHECKPOINT_NOT_FOUND`, `CHECKPOINT_INCOMPLETE`, `EXECUTION_NOT_FOUND`, `RENDER_FAILED`, `IO_ERROR`, `HISTORY_WRITE_FAILED`, and `INVALID_REQUEST`. Capture and persist execution IDs when reporting friction.

For custom development ports use `PORT`, `VITE_PORT`, and `CLIENT_URL`; Vite proxies to the configured API `PORT`. Production needs only `PORT` unless its capture URL differs.
