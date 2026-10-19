# Development feedback

## Large GLB export used excess browser memory

- Run: `export-memory-20261019T2323Z`; prior failed export execution `575de23b-7ca6-4a2f-8187-3f6577c3d7fd`.
- Evidence: Chromium was killed near 2.8 GiB RSS in the earlier house export. The old path mounted the full viewport and transferred the complete 127 MB GLB as one base64 result.
- Impact: a valid large scene could fail to export under host memory pressure.
- Improvement: use an export-only page, sequential asset loading, chunked transfer to a temporary file, one browser export at a time, and explicit `EXPORT_FAILED` cleanup.
- Verification: six repeated exports of the same saved house succeeded, including three inside a 3 GiB memory-limited scope. Each produced a valid 127,555,884-byte GLB with 27,231 nodes at the same revision. See the run review for the measurement limits.

## Lead designers need a navigable instruction map

- Run: `instruction-guides-20261019T192344Z`, initial OpenCode car and room probes.
- Evidence: the car probe proposed setting the main goal through `update_workspace_context`, which returns `PROJECT_GOAL_ONLY`; the room probe confused object names with asset IDs and placed a door against a solid wall.
- Impact: agents could plan invalid calls or visually ineffective geometry despite having tool schemas.
- Improvement: keep the generated lead overview short, expose topic guides through `get_instruction_guide`, and name these pitfalls in the delegation and scene guides. Require every registered agent-facing API to appear in its assigned guide.
- Verification: fresh OpenCode car and room probes read the guides and corrected both planning mistakes; instruction coverage and API tests passed.

## First render after workdir restart can be blank

- Run: `instruction-guides-20261019T192344Z`, disposable visual scene, two server restarts.
- Evidence: recovered state had two objects at revision 5; the first `render_scene` PNG was blank on both restarts, while the next render showed the objects. The Playwright development server did not reproduce it.
- Impact: a successful render response may give the agent misleading visual evidence after recovery.
- Improvement: isolate the production workdir renderer readiness failure with a reliable regression case, then fix the renderer. Preserve the existing requirement to open the actual PNG.
- Verification: from a fresh workdir restart, the first render should show both objects at the recovered revision across repeated runs. The defect remains open.

## Browser readiness needs clean resource loading

- Run: first Linux smoke attempt during implementation on 2026-10-17.
- Evidence: the rendered box was visible, but the browser console reported a 404 because the application had no favicon. The smoke scenario's console-error assertion failed.
- Impact: a valid visible scene was insufficient to satisfy the browser gate; the same missing resource could reject headless screenshot capture.
- Improvement: include a local favicon and retain network/console checks in `tests/browser/studio.spec.ts`. Keep font assets local as well.
- Verification: the unchanged smoke criteria pass with the favicon present. No policy edits are proposed.

## Review controls need unambiguous accessible names

- Run: first full browser-suite attempt on 2026-10-17.
- Evidence: checkpoint comparison succeeded, but selecting the review checkpoint by its exact accessible label timed out. A wrapping label included the select's option text.
- Impact: impaired automated interaction and unclear assistive-technology targeting.
- Improvement: give the checkpoint and decision selects explicit accessible names; preserve the original browser scenario as regression coverage.
- Verification: the scenario edits an object, renders twice, compares images, selects a review checkpoint, and records feedback using accessible selectors. No instruction changes are needed.
