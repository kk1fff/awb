# PNW House Tool Feedback

## Implemented

The tool now supports searchable built-in PNW house and landscape assets, configurable surface materials, local user-provided GLB/HDR/image catalog entries, asset rendering, and GLB export. The UI exposes asset search and placement.

A browser scenario built a Craftsman house through the public API, inspected a render, corrected a misplaced window, rerendered, then saved, reloaded, and exported the scene. Typecheck, 12 unit tests, 14 API tests, browser smoke, and all 6 browser end-to-end tests passed.

Run evidence is in `artifacts/runs/pnw-house-e2e-1792225445815/`: `scene.json`, `events.jsonl`, `before.png`, `after.png`, and `review.md`.

## Remaining limitations

- The built-in procedural house and landscape assets are recognizable but stylized; they are not photorealistic.
- The local asset import and preview workflow already exists. The designer used the documented CLI because this session's connected MCP listing omitted write tools; the CLI successfully called the same public API, so this was host/session integration friction rather than a missing app capability.

## Recommended next step

Improve the in-repo Craftsman and landscape built-ins with more detailed geometry and procedural material variation. Keep the public tool and asset IDs stable; do not rely on downloaded assets.

## Designer first-pass run (2026-10-17)

- **Run:** `run-2026-10-17T19-41-25-322Z-91ea9e2c`; initial scene was empty at revision 0 (`list_objects` execution `d439164e-3f4a-48b7-888c-b9efb684e648`).
- **Catalog evidence:** model search `dd02197c-d3cb-4969-83d1-f4377b1612cc` returned procedural Craftsman shell, gable roof, porch, window, and door, plus PNW trees and landscaping. Material search `a54033da-32dc-424e-97c5-f69071d44c0a` returned cedar siding, shingles, timber, glass, and forest-floor materials; environment search `b74bc6d2-d811-4405-8c46-d3dfb4231f3c` returned overcast lighting.
- **MCP integration friction:** the connected MCP tool list omitted create/update, camera, and lighting tools. The app's documented CLI wrapper reached the same public `/api/tools` API successfully, so this was not a missing app API capability. Initial empty-scene render (`aa0bbd30-338a-4f48-a841-9a50b4739966`, checkpoint `ac245565-47aa-4a77-a8c5-1b899c9f5f2a`) was opened and visually inspected. The MCP-only issue was recorded as review `ff0f6847-184e-46c8-9c1e-9b7cad148e93` before the CLI fallback was confirmed.
- **Designer build:** CLI `create_object` succeeded on first try (`6e8e2d19-be0e-4da0-82ef-62c64b256af3`, revision 1). Built a 17-object PNW Craftsman scene using builtin assets and primitive ground/foundation, with camera and overcast lighting. First house checkpoint `33699c70-781c-48c2-bd63-8c6d0843bd2f` at revision 9 exposed the porch deck hiding the lower door, so the door was raised. Site checkpoint `8ba364fb-b4e0-49bf-b4ad-246facdb1b9d` at revision 22 showed evergreen crowns clipped and dark ground, so tree scale and fill light were adjusted. Corrected checkpoint `f89d9bc1-9500-428b-a0b1-12f07be0946c` at revision 26 was opened and visually inspected.
- **Outcome and remaining limitation:** the scene is a readable Craftsman with porch, paired windows, stone path, three Douglas firs, boulder, ferns, moss ground, and basalt foundation. It remains plainly low-poly and is not photorealistic: cedar reads as uniform orange-brown, the shingle roof as nearly black, trees are conical tiered shapes, and ground cover is sparse. Review `fd7da565-8c58-4239-bcd4-cb93db67e97e` requests richer locally authored geometry and material variation. A controlled browser regression now renders the same fixed object and camera at lighting values `(ambient 0, directional 0)`, `(8, 0)`, and `(0, 8)`; both public controls produce a meaningful visible image change. The comparison did not establish a renderer defect, so renderer behavior remains unchanged. Final evaluation is review `4d6c9583-0830-4861-a13d-b1628352a2aa`; the scene does not meet the photorealism goal.
- **Persistence/export:** saved as `pnw-craftsman-first-pass` at revision 26 (execution `08f5e413-cded-4992-8ce1-c1ab4d87d05e`, `data/scenes/pnw-craftsman-first-pass.json`); GLB export execution `304285fb-fa17-4692-b48a-5a1b3bd53eb3`, 17 objects, 1,557,240 bytes. Reload succeeded and preserved object IDs/properties (execution `ef6ecf78-053c-4563-90df-2c80e75dda45`, revision 27). Checkpoints are under `artifacts/runs/run-2026-10-17T19-41-25-322Z-91ea9e2c/checkpoints/`. No application tests were run by the designer.
