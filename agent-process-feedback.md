# Development feedback

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
