# Proposal: Agent-Native 3D Scene Builder

**Status:** MVP Proposal  
**Target:** One night of agent-assisted development  
**Platform:** Browser-based, Linux-compatible  
**Initial Stack:** TypeScript, Three.js, Vite

## 1. Overview

Build a lightweight 3D scene editor designed primarily for autonomous AI agents.

Unlike traditional modeling applications, the primary interaction is a structured tool interface. Agents can construct scenes, inspect rendered results, diagnose problems, and iteratively improve their work.

Humans can observe the process, inspect the resulting scene, and provide feedback at checkpoints.

The first milestone is not a sophisticated 3D editor. It is a working demonstration of an **autonomous creation and feedback loop**.

## 2. Objectives

### Primary: Agent Development Loop

Enable an agent to independently:

1. Understand a scene creation goal.
2. Manipulate the scene through documented tools.
3. Render and visually inspect the result.
4. Evaluate whether the result satisfies the goal.
5. Diagnose problems and make corrections.
6. Repeat until satisfied or the execution budget is exhausted.

### Secondary: Tool Improvement Loop

Enable an agent to evaluate its own development tools:

1. Identify missing or inconvenient capabilities.
2. Record concrete examples of tool limitations.
3. Suggest improvements to the tool interface.
4. Allow humans to review proposed changes.

Future versions may allow agents to implement and benchmark tool improvements autonomously.

### Third: Human Observation and Checkpoints

Provide a human-readable interface to:

- View and interact with the current 3D scene.
- Inspect the scene's object hierarchy.
- Review agent operations and execution history.
- Compare intermediate and final results.
- Approve results or request further changes.

## 3. MVP Demo

### Example Task

> Create a small Japanese garden containing a pond, a stone path, three trees, and a wooden bench. Make the scene visually balanced and easy to understand from an isometric camera angle.

### Expected Behavior

1. Agent creates a ground plane.
2. Agent constructs the pond, path, trees, and bench using basic geometric primitives.
3. Agent positions the camera and lighting.
4. Agent captures a screenshot.
5. Agent inspects the screenshot and identifies visual problems.
6. Agent adjusts object positions, sizes, or materials.
7. Agent renders again.
8. Agent presents the result and records any tool limitations encountered.

### Success Criteria

- An agent successfully creates a recognizable 3D scene.
- At least one visual feedback and correction cycle is demonstrated.
- The final scene remains editable.
- A human can inspect the result and execution history.
- The agent produces actionable feedback about the tool interface.

## 4. System Architecture

```text
                 Human
                   |
            Goal / Feedback
                   |
                   v
             AI Agent
          (Claude Code, etc.)
                   |
          Structured Tool API
                   |
                   v
        +----------------------+
        |    Scene Engine      |
        |                      |
        |  Create Objects      |
        |  Update Objects      |
        |  Delete Objects      |
        |  Inspect Scene       |
        |  Save / Load Scene   |
        +----------------------+
                   |
                   v
            Three.js Renderer
                   |
              +----+----+
              |         |
              v         v
          Screenshot  Live Viewport
              |         |
              v         v
           AI Agent    Human
           Inspection  Review
              |
              v
       Diagnose and Retry
```

The application supports two separate feedback loops:

**Product Loop**

```text
Goal → Tool Operations → Render
                         |
                         v
                    Agent Inspection
                         |
                    Diagnose / Fix
                         |
                         +──→ Tool Operations
```

**Tool Improvement Loop**

```text
Tool Usage → Identify Friction
                  |
                  v
          Record Tool Feedback
                  |
                  v
          Propose Improvements
                  |
                  v
            Human Review
```

Both loops should produce human-observable artifacts.

## 5. Technology Stack

| Component | Technology | Purpose |
|---|---|---|
| Language | TypeScript | Shared types and implementation |
| Frontend | React + Vite | Human-facing application |
| 3D Engine | Three.js | Scene construction and rendering |
| Backend | Node.js | Tool execution and persistence |
| Agent Integration | CLI / HTTP JSON API | Agent-controlled scene operations |
| Scene Persistence | JSON files | Editable, reproducible scenes |
| Screenshot Capture | Playwright | Headless rendering and screenshots |
| Execution History | JSONL | Record agent operations |

### Architectural Principles

- **Agent-first:** All core scene operations must be available without interacting with the GUI.
- **Headless-capable:** Scene creation and rendering must work on a Linux server without a visible desktop.
- **Single source of truth:** The backend owns the canonical scene state. The frontend renders that state.
- **Shared operations:** Human edits and agent edits use the same scene command interface.
- **Observable:** Tool operations, results, and scene revisions can be inspected.
- **Extensible:** The scene engine and agent interface remain separate.

Electron, Tauri, Rust, and physics simulation are deliberately excluded from the initial MVP.

## 6. MVP Tool Interface

Expose a small set of structured operations:

| Tool | Description |
|---|---|
| `create_object` | Create a geometric primitive |
| `update_object` | Modify transform, material, or properties |
| `delete_object` | Remove an object |
| `list_objects` | Return scene objects and identifiers |
| `inspect_object` | Return detailed object properties |
| `set_camera` | Configure camera position and target |
| `set_lighting` | Configure basic scene lighting |
| `render_scene` | Capture a screenshot and return its file path |
| `save_scene` | Persist the current scene |
| `load_scene` | Restore a previously saved scene |

