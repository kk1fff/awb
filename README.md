# Fieldwork · Agent World Builder

A local 3D scene builder. A human starts one project; Codex, Claude Code, or OpenCode builds and inspects scenes through the same public API used by the browser.

## Start a project

Requires Linux, Node.js 22.12+, npm, a browser, and an installed, signed-in agent CLI. From this repository:

```bash
./start.sh --workdir ~/project1
```

The launcher installs dependencies when missing, builds the app, starts one local server on an available port, and shows its browser URL in a one-row terminal header. The remaining terminal is an interactive shell in `~/project1`; it uses a PTY and does not start tmux. Open the URL to watch the agent and scene. Launch `codex`, `claude`, or `opencode` in the shell. Exiting an agent returns to the shell; exiting the shell stops the server.

For server-only use, including non-interactive launch:

```bash
./start.sh --workdir ~/project1 --no-ui
```

This prints the URL and runs until Ctrl-C or SIGTERM. It prepares the same project-specific MCP configuration. No browser opens automatically. When a coding agent receives the human's goal, it should call `get_project_info`, then `update_project_info` if the goal is empty.

## Workdir layout

```text
project1/
  info.yaml                   # Fieldwork marker, project ID, goal, main_session, agent_context
  session-<main-uuid>/        # Main scene, saves, assets, runs, and recovery
  session-<sub-uuid>/         # A separate submodule scene and evidence
  .fieldwork/                 # Current connection, launch lock, helper commands, server log
  .mcp.json                  # Claude Code MCP entry
  .codex/config.toml         # Codex MCP entry for trusted projects
  opencode.json              # OpenCode MCP entry
```

`start.sh` creates a missing workdir with an empty goal and main session. An existing directory must already contain a valid Fieldwork `info.yaml` and main session folder; unrelated directories are rejected. Startup refreshes the Fieldwork MCP entry while preserving other agent settings. The generated `codex` command in the launcher's shell supplies the same connection through CLI overrides, including in non-Git workdirs where Codex may not load project configuration. Each MCP connection verifies the current project and server run before exposing tools. Client trust and MCP approval prompts may still appear.

`info.yaml` is human-readable project metadata. While the server runs, agents update `goal` and `agent_context` through `get_project_info` and `update_project_info`, using `info_revision` to prevent stale writes. Edit the file directly only while the server is stopped. The main session's goal follows the project goal; submodule sessions have their own goals.

Create and enter a submodule session from the provided shell:

```bash
fieldwork session create --name "Pond" --goal "Design a pond"
fieldwork session shell <session-uuid>
```

The second command opens a shell inside that session folder with its own MCP binding. Its scene is isolated from the main scene. Use the browser or public export/import tools to hand finished submodule work to the main session. Fieldwork does not spawn or coordinate coding agents.

Existing `data/workspaces` scenes in this repository are left untouched and are not imported into new workdirs automatically.

## Tools and development

The [tool guide](docs/tools.md) and [agent workflow](docs/agent-workflow.md) describe scene operations. Scene tools return stable object IDs and scene revisions. Every tool call is recorded with an execution ID; renders, exports, and saves are associated with the producing run and revision. The server owns scene state. Agents must build scenes through public tools rather than editing saved JSON or renderer source.

The direct development server remains available for application work:

```bash
npm ci
npx playwright install chromium
npm run dev
```

The API uses port 3001 and Vite uses port 5173 in this mode. It retains the legacy `data/workspaces` layout for compatibility. The human-started `start.sh` path uses one production-style local server and workdir storage.

Run checks with `npm run typecheck`, `npm test`, `npm run test:api`, `npm run test:smoke`, and `npm run test:e2e`. Browser tests use disposable storage. A complete visual evaluation also requires opening the actual PNG, making a justified correction, and verifying a fresh-process reload.
