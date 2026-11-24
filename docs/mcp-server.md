# ShipWarden MCP server

ShipWarden runs a local [MCP](https://modelcontextprotocol.io) server. Agents use it to ask ShipWarden and each other
for help, to work on their pull requests, and to test their changes in the browser of ShipWarden, without an automation
in the middle.

## How agents get it

Each new agent tab of Claude Code, Codex, Gemini CLI, or opencode gets the server at start. ShipWarden does not change
your config files, and your own MCP servers stay.

| Agent | How the agent gets the server | Where the token is |
| --- | --- | --- |
| Claude Code | `--mcp-config <file>`. ShipWarden does not add `--strict-mcp-config`. | In the file |
| Codex | `-c mcp_servers.shipwarden.url=…` and `-c mcp_servers.shipwarden.bearer_token_env_var=SHIPWARDEN_MCP_TOKEN`. Each option sets one key, so the servers of your `config.toml` stay. | In the environment of the tab |
| Gemini CLI | A copy of ShipWarden's hook settings file with `mcpServers.shipwarden`, in `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`. Gemini CLI merges the servers of all settings files by name. | In the file |
| opencode | `mcp.shipwarden` in the inline config (`OPENCODE_CONFIG_CONTENT`) that also loads the state plugin. The header is `Bearer {env:SHIPWARDEN_MCP_TOKEN}`. | In the environment of the tab |

- Each file is private (mode 0600) and holds the URL and the token of the session. ShipWarden removes the file when the
  token ends.
- The token is never in the command line. Codex and opencode read it from the `SHIPWARDEN_MCP_TOKEN` variable of the tab.
- opencode 2 connects to a shared background service by default. That service does not read the config of the tab, so
  ShipWarden adds `--standalone` for opencode 2 and later. ShipWarden runs `opencode --version` to find the version. A
  command with `--standalone` or `--server` keeps its options.
- A server of your own with the name `shipwarden` has priority in Gemini CLI and opencode.
- In Claude Code, the tools show as `mcp__shipwarden__<tool>`. Run `/mcp` in Claude Code or Codex to see the server.
- An agent that you type in a shell tab (`claude`) does not get the server. Start it from the Agent button.

## Tools

All tools act on the worktree of the agent ("this worktree").

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_worktrees` | `all` (optional, default false) | The worktrees of the repository of this worktree, or of all projects with `all`. Each one has its path, branch, name, linked task, pull request state (number, draft, review decision, and checks), and the agents that run in it. |
| `get_overlaps` | none | The files that this worktree changes and that other worktrees of the same repository also change, with each peer and its shared files. |
| `get_task` | none | The task that is linked to this worktree: key, title, status, assignees, labels, priority, description, checklists, and the newest 50 comments. |
| `ask_agent` | `worktree`, `question`, `timeout_seconds` (optional, 10 to 900, default 300) | The answer of the agent of the other worktree. `worktree` is a path, a branch, or a name from `list_worktrees`. ShipWarden starts the agent of that repository in print mode in the other worktree. It can read files. It cannot change files. |
| `set_task_status` | `status` | Moves the task of this worktree to the status with that name or ID. The name ignores case. A wrong name gives the list of statuses. |

### Pull request tools

The pull request tools use the code host of the worktree (Settings › Code review): GitHub, Azure DevOps, GitLab,
Bitbucket, Gitea, or Forgejo. They act on the pull request of the branch of this worktree.

| Tool | Arguments | Result |
| --- | --- | --- |
| `get_pull_request` | `include_resolved` (optional, default false) | The pull request: number, title, address, state, draft, base and head branch, merge state, review decision, description, reviews, comments, and the review threads that are not resolved. Each comment in a thread has an `id` for `reply_to_comment`. Without a pull request, `pullRequest` is null. |
| `get_checks` | `include_logs` (optional, default false) | The checks of the head commit, and the count of failed, pending, and passed checks. With `include_logs`, ShipWarden saves the logs of up to 5 failed GitHub Actions jobs in files and gives the path of each file. |
| `create_pull_request` | `title`, `body`, `base`, and `draft` (all optional except `title`) | Creates a pull request from the branch. Push the branch first. A branch with an open pull request gives an error. Returns the number and the address. |
| `update_pull_request` | `title`, `body`, `draft`, `base`, and `state` (`open` or `closed`), all optional | Changes only the values that are different. `draft` false marks the pull request as ready for review. |
| `reply_to_comment` | `comment_id`, `body` | Adds a reply to the review thread of the comment. Only comments on lines of code can get a reply. |
| `watch_pull_request` | `events` (optional, default all), `stop` (optional) | Starts a watch of the open pull request. See [Watch a pull request](#watch-a-pull-request). |

ShipWarden puts each change into the views at once. It does not load the pull request again.

### Watch a pull request

`watch_pull_request` tells ShipWarden to send a message to the agent when an event occurs on the pull request of its
worktree. The message comes as a new prompt in the agent tab. These are the events:

| Event | When it occurs |
| --- | --- |
| `ci.failed` | A check of the pull request fails. |
| `pr.conflict` | The pull request has a merge conflict with its base branch. |
| `pr.comment` | A person adds a comment or a review that is not an approval. |

- The events are the same as the automation triggers with the same names, and they come from the same data. The branch
  summaries give `ci.failed` each minute. The Dashboard gives `pr.conflict` and `pr.comment` at each refresh. The
  Dashboard reads comments from GitHub only, so `pr.comment` needs a GitHub repository.
- A watch needs no approval, because the messages go only to the agent that started the watch.
- The message of a comment contains the text of the comment, and it tells the agent that the text comes from the
  reviewer. Start a watch only on pull requests where you trust the people who can comment.
- The watch ends when the pull request is merged or closed (the agent gets a last message), when the agent tab closes,
  or when the agent calls the tool with `stop` set to true. A new watch of the same agent replaces the old one.
- ShipWarden must be open to send the messages. The watches stay after a restart of ShipWarden.
- When the agent is asking a question, the message waits. ShipWarden tries again each minute, 10 times.

### Browser tools

The browser tools act on the browser tab of the worktree in ShipWarden. The agent and you use the same tab, so you see
what the agent does. When the worktree has more than one browser tab, the tools use the newest tab.

| Tool | Arguments | Result |
| --- | --- | --- |
| `open_page` | `url` | Opens an http or https address and waits up to 30 seconds for the load. Without a browser tab, ShipWarden adds one to the worktree. The selected worktree does not change. |
| `read_page` | `selector` (optional) | The address, the title, the visible text (up to 20,000 characters), and up to 150 links, buttons, and fields. Each element has a `ref`. A `selector` limits the result to the first match. Password fields do not show their value. |
| `screenshot` | none | A PNG image of the visible part of the page, up to 1280 pixels wide. |
| `click` | one of `ref`, `selector`, or `element` | Clicks the element. `element` is the visible text of a link or a button. Waits for a page load that the click starts. |
| `type` | one of `ref`, `selector`, or `element`, then `text`, `clear` (default true), and `submit` (default false) | Types the text into a field. For a select, the text is the value or the label of an option. `submit` submits the form of the field, or presses Enter. |

- A ref stays valid until the page changes. After a navigation, call `read_page` again.
- The tab uses the session of the ShipWarden browser, with its cookies. The pages that you signed in to are signed in
  for the agent too.
- A tab that you did not open yet has no size. Its screenshot loads the address again in a hidden window, and the
  result says so. That image does not show the changes that clicks and typed text made.

### Coordinator and workers

An agent (the coordinator) can split a large task and give the parts to worker agents. Each worker gets its own git
worktree, branch, and task. The worker sends its result back, and ShipWarden tells the coordinator.

| Tool | Arguments | Result |
| --- | --- | --- |
| `start_worker` | `task`, and the optional `title`, `repository`, `branch`, `base`, `agent`, and `model` | Makes a new worktree and branch (`worker/<title>-<id>` by default) from the newest default branch or from `base`, and starts the agent with the task. `repository` is a path or a name. The default is the repository of this worktree. `agent` is an ID or a name of Settings › Agents. Returns the `worker_id`. |
| `list_workers` | none | The workers of this agent: `worker_id`, title, status (`starting`, `working`, `needs_attention`, `done`, or `failed`), branch, worktree, depth, agent state, pull request, and report. |
| `wait_for_worker` | `worker_id` (optional), `timeout_seconds` (optional, 10 to 900, default 300) | Waits until the worker (or any worker) finishes, stops, or needs attention, and returns it. After the time, it returns all workers with `timedOut`. |
| `report_result` | `summary`, `status` (`done` or `failed`, default `done`), `pull_request_url` (optional) | Only for a worker. Saves the result and sends it to the coordinator. The pull request of the branch wins over `pull_request_url`. |

- The prompt of the worker tells it to commit, push, open a pull request, and then call `report_result`.
- ShipWarden sends a message to the coordinator tab when a worker sends its result, when its agent tab closes, and when
  its agent waits or is idle for 10 minutes without a report. A worker that stops without a report is "done" when its
  branch has a pull request, else "failed". A worker that `wait_for_worker` returns does not also send a message.
- A message waits while the window is closed or the coordinator tab is closed. ShipWarden tries again every 30 seconds.
  A new coordinator session in the same worktree gets the results with `list_workers` and `wait_for_worker`.
- **Depth.** A worker can start its own workers. Settings › Agents › MCP server › **Worker depth** sets the most levels
  of workers below the agent that you started. The default is 2: a coordinator, its workers, and their workers. With 1,
  workers cannot start workers. A call past the limit fails with an error that names the limit.
- **Limits.** Each start checks the usage budget of Settings › Agents for the agent of the worker. The open workers of
  all coordinators and the agents of the task queue share one limit: Settings › Queue › **Agents at the same time**. A
  coordinator can have 50 workers at most.
- **Plans view.** Each coordinator is a plan in the Plans view of the project, with each worker as a step. The page
  shows the status, the branch, the pull request, the task, and the report of each worker. It cannot edit the run.
  **Delete** removes the list only. The worktrees, branches, agents, and pull requests stay.
- `start_worker` needs approval the first time in each worktree. A worker that starts workers asks one time in its own
  worktree. `list_workers`, `wait_for_worker`, and `report_result` need no approval. `report_result` only sends the
  result to the agent that started the worker.
- The window of ShipWarden must be open to start a worker.

A tool that fails gives a tool result with `isError`, and the text says what to do. For example: "This worktree has no
task. Link a task to the worktree in ShipWarden first."

## Approval

- The read tools need no approval: `list_worktrees`, `get_overlaps`, `get_task`, `get_pull_request`, `get_checks`,
  `watch_pull_request`, `read_page`, `screenshot`, `list_workers`, `wait_for_worker`, and `report_result`.
- The write tools show a dialog the first time in each worktree: `ask_agent`, `set_task_status`, `create_pull_request`,
  `update_pull_request`, `reply_to_comment`, `open_page`, `click`, `type`, and `start_worker`. **Allow** applies to that tool in that
  worktree until you revoke it. **Deny** applies to that call only.
- Without an answer in 2 minutes, the dialog closes and the tool call fails with this error: "The user did not approve
  ask_agent in 2 minutes. Tell the user that ShipWarden is waiting for approval, then call the tool again."
- Settings › Agents › MCP server lists the worktrees with approved tools. **Revoke** removes the approvals of a worktree.
- The `shipwarden` CLI uses the same approvals for its write commands. The list shows them with "(CLI)". See
  [cli.md](cli.md).

## Security

- The server listens only on 127.0.0.1.
- Each agent session has its own random token. The token identifies the worktree, so an agent cannot act as another
  worktree. A request without a token or with a wrong token gets 401.
- ShipWarden keeps only the SHA-256 hash of each token. A token ends when its terminal exits, or after 30 days.
- A request from a web page of another site (an `Origin` header that is not local) gets 403.

## Settings

Settings › Agents › MCP server › **Give agents the ShipWarden tools** turns the server on and off. The default is on. The
change applies to new agent tabs. **Worker depth** (1 to 5, default 2) limits the levels of workers.

## Protocol

The server uses the Streamable HTTP transport at `http://127.0.0.1:<port>/mcp`. It supports the protocol versions
2025-11-25, 2025-06-18, and 2025-03-26. It answers each request with `application/json` and has no SSE stream, so
GET gets 405. It keeps no MCP session. ShipWarden tries the same port at each start, so agents that still run can
reach it again after an app restart.

## Future work

- Browser tools: give a tab that never showed a size, so that its screenshot shows the changes of the agent.
- `watch_pull_request`: get `pr.comment` from the code hosts that are not GitHub.
- Workers: start them while the window is closed (in the background helper), and let the coordinator send a prompt to a
  waiting worker.

- Agents in shell tabs: give them a token through the shell integration.
- opencode in a shell tab: the `opencode` function of the shell integration does not add `--standalone`, so opencode 2
  does not load the state plugin there.
