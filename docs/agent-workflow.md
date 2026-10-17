# External-agent workflow

The coding agent owns reasoning and visual inspection. The server owns scene state and rendering. No model SDK or credentials are embedded in the app.

1. Start a new local run. Read `GET /api/tools` and note the run ID/tool version from `/api/health`.
2. Use this goal: **Create a small Japanese garden with a pond, stone path, three trees, and a wooden bench, viewed isometrically.**
3. Construct using public tools and supported primitives. Use stable IDs rather than names for updates. The optional `npm run demo:garden` helper only creates a reproducible first construction through these tools.
4. Call `render_scene` and **open the returned PNG with your image-viewing tool**. Do not infer image quality from successful API responses, PNG existence, or object counts.
5. Evaluate recognizable pond/path/bench, exactly three distinct trees, framing, visual balance, and unintended overlap. Record concrete observations using `record_review` with the checkpoint ID.
6. Correct an observed issue through public tools, render again, inspect again, and record the result. If the scene already satisfies the goal, use a separate purpose-built defective scene to demonstrate the correction loop; do not make a gratuitous scene change.
7. Save the final garden. Restart into a new run, explicitly load the save, compare object IDs/properties/camera/lighting, and verify a new render works.
8. Record at least one evidence-based tool issue with execution IDs, suggested improvement, and impact. A development pass may subsequently implement reviewed proposals; scene creation must not bypass public tools.
9. Present before/after checkpoints, final scene, review notes, tool feedback, and checks actually run. Automated tests, agent visual assessment, and human approval are separate signals.

Use run-specific artifacts, retain failed checkpoints, and distinguish agent planning errors from application bugs or missing tools. The feedback loop is **not verified** if a vision-capable agent did not actually inspect screenshots and make a justified correction.
