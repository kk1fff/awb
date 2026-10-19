# Render, inspect, correct, and preserve evidence

After building the requested scene, call `render_scene`. Its result identifies a checkpoint, execution ID, scene revision, and PNG location. **Open the PNG itself** before claiming visual quality. Check whether requested objects are recognizable and visible, framing is legible, materials and geometry make sense, and objects do not overlap unintentionally. A successful API response or generated file alone is not visual inspection.

Describe concrete observations. Make an evidence-based correction through public scene tools, render again, and inspect the new PNG. If the first image fully meets the criteria, use a separate known-defect test scene for a correction-loop test; do not invent a gratuitous change. Use `record_review` with the checkpoint ID for evaluations and approvals. Record reproducible tool friction as a `tool_issue` with execution IDs, impact, and a proposed change. Distinguish scene quality from tool quality.

Save the editable result with `save_scene`; reload with `load_scene` and verify object IDs, count, key properties, and renderability. Each accepted scene mutation increments `sceneRevision`; read, render, export, save, and review operations preserve it. Check a screenshot's revision against current state before treating it as current. Run artifacts contain scene snapshots, PNGs, events, and review notes. A fresh server run restores the last committed scene if recovery succeeds. If workspace context reports `recoveryError`, stop scene mutations and report it.

HTTP clients can inspect `GET /api/events`, `/api/reviews`, `/api/checkpoints`, and `/api/checkpoints/<id>/scene` without creating new tool events. Use these records to tie observations to the correct execution and revision.

For the PNW house task, judge the actual image against photographic plausibility: construction scale and detail, natural varied foliage and ground, coherent soft daylight, perspective, framing, and no obvious missing or overlapping elements. Say if it remains stylized. Do not lower the task's acceptance bar because save or export succeeds.

Evidence HTTP routes: `GET /api/events`, `GET /api/reviews`, `GET /api/checkpoints`, and `GET /api/checkpoints/:id/scene`. Specialist routes use the workspace prefix described in the `tools` guide.
