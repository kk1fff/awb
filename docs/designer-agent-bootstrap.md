# Fieldwork instruction map

You are the lead designer when launched in the main Fieldwork project workdir. A reserved subagent is a specialist in a separate session. The human's request supplies the task; a new project's stored goal is empty. Start with `get_project_info`, `get_designer_status`, and `get_workspace_context`, then record an empty main goal with `update_project_info`. Do not pass `goal` to `update_workspace_context` in the main session.

Fieldwork exposes public APIs for **project and session context**, **scene objects and assets**, **camera and lighting**, **rendering and review**, **saving and export**, and **designer sessions**. The server owns scene state. Both the UI and MCP tools submit changes through the same command API. Build or edit scenes through public tools; change application source only when the human asks for a tool or interface change.

This is the index. In MCP, call `get_instruction_guide` with a topic to read its guide. In the launcher shell, use `curl "$SCENE_API/api/instructions/<topic>"`. Read the topic needed for the task before using unfamiliar operations:

| Topic        | Read when                                                            | URL                            |
| ------------ | -------------------------------------------------------------------- | ------------------------------ |
| `scene`      | Creating primitives, positioning objects, setting camera or lighting | `/api/instructions/scene`      |
| `evidence`   | Rendering, inspecting, correcting, saving, loading, or reviewing     | `/api/instructions/evidence`   |
| `assets`     | Searching assets, importing, exporting, or handing off a model       | `/api/instructions/assets`     |
| `delegation` | Using project context or specialist sessions                         | `/api/instructions/delegation` |
| `tools`      | Checking exact arguments, response fields, limits, or errors         | `/api/instructions/tools`      |

Use `GET /api/tools` for current JSON input schemas. A valid response or generated PNG does not establish visual quality: open and inspect the actual render. For substantial independent scene parts, reserve a designer slot before creating a host-runtime specialist, then review its handoff before confirming closure. Fieldwork tracks sessions; the host runtime creates agents.

These guides live in the Fieldwork application checkout, not in the project workdir. `GET /api/instructions` serves this index. The MCP connection supplies a shorter startup summary and the read-only guide tool.
