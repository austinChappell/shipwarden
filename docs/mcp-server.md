# ShipWarden MCP server

ShipWarden runs a local [MCP](https://modelcontextprotocol.io) server. Agents use it to ask ShipWarden and each other
for help, without an automation in the middle.

## How agents get it

- Each new Claude Code agent tab gets the server at start. ShipWarden adds `--mcp-config <file>` to the command. The
  file is private (mode 0600) and holds the URL and the token of the session.
- Your own MCP servers stay. ShipWarden does not add `--strict-mcp-config`.
- In Claude Code, the tools show as `mcp__shipwarden__<tool>`. Run `/mcp` in the agent to see the server.
- An agent that you type in a shell tab (`claude`) does not get the server. Start it from the Agent button.
- Codex, Gemini CLI, and opencode do not get the server yet.

## Tools

All tools act on the worktree of the agent ("this worktree").

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_worktrees` | `all` (optional, default false) | The worktrees of the repository of this worktree, or of all projects with `all`. Each one has its path, branch, name, linked task, pull request state (number, draft, review decision, and checks), and the agents that run in it. |
| `get_overlaps` | none | The files that this worktree changes and that other worktrees of the same repository also change, with each peer and its shared files. |
| `get_task` | none | The task that is linked to this worktree: key, title, status, assignees, labels, priority, description, checklists, and the newest 50 comments. |
| `ask_agent` | `worktree`, `question`, `timeout_seconds` (optional, 10 to 900, default 300) | The answer of the agent of the other worktree. `worktree` is a path, a branch, or a name from `list_worktrees`. ShipWarden starts the agent of that repository in print mode in the other worktree. It can read files. It cannot change files. |
| `set_task_status` | `status` | Moves the task of this worktree to the status with that name or ID. The name ignores case. A wrong name gives the list of statuses. |

A tool that fails gives a tool result with `isError`, and the text says what to do. For example: "This worktree has no
task. Link a task to the worktree in ShipWarden first."

## Approval

- The read tools (`list_worktrees`, `get_overlaps`, and `get_task`) need no approval.
- `ask_agent` and `set_task_status` show a dialog the first time in each worktree. **Allow** applies to that tool in that
  worktree until you revoke it. **Deny** applies to that call only.
- Without an answer in 2 minutes, the dialog closes and the tool call fails with this error: "The user did not approve
  ask_agent in 2 minutes. Tell the user that ShipWarden is waiting for approval, then call the tool again."
- Settings › Agents › MCP server lists the worktrees with approved tools. **Revoke** removes the approvals of a worktree.

## Security

- The server listens only on 127.0.0.1.
- Each agent session has its own random token. The token identifies the worktree, so an agent cannot act as another
  worktree. A request without a token or with a wrong token gets 401.
- ShipWarden keeps only the SHA-256 hash of each token. A token ends when its terminal exits, or after 30 days.
- A request from a web page of another site (an `Origin` header that is not local) gets 403.

## Settings

Settings › Agents › MCP server › **Give agents the ShipWarden tools** turns the server on and off. The default is on. The
change applies to new agent tabs.

## Protocol

The server uses the Streamable HTTP transport at `http://127.0.0.1:<port>/mcp`. It supports the protocol versions
2025-11-25, 2025-06-18, and 2025-03-26. It answers each request with `application/json` and has no SSE stream, so
GET gets 405. It keeps no MCP session. ShipWarden tries the same port at each start, so agents that still run can
reach it again after an app restart.

## Future work

- Codex, Gemini CLI, and opencode: add the server when their per-session MCP configuration is simple and stable.
- Agents in shell tabs: give them a token through the shell integration.
