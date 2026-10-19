# Local assets, export, and handoff

Use `search_assets` to find local models, material presets, or lighting environments before placing or selecting them. Create a model as an `asset` object with its catalog `assetId`; use a material ID on an object or an environment ID with `set_lighting`. Do not download models, textures, or HDRs. Use locally authored geometry and assets supplied by the human.

The browser can import a local GLB model, PNG/JPEG/WebP material image, or HDR environment. For API import, use `POST /api/assets/import` with the file bytes as `application/octet-stream` and URL-encoded `X-Asset-Name`, `X-Asset-File-Name`, and `X-Asset-Tags` headers. The file stays in the local catalog. Asset uploads do not change the scene revision.

HTTP clients can inspect a catalog record with `GET /api/assets/<id>` and retrieve its local bytes with `GET /api/assets/<id>/file`. Use `search_assets` for ordinary agent discovery.

Use `export_scene` for a GLB of all visible scene geometry. It returns an artifact URL, execution ID, and scene revision. A specialist should keep its session focused on one submodel so that its export contains only intended geometry. Use `export_scene_bundle` for a portable ZIP containing the editable scene, preview, GLB, referenced local assets, and provenance. Import that ZIP into the target workspace through the browser or `POST /api/workspaces/<uuid>/bundles/import`; import creates an editable named save and a placeable catalog model without replacing the active scene.

For asset-bearing scenes, export uses a dedicated browser page and writes the GLB in chunks. Browser exit, timeout, or an invalid GLB returns `EXPORT_FAILED`; a failed export removes partial output when possible and does not change the scene revision. A cleanup failure is reported in the error. Only one browser export runs at a time per server process. A queued export may wait for the current export to finish.

For a same-installation handoff, call `promote_asset` in the target using a source catalog asset ID or the source run and export execution IDs. Promotion copies bytes into the target catalog under a new ID with lineage. Catalogs are isolated by workspace. Inspect the imported result before accepting the handoff. Exact formats, size limits, and response fields are in the `tools` guide.

Agent-facing asset HTTP routes: `POST /api/assets/import`, `GET /api/assets/:id`, `GET /api/assets/:id/file`, and `POST /api/bundles/import`. For a specialist workspace, prefix these paths with `/api/workspaces/:workspaceId` after `/api`; the portable bundle import route is `POST /api/workspaces/:workspaceId/bundles/import`.
