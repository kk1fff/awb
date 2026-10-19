# AGENTS.md — Agent-Native 3D Scene Builder

## Mission

Build a Linux-compatible 3D scene builder with two clear agent modes: **build a scene using public tools**, or **improve the tool itself** when the user asks for product or interface changes. Make the agent's work and resulting scene observable to a human.

**Priority:** working end-to-end loop > reliable tooling > inspectable evidence > additional features. Keep scope achievable in one focused coding session.

## Scope and boundaries

- Stack: TypeScript, Node.js, Vite, React, Three.js, Playwright. Scene files are JSON; execution events are JSONL.
- MVP primitives: box, sphere, cylinder, cone, plane; transforms, colors, camera, lighting, save/load, screenshot.
- The server owns authoritative scene state. UI and agents submit commands through the _same_ public command API.
- No physics, imported mesh editing, Blender, Rust, Electron/Tauri, or multi-agent orchestration.
- In **scene mode**, use the public tools and never edit saved scene JSON or renderer source to work around missing capabilities; record concrete limitations as tool feedback. In **tool mode**, change application source only when the user's request calls for a tool, interface, or workflow change, then verify the result.

## Starting from a fresh clone

- The human starts Fieldwork with `./start.sh --workdir <project-dir>`, then launches Codex, Claude Code, or OpenCode in the provided shell. Infer the mode from the human's request; scene creation/editing is scene mode, while requests to change capabilities, bugs, UI, or workflow are tool mode.
- If the request mixes modes or the intended result is unclear, ask one short, specific clarification before making changes. Do not make product changes as a side effect of scene creation.
- The launcher starts the local app, prepares project-scoped MCP configuration, and prints the browser URL. Use the `fieldwork` MCP tools for scene work. Record the human's goal with `update_project_info` if `get_project_info` reports an empty goal. Node.js 22.12+ and an installed, signed-in agent CLI are host prerequisites.
- In a workdir project, the human-launched agent is the lead designer. For substantial scenes, divide independent parts among host-runtime specialist agents when doing so improves detail. Reserve a Fieldwork designer slot before spawning each specialist; the specialist opens and completes its own session, and the lead reviews the handoff and confirms closure. `--concurrent` defaults to four designers total, including the lead. Fieldwork tracks sessions; the host runtime creates and communicates with subagents.
- For tool mode, inspect this repository and its tests first. Start the app/browser when the change affects visible behavior or needs an end-to-end check.

## Working agreements

1. Inspect repository structure, existing scripts, tests, and `git status` before making changes. Do not overwrite unrelated edits.
2. State the smallest next objective and its acceptance criteria before a substantial change. Prefer a vertical slice over speculative abstractions.
3. Keep each change small and reviewable. Preserve API compatibility unless a deliberate, documented change is needed.
4. Never declare a feature done based solely on compilation or a successful HTTP response. Verify the actual app behavior when a browser, renderer, or agent tool is involved.
5. Do not silently change acceptance criteria to make a test pass. Do not weaken or skip failing tests without recording the reason.
6. Never claim to have visually verified a render unless a screenshot was actually opened/inspected. A generated PNG alone is not visual verification.
7. Keep commands non-destructive and local. Ask for human authorization before destructive actions, publishing, external deployment, or irreversible changes.

## Core product contract

Expose documented, validated operations (names can be adapted consistently):
`create_object`, `update_object`, `delete_object`, `list_objects`, `inspect_object`, `set_camera`, `set_lighting`, `render_scene`, `export_scene`, `save_scene`, `load_scene`, `record_review`.

Scene-changing commands return `{success, sceneRevision, result | error}` with stable object IDs and actionable validation errors. Each accepted state change increments the scene revision. Record every command with execution ID, timestamp, operation, arguments, result/error, and revision. Screenshots, GLB exports, and saved scenes must be tied to an execution ID and revision. Tool consumers must be able to tell stale results from current results.

## Development loop (repeat for every vertical slice)

