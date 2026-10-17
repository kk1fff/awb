# Tool Feedback: PNW House Build

## Run

- Run ID: `pnw-house-e2e-1792225445815`
- Evidence: [`artifacts/runs/pnw-house-e2e-1792225445815/events.jsonl`](artifacts/runs/pnw-house-e2e-1792225445815/events.jsonl), [`scene.json`](artifacts/runs/pnw-house-e2e-1792225445815/scene.json), [`before.png`](artifacts/runs/pnw-house-e2e-1792225445815/before.png), and [`after.png`](artifacts/runs/pnw-house-e2e-1792225445815/after.png).

## Friction and result

- Prior to the asset catalog and PBR/material support, the documented primitive-only API could not produce siding, shingles, divided-light windows, glass, or a covered porch with coherent materials. The new public `search_assets`, asset-object, material, and environment support let the browser scenario build and export the house using tool commands.
- The first render placed a window in the entry area. Inspection showed the overlap; moving the window to flank the porch corrected it. The scene was then rendered again and saved/reloaded successfully.
- The original built-in procedural models make a recognizable Craftsman house, but foliage and architectural detail remain stylized. They do not meet a photorealistic standard. Local GLB/HDR/image catalog references are supported, but populating that catalog requires filesystem access and a JSON manifest; there is no in-app asset import flow.

## Proposed next improvement

Add an in-app local asset catalog workflow that validates user-selected GLB, HDR, and image files, previews them, and writes the same catalog format used by `search_assets`. Keep file ownership local and preserve asset provenance. This would reduce setup friction and let agents use realistic user-provided models and textures without widening the tool contract further.

## Verification

The current catalog path is covered by API tests for model/material/environment search and path safety. The house browser scenario verifies create, render, evidence-based correction, rerender, save/load, and GLB export. A signed-in autonomous agent loop was unavailable in this session; the deterministic public API flow passed, while autonomous agent execution remains unverified.
