# PNW House Tool Feedback

## Implemented

The tool now supports searchable built-in PNW house and landscape assets, configurable surface materials, local user-provided GLB/HDR/image catalog entries, asset rendering, and GLB export. The UI exposes asset search and placement.

A browser scenario built a Craftsman house through the public API, inspected a render, corrected a misplaced window, rerendered, then saved, reloaded, and exported the scene. Typecheck, 12 unit tests, 14 API tests, browser smoke, and all 6 browser end-to-end tests passed.

Run evidence is in `artifacts/runs/pnw-house-e2e-1792225445815/`: `scene.json`, `events.jsonl`, `before.png`, `after.png`, and `review.md`.

## Remaining limitations

- The built-in procedural house and landscape assets are recognizable but stylized; they are not photorealistic.
- Adding user-owned assets currently requires editing a local catalog manifest. There is no in-app import and preview workflow.
- The connected Fieldwork tools in this session did not expose object creation or asset search, so a fully autonomous MCP agent build was not verified. The scripted browser scenario exercised the public API.

## Recommended next step

Add a local asset import and preview workflow for GLB, HDR, and texture files, then repeat the house task with a connected autonomous agent and inspect its screenshots.