1. **Baseline:** `git status`; install dependencies if needed; discover scripts from `package.json`. Run existing fast checks and note any pre-existing failures.
2. **Implement:** make the smallest change that meets one explicit acceptance criterion. Add or update an automated test alongside the change.
3. **Fast feedback:** run typecheck, lint (if configured), and relevant unit/API tests. Fix failures before UI testing.
4. **Run the real app:** start server + Vite using documented commands. Confirm ports, readiness, and errors. Use a disposable scene/test execution ID; do not mutate the demo or a human's saved work during tests.
5. **Exercise the public interface:** create/edit/inspect/save/load via the same tool endpoint used by agents. Assert returned revisions and scene objects, not merely 2xx status codes.
6. **Inspect visible behavior:** open the browser with Playwright, load the scene, capture a screenshot, and actually inspect the image. Check that expected objects are visible, framing is sensible, and browser/server consoles show no unexpected errors.
7. **Close the loop:** if inspection reveals a defect, classify it (app bug, agent planning error, missing tool, ambiguous contract, or evaluator weakness), gather evidence, fix only the relevant cause, and rerun the appropriate tests **plus** the original failing end-to-end scenario.
8. **Checkpoint:** save scene JSON, PNG, event log, and a short evaluation note under a run-specific artifact directory. Report outcome to the human.

## Test ladder

Use the cheapest meaningful test first, then expand scope after passing:

| Level            | When                                                          | Minimum assertion                                                              |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Static           | Every code change                                             | Typecheck; lint if configured                                                  |
| Unit             | Every changed pure module                                     | Geometry/schema/command invariants                                             |
| API integration  | Every tool or persistence change                              | Real request → valid response → correct scene state/revision                   |
| Browser smoke    | Every viewport/render/UI change                               | Scene loads; no console errors; expected objects visible                       |
| Agent end-to-end | Every agent API/tool-contract change; before milestones       | Agent uses public tools, observes PNG, makes at least one justified correction |
| Regression       | Before commit of an integrated slice and before claiming done | Previously passing scenarios still pass                                        |

Provide stable repository scripts as they become available, ideally `npm run typecheck`, `npm test`, `npm run test:api`, `npm run test:e2e`, `npm run dev`, and `npm run test:smoke`. **Do not invent scripts or report unrun commands as passed.** If a script does not exist, implement it when in scope or document the actual command used.

## Reference end-to-end scenario

Use a fixed, repeatable prompt: **"Create a small Japanese garden with a pond, stone path, three trees, and a wooden bench, viewed isometrically."**

1. Create a clean scene through the public API; record initial revision and tool version.
2. Have the agent build with supported primitives only. Store all tool calls.
3. Render a PNG at a known viewport size and camera configuration; associate it with the scene revision.
4. Inspect the actual PNG, and compare against explicit criteria: recognizable pond, path, three distinct trees, bench, legible framing, no obvious unintended overlap or missing objects. Do not use a pixel-exact screenshot comparison for aesthetic judgments.
5. Require the agent to state concrete observations and make **at least one evidence-based correction** through the public API; rerender and re-inspect. Do not introduce a gratuitous change merely to satisfy the count—if the first render is fully satisfactory, use a purpose-built test scene with a known defect instead.
6. Save the scene; reload into a fresh process/session; verify object IDs, properties, count, and renderability.
7. Persist the result as `artifacts/runs/<run-id>/` containing `scene.json`, `before.png`, `after.png`, `events.jsonl`, and `review.md` (or equivalents). Do not commit large generated artifacts by default; keep representative lightweight fixtures when useful.

If a true autonomous agent or vision-capable inspection is unavailable, run the deterministic API/browser checks and explicitly mark the autonomous visual loop **not verified**; don't claim equivalent coverage.

## When to change application code vs. retry