### Supported Geometry

- Box
- Sphere
- Cylinder
- Cone
- Plane

Each object supports:

- Stable unique identifier
- Human-readable name
- Position, rotation, and scale
- Basic material color
- Visibility

### Example Tool Call

```json
{
  "tool": "create_object",
  "arguments": {
    "name": "tree_trunk_1",
    "type": "cylinder",
    "position": [2, 1, 0],
    "dimensions": [0.3, 2, 0.3],
    "color": "#795548"
  }
}
```

Tool inputs must be validated. Invalid operations should return structured, actionable errors.

Agents must manipulate scenes through the public tool interface rather than directly editing scene files.

## 7. Human Interface

A minimal browser application should contain three areas:

**3D Viewport**
- Interactive camera controls.
- Live rendering of the scene.
- Ability to inspect the generated artifact.

**Scene Inspector**
- Object hierarchy.
- Selected object properties.
- Current scene revision.

**Agent Activity**
- Chronological tool execution log.
- Render checkpoints.
- Recorded failures and corrections.
- Tool improvement suggestions.

Advanced mesh editing and visual modeling controls are not required.

## 8. Observability and Checkpoints

Every meaningful agent operation should record:

- Timestamp and execution ID
- Tool name and arguments
- Success or failure
- Result or error
- Scene revision
- Associated screenshot when applicable

At checkpoints, preserve:

1. Scene JSON snapshot.
2. Rendered screenshot.
3. Agent's evaluation of the result.
4. Human feedback, if any.

The agent should be able to revisit previous checkpoints to understand what changed.

For the MVP, a chronological event log and saved snapshots are sufficient. Full deterministic replay and execution branching are future capabilities.

## 9. Tool Improvement Feedback

Introduce a simple structured feedback document, `tool-feedback.md`.

For each issue, record:

```markdown
### Issue: Difficult Object Alignment

Task:
Arrange four chairs evenly around a table.

Problem:
Required many individual position calculations
and update operations.

Suggested Improvement:
Introduce align_objects or distribute_objects.

Impact:
Reduce tool calls and positioning errors.

Evidence:
Execution ID / tool call references.
```

The tool improvement loop is observational in the first version. Agents may suggest changes, but automatic modifications to the tool implementation are out of scope.

## 10. Implementation Plan

### Phase 1 — Scene Engine

- Create the TypeScript project.
- Define a versioned scene JSON schema.
- Implement basic primitives and object transforms.
- Implement scene persistence.
- Expose the tool API.

### Phase 2 — Visualization

- Build the Three.js viewport.
- Display objects from canonical scene state.
- Add orbit camera controls.
- Implement screenshot capture using Playwright.

### Phase 3 — Agent Integration

- Document tool schemas and usage.
- Connect an AI coding agent through the CLI or HTTP API.
- Execute the Japanese garden demo.
- Enable screenshot inspection and iterative corrections.

### Phase 4 — Human Observability

- Add the scene object inspector.
- Record tool execution history.
- Store scene and screenshot checkpoints.
- Display agent activity.

### Phase 5 — End-to-End Validation

- Run the full autonomous development loop.
- Verify scene persistence and reload.
- Review the final artifact.
- Generate `tool-feedback.md`.
- Document limitations and next steps.

## 11. Definition of Done

- [ ] Browser displays an interactive 3D scene.
- [ ] Agent can create, modify, and delete scene objects.
- [ ] All core operations use the documented tool interface.
- [ ] Agent can render a scene and access its screenshot.
- [ ] Agent performs at least one correction based on visual inspection.
- [ ] Scene can be saved and restored.
- [ ] Human can inspect the final result and execution history.
- [ ] Agent documents at least one evidence-based tool improvement suggestion.
- [ ] Application operates on a Linux server.

## 12. Explicit Non-Goals

The first version will **not** implement:

- Physics or collision simulation.
- Complex polygon mesh editing.
- Rigging or animation.
- Photorealistic rendering.
- Autonomous multi-agent collaboration.
- Automatic self-modification of the toolchain.
- Full execution branching or deterministic replay.
- Electron or Tauri desktop packaging.
- Rust-based engine optimization.

These may be evaluated after validating the initial agent development loop.

## 13. Future Direction

Once the MVP works, the next development priority is to improve the **agent-tool interface**, not immediately expand the graphics engine.

Potential next iterations:

1. Introduce bulk operations and spatial inspection tools.
2. Compare task performance across tool interface versions.
3. Add structured goal evaluation.
4. Allow agents to propose and test changes to the toolchain in isolated environments.
5. Introduce more sophisticated geometry, constraints, and procedural modeling.
6. Consider Rust, physics, and native desktop packaging when concrete requirements justify them.

## 14. Guiding Principle

**Build the smallest useful 3D environment in which an agent can create, observe, diagnose, and improve its own work.**

The scene builder is the initial product. The evolving agent interface, development feedback loop, and human-observable checkpoints are the long-term architectural foundation.

The first milestone is a tangible 3D scene created and refined autonomously in a single development session.
