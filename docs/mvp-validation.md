# MVP verification · 2026-10-17

The external coding agent in this implementation session completed the public-tool create → render → inspect → diagnose → revise loop. It opened actual before/after PNGs in its image viewer, recorded observations, and made corrections through the HTTP tool API. The construction helper alone was not counted as visual verification.

## Checks actually run

| Check                    | Result                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`      | Passed                                                                                                                                                                |
| `npm test`               | 11 unit tests passed                                                                                                                                                  |
| `npm run test:api`       | 10 API tests passed                                                                                                                                                   |
| `npm run test:e2e`       | 4 browser tests passed, including the Linux Chromium smoke scenario                                                                                                   |
| `npm run format:check`   | Passed                                                                                                                                                                |
| Production build         | Passed as part of the browser suite; Vite reports a large Three.js bundle warning                                                                                     |
| Real garden visual loop  | Passed; repeated from a fresh scene after the viewport fix                                                                                                            |
| Fresh-process save/load  | Passed; all 48 object IDs/properties, camera, lighting and schema matched                                                                                             |
| Fresh-process screenshot | Captured and opened; matches the corrected scene                                                                                                                      |
| Human approval           | Approved in the live workspace at 2026-10-17 07:20:57 UTC; checkpoint `57ea4d5d-0500-4963-b79f-8809e5aabf4f`, review execution `ea664da2-c957-4c9c-b28a-7ffbbd020d9b` |

Runtime: Node.js 22.23.3 on Linux, npm 10.9.9, Playwright 1.64.1 with its downloaded Chromium. Browser interaction checks cover object editing, real tool-driven captures, immutable snapshots, comparisons, human review submission, local camera preservation across object changes, explicit camera commits, and visible invalid-checkpoint errors. Storage tests cover missing/corrupt/unsupported saves, save I/O failures, and scene rollback when history cannot be written.

## Final demonstration evidence

Run: `run-2026-10-17T07-15-26-803Z-f830f079`.

- [Before image](../artifacts/runs/run-2026-10-17T07-15-26-803Z-f830f079/before.png): revision 50, checkpoint `87c80c64-7acd-4743-8e3d-5eaac9ff9018`.
- [After image](../artifacts/runs/run-2026-10-17T07-15-26-803Z-f830f079/after.png): revision 70, checkpoint `57ea4d5d-0500-4963-b79f-8809e5aabf4f`.
- [Final editable scene](../artifacts/runs/run-2026-10-17T07-15-26-803Z-f830f079/scene.json): 48 objects; named save `garden`.
- [Tool history](../artifacts/runs/run-2026-10-17T07-15-26-803Z-f830f079/events.jsonl): 80 invocations.
- [Evaluations](../artifacts/runs/run-2026-10-17T07-15-26-803Z-f830f079/review.md): two image assessments and two tool issues.
- [Tool feedback](../artifacts/runs/run-2026-10-17T07-15-26-803Z-f830f079/tool-feedback.md): execution-backed improvement proposals.
- [Workspace](../artifacts/runs/run-2026-10-17T07-15-26-803Z-f830f079/workspace.png), [comparison view](../artifacts/runs/run-2026-10-17T07-15-26-803Z-f830f079/comparison.png), and [feedback view](../artifacts/runs/run-2026-10-17T07-15-26-803Z-f830f079/feedback.png).

These generated files remain local and ignored by Git. The live development workspace was left running at `http://127.0.0.1:5173`, with the tool API at port 3001.

## Visual findings and interface friction

The first garden contained a recognizable pond, continuous stepping-stone path, three distinct trees, wooden bench, and stone lantern, with no clipped objects. Two improvements followed actual image inspection: darken the pale path stones for lawn contrast and rotate the bench toward the pond. The corrected image retains all required elements and a coherent bench assembly.

Nine separate calls were needed for the shared stone color change. Rotating the eleven-piece bench required explicit pivot calculations and eleven position/rotation updates. Recommended next slice: review and implement validated bulk property updates; evaluate grouping/pivot transforms afterward. Both suggestions cite the exact calls in the generated feedback document. Neither capability was silently added to the MVP.

Fresh-process verification used a separately launched production server: `run-2026-10-17T07-16-51-787Z-7da389bf`. Loading `garden` assigned revision 1 while preserving scene content and IDs. Its [rendered PNG](../artifacts/runs/run-2026-10-17T07-16-51-787Z-7da389bf/checkpoints/d003204f-3293-411f-8b35-0d169bc60df7/scene.png) was opened and inspected.

## Practical limits

No functional blockers remain in the tested local MVP. The user approved the garden in the live workspace; the approval is recorded in the run history against the final checkpoint. Persistence uses local files rather than cross-file database transactions; named saves are atomic, but a process interruption can leave incomplete ancillary artifacts. Only the current run is exposed in the live UI; previous run evidence is retained on disk. The Three.js bundle size is a load-time optimization opportunity. No lint tool is configured, and no multi-user, remote-access, or non-Chromium compatibility claim is made.