- **Retry without code changes** for transient launch/port issues, incomplete agent instructions, recoverable bad tool arguments, or poor agent decisions when existing tools suffice. Limit identical retries; after two unchanged failures, investigate rather than blindly repeating.
- **Fix code** when the same valid operation reliably produces wrong state, a reproducible exception, an incorrect render, a persistence mismatch, or violation of the documented API. First write a minimal reproducer/regression test.
- **Propose a tool/interface change** when the task is possible but requires fragile workarounds, too many operations, unclear semantics, or missing observations. Record supporting calls, friction, expected benefit, and alternative solutions in `tool-feedback.md`. Do not automatically widen the MVP.
- **Investigate evaluation** when screenshots and structured state disagree or the pass criteria fail to reflect what a human sees. Do not modify the evaluator simply to pass the current run.

After a fix: rerun (1) the smallest reproducer, (2) the affected module/API tests, (3) the same end-to-end scenario from a **fresh scene** using the original goal and unchanged pass criteria, then (4) the regression suite. Capture new artifacts and compare against the failure. If a test is flaky, record the seed, viewport, versions, logs, and frequency; don't label it fixed after one lucky pass.

## Git commit policy

- Commit at **verified vertical-slice boundaries**, not at arbitrary time intervals: initial working skeleton, usable scene commands, working renderer/screenshot, completed agent visual loop, human checkpoint UI.
- Before each commit: inspect `git diff` and `git status`; run relevant fast checks and the affected integration/smoke tests; ensure no secrets, local credentials, or accidental large artifacts are staged.
- Commit only files belonging to the verified slice, with an imperative message, e.g. `feat(scene): add validated object creation` or `test(agent): cover render-inspect-revise loop`.
- Make a final checkpoint commit after the full MVP end-to-end test passes. If unfinished or blocked, report the failing checks and leave work clearly identified; don't create a misleading "done" commit.
- Never force-push, rewrite shared history, discard user edits, or commit generated test outputs without a reason. If git commits are not authorized in the execution environment, prepare a reviewed diff and state that no commit was made.

## Human checkpoints

Request or present human review at three meaningful points:

1. **Tool contract:** sample requests/responses and supported limits before enlarging the API.
2. **First visible scene:** live viewport + screenshot + object tree; what works and what doesn't.
3. **MVP completion:** before/after screenshots, reproducible scene, test results, tool-call trace, and top tool-improvement recommendations.

A human should be able to distinguish **product quality** (the generated scene) from **tool quality** (whether the agent could produce and inspect it efficiently). Human acceptance is a separate signal from automated checks.

## Evolving this AGENTS.md

Treat this file as an experiment-backed operational policy, **not** a log and not an invitation for unrestricted self-rewriting.

1. During development, collect concrete friction and recurring mistakes in `agent-process-feedback.md` with: problem, run ID, evidence, impact, proposed rule, and a way to verify improvement.
2. Propose an `AGENTS.md` edit only when it fixes repeated ambiguity, prevents a demonstrated failure, or simplifies a proven cumbersome workflow. Prefer changing executable tests/scripts for enforceable behavior rather than adding prose rules.
3. Keep proposals small and scoped. Write the proposed diff and rationale; preserve the mission, safety boundaries, test obligations, and human checkpoints.
4. **Human approval is required before changing policies governing commits, test gates, evaluator integrity, permissions, safety, or the agent's authority to modify itself.** Other editorial clarifications can be made as part of normal development but must be called out in the summary.
5. After an approved substantive change, rerun the scenario that motivated it and verify no regression. Include the instruction change in a dedicated, descriptive commit (for example `docs(agent): clarify visual inspection gate`).
6. Do not alter instructions during a failing run just to redefine success. Never remove a requirement merely because it is inconvenient.

## End-of-session report

Provide: **what works; what was actually run; pass/fail/untested; links or paths to screenshots/scenes/logs; observed visual issues; tool friction and proposed changes; commits created; remaining blockers; one recommended next slice.** Differentiate observations from assumptions. If the full agent loop was not executed, say so explicitly.
