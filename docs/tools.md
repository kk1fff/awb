# Tool contract · version 1

Submit `POST /api/tools` with JSON `{ "tool": "create_object", "arguments": { ... } }`. The maximum request body is 1 MB. Responses always include `success`, a server-generated `executionId`, `sceneRevision`, and either `result` or `error: { code, message, details? }`. Semantic validation failures return HTTP 400; other tool failures return 422. The CLI prints the same envelope and exits nonzero on failure.

Fetch `GET /api/tools` for complete JSON schemas, including validation limits. `GET /api/health` reports run ID and tool version. Read endpoints are `/api/state`, `/api/events`, `/api/checkpoints`, `/api/reviews`, and `/api/checkpoints/<id>/scene`. Reads outside the tool endpoint do not create tool events.

## Coordinates and defaults

Right-handed, Y-up; positions are object centers in world units. Rotations use radians and Euler XYZ order. Dimensions are full local width/height/depth before additional scale. A cylinder/cone has its axis on Y and elliptical X/Z diameters. Spheres can be scaled into ellipsoids. A plane is local XY with no thickness; its depth is ignored. Ground plane example: dimensions `[12,10,1]`, rotation `[-1.5707963267948966,0,0]`.

Object defaults: position/rotation `[0,0,0]`, dimensions/scale `[1,1,1]`, color `#7a9d82`, visible `true`. Dimensions/scales must be positive finite triples, transforms finite triples, color six-digit hex, and name a nonempty string up to 120 characters. IDs are server-generated UUIDs; names need not be unique.

Camera: orthographic; defaults position `[12,12,12]`, target `[0,0,0]`, verticalSize `15` (visible world height at zoom 1). Near/far are `0.1`/`1000`. Position and target must differ. Camera orbit in the live viewport is temporary until **Use current view** is selected. Screenshots use the canonical saved camera.

Lighting defaults: ambient `{color:"#ffffff",intensity:1.5}`, directional `{color:"#fff4dc",intensity:3,position:[8,14,5]}`. Intensities range from 0 to 10. Directional light points toward the world origin. Materials are opaque with fixed roughness and zero metalness.

## Operations

| Tool             | Arguments                                                                                 | Result                                                             |
| ---------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `create_object`  | Required `name`, `type`: box/sphere/cylinder/cone/plane; optional object properties above | Complete object with UUID                                          |
| `update_object`  | Required `id`; any subset of name, position, rotation, dimensions, scale, color, visible  | Updated complete object                                            |
| `delete_object`  | `id`                                                                                      | Deleted ID                                                         |
| `list_objects`   | `{}`                                                                                      | Array of complete object records                                   |
| `inspect_object` | `id`                                                                                      | Complete object record                                             |
| `set_camera`     | Any subset of position, target, verticalSize                                              | Complete canonical camera                                          |
| `set_lighting`   | Partial ambient and/or directional objects; nested fields merge                           | Complete lighting                                                  |
| `render_scene`   | Optional `label`                                                                          | Complete checkpoint metadata, PNG path/URL, snapshot URL, revision |
| `save_scene`     | `name`                                                                                    | Save name, absolute file path, execution ID, revision              |
| `load_scene`     | `name`                                                                                    | Loaded scene with new active revision                              |
| `record_review`  | See below                                                                                 | Persisted review                                                   |

All input objects reject unknown fields. Patch arrays replace whole triples. IDs/types cannot be changed by update. Scene mutations (create/update/delete/camera/lighting/load) increment revision once on success, even if values are unchanged. Read/save/render/review commands preserve revision. Failed commands preserve scene state and revision. This distinction clarifies “accepted command” in the original proposal: only accepted scene mutations advance scene revision.

Saves use schemaVersion `1`; unsupported versions fail explicitly. Save names are 1–80 characters, starting with an alphanumeric character and containing only alphanumeric characters, underscores, and hyphens. Saving the same name replaces that named save atomically; immutable run provenance remains. Loading validates the whole file, including unique IDs, preserves content/IDs, and assigns `current revision + 1` rather than restoring the saved revision. There is no automatic schema migration.

## Render checkpoints

`render_scene` first preserves an immutable scene JSON under the run's checkpoint directory. Playwright loads that exact snapshot at 1024 × 768, device scale 1, waits for the renderer's readiness signal, and captures only the canvas. Readiness is signaled after two rendered frames. The checkpoint revision remains valid after later edits. Compare it to `/api/state` to identify stale images.

On success, result fields include `id`, `label`, `executionId`, `sceneRevision`, `timestamp`, `status:"complete"`, `screenshotPath`, `screenshotUrl`, and `sceneUrl`. PNG paths are local to the server; URLs are relative to the app origin. On failure the API returns `RENDER_FAILED` with checkpoint ID and diagnostics; its snapshot and failed metadata remain available, without a successful screenshot URL.

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

Feedback appears in the human UI and generates per-run `tool-feedback.md`. The MVP never modifies its own tool implementation in response to feedback.

## CLI and errors

```bash
npm run --silent tool -- inspect_object '{"id":"<UUID>"}'
printf '%s' '{"name":"garden"}' | npm run --silent tool -- save_scene
SCENE_API=http://127.0.0.1:3001 npm run --silent tool -- list_objects '{}'
```

Common error codes: `VALIDATION_ERROR` (field-level details), `OBJECT_NOT_FOUND`, `UNKNOWN_TOOL`, `SAVE_NOT_FOUND`, `INVALID_SCENE`, `UNSUPPORTED_VERSION`, `CHECKPOINT_NOT_FOUND`, `CHECKPOINT_INCOMPLETE`, `EXECUTION_NOT_FOUND`, `RENDER_FAILED`, `IO_ERROR`, `HISTORY_WRITE_FAILED`, and `INVALID_REQUEST`. Capture and persist execution IDs when reporting friction.

For custom development ports use `PORT`, `VITE_PORT`, and `CLIENT_URL`; Vite proxies to the configured API `PORT`. Production needs only `PORT` unless its capture URL differs.
