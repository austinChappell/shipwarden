# ShipWarden improvement plan

This plan closes the gaps between ShipWarden and two similar apps: Orca (stablyai/orca) and T3 Code (pingdotgg/t3code).
The comparison uses their READMEs, their websites, and their release notes of 23 Nov 2026. We did not read all of their
docs, so a few gaps can be smaller than they look here.

The features are in 6 phases. Each phase can ship alone. Each feature has a goal, a design, the files to change, the
tests, and the open questions. File paths are the best start point today. They can change during the work.

## Comparison

### Where ShipWarden is ahead

- Seven task trackers through an open plugin protocol: GitHub Issues, Linear, ClickUp, Jira, Azure Boards, Trello, and
  local tasks. Orca and T3 Code mainly have GitHub and Linear issues. Orca also has a Jira drawer.
- A full PR review view with LSP code navigation, agent reviews at three strictness levels, PR groups, and screenshots
  of the branch and the base.
- Pipelines: workflow runs, `workflow_dispatch` with inputs, and pipeline approvals.
- Overlap detection between worktrees, Compare agents, agent stats, and usage budgets.

### Gaps

| Gap | Orca | T3 Code | ShipWarden today |
|---|---|---|---|
| Platforms | macOS, Windows, and Linux | macOS, Windows, Linux, and web | macOS on Apple silicon only |
| Mobile | iOS and Android, push | iOS and Android, push | iPhone beta on the LAN, no push, cannot start agents |
| Remote and headless | SSH worktrees, paired servers, and cloud VMs | SSH hosts, Tailscale, a relay, and a background service | Automations and the queue run only while the app is open |
| Agents | 27 named agents | About 10 agents and any ACP agent | 4 agents and custom agents. Full support for Claude Code only |
| Chat UI | Native chat for many agents | Chat for all providers, model change during a thread | Chat view for Claude Code only |
| MCP for agents | Not compared | PR tools, `watch_pull_request` | 5 tools, Claude Code only |
| CLI | `orca` CLI | `t3` CLI | No CLI |
| Browser for agents | Design Mode, profiles, emulators, computer use | Shared headless Chrome tabs | The browser is for the user and for screenshots only |
| Multi-agent work | Coordinator and workers, Bots with memory | Workflows (Labs) | Plans, Compare, and `ask_agent` |
| Slack | Bots in Slack | Not compared | Webhooks only |
| Code hosts | Adds Gitea | Adds Forgejo and Gitea | No Gitea or Forgejo |
| Stacked PRs | Not compared | Merge and rebase a stack | Plans stack PRs, but no stack actions |
| Customization | Plugin catalog (themes, panels) | Configurable keybindings | No keybinding remapping, task plugins only |
| External editors | Not compared | Not compared | No "Open in VS Code, Cursor, Zed, or JetBrains" |
| Input | Voice dictation | Voice input, Word, PDF, and spreadsheet attachments | No voice input. Images only |
| Languages | About 8 | About 8 | English only |
| Accounts | Switch Codex accounts without a logout | Not compared | One account for each agent |

## Rules for all phases

- Keep all network data in TanStack Query. A write updates the cache. Do not refetch to show a change.
- New network code uses the CA certificates of Settings › Network.
- New UI follows the 3 boards in `docs/design`. Use the Combobox for long lists. Buttons are inline and right-aligned.
- Write the UI text and the docs in Simplified Technical English. Update the README and `docs/` in the same PR.
- Add each new feature to the tips list (`src/shared/tips.ts`) when it is easy to miss.

## Phase 1: All agents get the same support

Codex is the second most used agent, and it gets the least support. This phase has the best gain for each hour of work.

### 1.1 Codex state and tokens

**Goal:** Show the state, the waiting reason, and the token count of a Codex agent, as for Claude Code.

**Status:** In PR #248.

**Design:**

- Codex 0.170 has hooks with the Claude Code event names and fields. ShipWarden uses its hook server for Codex too.
  It does not parse the session files for the state.
- Give Codex 7 hooks with `-c hooks.<event>=[…]` options at start. Each hook runs
  `sh <app data>/codex-hook.sh <event>`, and the script sends the event to the hook server. Do not change the user's
  `~/.codex` files.
- Map the events to the agent states:
  - `SessionStart` is "idle". `UserPromptSubmit` is "working" and a new turn, so the checkpoints work.
  - `PreToolUse` is "working" with the tool text. A `request_user_input` tool call is "waiting" for a question.
  - `PermissionRequest` is "waiting" for a permission. `PostToolUse` shows that the user answered.
  - `Stop` is "done". `Interrupt` is "idle".
  - Do not listen to `SessionEnd`. Codex also sends it after 30 minutes without work, while the agent still runs.
- Codex runs a hook only after the user trusts the exact hook definition in `/hooks`, under "Session flags". The
  definition contains only the script path and the event, so a change of the script needs no new trust. Do not use
  `--dangerously-bypass-hook-trust`, because it also runs the untrusted hooks of the user.
- A Codex tab starts without a state, not with "starting". Until the first hook event, it shows "working" from its
  terminal output, as an agent without hooks does.
- Count the tokens from the session file that `transcript_path` names. Each `token_count` event has the total of the
  session. Each larger total is one response with the change. The input tokens include the cache reads, so the count
  is the input minus the cache reads, plus the output.
- Add a `codex` function to the zsh and bash integration, so a `codex` that the user types in a shell tab gets the same
  hooks.
- Pins, resume, and the chat accept only Claude Code transcripts (`transcriptAgentOf`).

**Files:** `src/shared/agents.ts`, `src/main/agents/hook-files.ts`, `src/main/agents/shell-integration.ts`,
`src/main/automations/token-counter.ts`, `src/main/ipc/args.ts`, and the renderer files that read the transcript.

**Tests:** The event mapping, the TOML and shell quoting, the Codex token counter, the `codex` function in a real bash
shell, and `terminalCommand`.

**Open questions:**

- Which tool name do the hooks send: the outer `exec` tool or the inner tool, for example `exec_command`?
  `describeTool` handles both. Check it in the app.
- Can ShipWarden find out that the hooks are not trusted yet, and show a hint in the agent tab? Codex keeps the trust
  in `[hooks.state]` of `config.toml`, but the key and the hash of "Session flags" hooks are not documented.
- `transcript_path` is "not a stable interface", as the Codex docs say. A new session file format gives no token
  count. It does not change the state.

### 1.2 Chat view for Codex

**Goal:** Give Codex agents the same chat view as Claude Code.

**Status:** Done in branch `1.2-codex-chat`. The chat is an experimental opt-in setting (`experimentalAgentChat`). A Codex prompt keeps its
image marks, because the images are temporary files that the page cannot show.

**Design:**

- Make the chat model in `src/shared/agent-chat.ts` independent of the agent. Add one adapter for each transcript
  format: Claude Code first, then the Codex session files. The Codex hooks of 1.1 give their path.
- Keep the current behavior: the chat view types into the terminal underneath.
- Add Gemini CLI and opencode adapters later, when their transcripts are easy to read.

**Files:** `src/shared/agent-chat.ts`, `src/renderer/src/components/ChatView.tsx`, and the new adapters.

**Tests:** Adapter tests with fixture transcripts. The current Claude Code chat tests must pass with no change.

### 1.3 MCP server for all agents

**Goal:** Give the ShipWarden MCP tools to Codex, Gemini CLI, and opencode.

**Status:** Done in branch `1.3-mcp-all-agents`. Codex and opencode read the token from the environment of the tab.
opencode 2 gets `--standalone`, because its shared background service ignores the config of the tab. Gemini CLI was
not tested live.

**Design:**

- Codex: pass the server with `-c mcp_servers.shipwarden...` at start. Do not change the user's `config.toml`.
- Gemini CLI: add the server to the settings file that ShipWarden already writes for the hooks.
- opencode: add the server to the config that the ShipWarden plugin uses.
- Use the same token for each session and the same approval UI as for Claude Code.

**Files:** `src/shared/agent-programs.ts`, `src/main/agents/gemini-settings.ts`, `src/main/agents/opencode-plugin.ts`,
`src/main/mcp/mcp-host.ts`, `docs/mcp-server.md`.

**Tests:** Unit tests for the start arguments and the settings of each agent. A test that the user's own MCP servers
stay.

### 1.4 Switch accounts

**Goal:** Use a second Claude or Codex account when the first account reaches its limit.

**Design:**

- Settings › Agents gets a list of accounts for each agent. Each account has its own config folder
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- A new agent uses the selected account. The usage budget can select the next account instead of waiting.

**Open questions:** Do the plan terms of Claude and OpenAI permit this use? Check before we build it. Answer: let's skip this one

## Phase 2: Work without the app window

### 2.1 Headless automations and queue

**Goal:** Run automations and the task queue while the app is closed.

**Status:** Done in branch `2.1-headless-engine`. A lock file (`automation-engine.lock`) lets one process run the
engine: the app while a window is open, else the background helper when the new setting "Run while ShipWarden is
closed" is on (off by default, and the helper needs the Settings › Mobile switch). The app asks for the lock with a
handover file. The page engine stays in the page. The run decisions, the HTTP action, the {{checks}} variable, and the
queue observation moved to `src/shared`. `HeadlessEngine` and `HeadlessQueue` run in the helper: schedule and CI
triggers, and the actions "Start an agent", "Send to the agent", "Notify", "HTTP", "If", and "Stop". A run with another
action waits for the app. The helper polls the branch summaries only while it holds the lock, with the GitHub CLI token.
The phone lists the pending runs and approves or skips them (`/v1/automations/pending`). The CLI socket does not run in
the helper yet. Not tested live in the app, in the helper, or on the phone.

**Design:**

- Move the automation engine and the queue scheduler from the renderer to a shared module. The background helper
  (`src/main/helper/`) runs it when the app is closed. The main process runs it when the app is open.
- Only one process runs the engine at a time. Use a lock file in the app data folder.
- Schedule triggers and CI triggers work in the helper. Triggers that need the UI (manual buttons) do not.
- Agents already stay alive in the PTY host, so the helper can start agents through it.

**Files:**

- Change: `src/renderer/src/automations/`, `src/renderer/src/queue/`, `src/main/queue/queue-store.ts`,
  `src/main/helper/main.ts`, `src/shared/automations.ts`, `src/shared/task-queue.ts`.

**Tests:** Engine tests that run without the renderer. Lock tests: two processes, a stale lock, and a crash.

**Open questions:**

- The helper has no TanStack Query cache. How does it get the PR and CI data with few API calls? Share one poller with
  the main process? - We can share one poller with the main process.
- Do approval gates wait for the app, or does the phone answer them? - It would be great if the phone could answer them.

### 2.2 Start agents from the phone

**Goal:** Start an agent on a task or a new worktree from the iPhone app.

**Status:** Done in branch `2.2-phone-start-agents`. The phone calls `GET /v1/start/options` and `POST /v1/agents/start`
(repository, a task or a prompt, agent, model, and an optional branch). Each start makes a new worktree. A paired phone
needs the new permission "Start agents" (Settings › Mobile, off for each phone by default). Without it, both routes
answer 403. `RemoteStarter` checks the repository, the agent, and the usage budget in the main process (or the helper).
While a window is open, the page starts the agent with the start code of "Start in worktree" (`startTaskQuietly` and
`startInNewWorktree`, with a new model option). While the app is closed, the helper uses `HelperAgents` and its own
`UsageService`. A task start needs the app: the tasks come from the cached list that the Tasks view selected last. The
answer comes when the agent session runs, and the prompt goes in after that. The phone adds the agent and the worktree
from the answer and opens the agent. The phone has a model text field, not a model list. Not tested live in the app,
in the helper, or on the phone.

**Design:**

- Add `startAgent` to the remote API: repository, task or prompt, agent, and model.
- Use the same start code as "Start in worktree". Check the usage budget.
- The phone shows the new agent at once from the response. It does not reload the list.

**Files:** `src/shared/remote.ts`, `src/main/remote/remote-server.ts`, `src/main/helper/remote-control.ts`, and the
`ios/` app.

**Tests:** Remote contract tests for the new call. A test that a device without the permission cannot start agents.

### 2.3 Push notifications to the phone

**Goal:** Tell the user on the phone when an agent needs input, also when the phone app is closed.

**Status:** Done in branch `2.3-push-notifications` (option A). The relay is in `relay/`: a Node 24 server with no
packages and no database, behind HTTPS, with the APNs key (.p8, token auth) in its environment. The phone registers its
device token with the relay and gets a ticket (the token, encrypted with the relay secret) and a push key (an HMAC of
the ticket). It gives both to its Mac (`POST /v1/push/register`). The Mac signs each push with the push key, and the
relay makes the text from a fixed kind and the worktree name. So a Mac can push only to its own phones, and it never
sees a device token. The process that runs the phone server sends "Agent needs input" after an agent waits for 10
seconds. The process that runs the automations sends "Automation is waiting for approval". Settings › Mobile has the
switch (off by default), the relay address (a placeholder until a deploy), and "Send test". The iPhone app asks for
permission when the Mac sends notifications, and a tap opens the agent. The relay is not deployed, and nothing is
tested live: not the relay with APNs, the app, the helper, or the phone. The privacy policy (marketing repository)
must name the relay before a release.

**Design:**

- Apple push needs a server with the APNs key. ShipWarden has no server today.
- Option A: a small relay that sends only the push payload ("Agent needs input" and the worktree name). It does not
  store or see the agent text.
- Option B: use a push service that the user selects (for example ntfy) through an automation. This works today with
  the `http` action, but the text cannot open the app.

**Open questions:** Do we want to run a relay? Pick A or B before any work starts. - Answer: Option A

### 2.4 Remote worktrees on SSH hosts

**Goal:** Run agents on a different machine, for example a large Linux server.

**Design:**

- A repository can have an SSH host. ShipWarden copies a small runtime to the host. The runtime runs the PTY host,
  the git commands, and the hook server there.
- The app talks to the runtime through the SSH connection. Use the same protocol as the PTY host today.
- File views, diffs, and the LSP use the remote runtime.

**Files:** New `src/main/remote-hosts/`. Change `src/main/pty-host/`, `src/main/worktrees/`, `src/main/git/`, and
`src/main/files/`.

**Open questions:** This is the largest feature in the plan. Make a design doc first. The pty host uses launchd today,
so a Linux host needs a different service manager.

## Phase 3: Tools for agents and scripts

### 3.1 ShipWarden CLI

**Goal:** Let agents, scripts, and users control ShipWarden from a terminal.

**Status:** Done in branch `3.1-shipwarden-cli`. The CLI talks to the app main process through a Unix socket (mode 0600)
and a token in `~/.shipwarden/cli.json`. The helper does not run the socket yet. `CliServer` and `CliActions` use no
Electron API, so the helper can run them after 2.1. The commands for agent tabs, worktrees, and automations run in the
page with the code of the automations, so the window must be open. `--wait` waits for the turn of a prompt. The write
commands use the MCP approval store, with the worktree (or the repository) as the key. The agent skill is
`skills/shipwarden/SKILL.md`, and `shipwarden skill install` installs it. `automation run` cannot run a task
automation. Not tested live in the app or in a packaged build.

**Design:**

- Add a `shipwarden` command. It talks to the running app or the helper through a local socket with a token.
- First commands:
  - `shipwarden status --json`
  - `shipwarden worktree list|create|remove`
  - `shipwarden agent start|send|wait`
  - `shipwarden task get|status`
  - `shipwarden automation run`
- Settings › Agents gets "Install the shipwarden command". It adds a link in `/usr/local/bin` or `~/.local/bin`.
- Write tools use the same approval rules as the MCP server.

**Files:** New `src/cli/` and a build entry in `electron.vite.config.ts`. Reuse `src/main/mcp/tools.ts` for the
actions.

**Tests:** Command tests with a fake socket. A test that a request without a token fails.

**Open questions:** Ship a skill file for the CLI, as Orca does? - Answer: that would be great if we can.

### 3.2 More MCP tools

**Goal:** Let agents act on PRs and the browser without the user.

**Status:** Done in branch `3.2-more-mcp-tools`. The server has 11 new tools. `get_pull_request` is new, because
`reply_to_comment` needs the comment IDs. `watch_pull_request` needs no approval, because its messages go only to the
agent that called it. `read_page` and `screenshot` need no approval. A browser tab that never showed has no size, so its
screenshot loads the address again in a hidden window. `pr.comment` watches work on GitHub only, because the Dashboard
reads comments from GitHub only. Not tested live in the app.

**Design:**

- PR tools: `create_pull_request`, `update_pull_request`, `reply_to_comment`, and `get_checks`. They use the review
  provider of the repository, so they work on all code hosts.
- `watch_pull_request`: the agent gets a message when a check fails, a conflict occurs, or a review comment arrives.
  Reuse the `ci.failed`, `pr.conflict`, and `pr.comment` events of automations.
- Browser tools: `open_page`, `screenshot`, `click`, `type`, and `read_page`, on the browser tab of the worktree.
- Each write tool needs approval the first time.

**Files:** `src/main/mcp/tools.ts`, `src/main/browser/browser-views.ts`, `src/shared/automation-events.ts`,
`docs/mcp-server.md`.

**Tests:** Tool tests with a fake service layer, as the current tools have.

### 3.3 Element picker in the browser

**Goal:** Send a page element to an agent.

**Status:** Done in branch `3.3-element-picker`. The "Pick element" button is in the toolbar of the browser tab. The
picker script runs in an isolated world of the page and blocks the click for the page. A bar under the toolbar shows a
preview, a note field, and the agent list of code notes. The default agent is the first agent that runs in the
worktree, else a new session of the agent of the repository. The prompt has the selector, the size, the text, the
computed styles that are not defaults, the HTML (cut at 6000 characters), and the path of a PNG of the visible part of
the element in the temporary folder. ShipWarden does not use the clipboard for the image. Frames of other sites are not
supported. Not tested live in the app.

**Design:** A "Pick element" button in the browser tab. Click an element to send its HTML, its styles, its selector,
and a screenshot to the agent of the worktree.

**Files:** `src/main/browser/browser-views.ts`, `src/renderer/src/components/BrowserView.tsx`.

## Phase 4: Agents work together

### 4.1 Coordinator and workers

**Goal:** Give a large task to one agent. It splits the work and starts worker agents.

**Status:** Done in branch `4.1-coordinator-workers`. The MCP server has 4 new tools: `start_worker` (approval the first
time), `list_workers`, `wait_for_worker`, and `report_result` for the worker. A coordinator run is a plan with a
`coordinator` field, and each worker is a step. The main process (`Coordinators`) owns the run, and the plan runner of
the page skips it. The page makes the worktree and starts the agent (`worker.start` of the page bridge), so the window
must be open. A timer tells the coordinator when a worker reports, exits, or waits for 10 minutes. A worker without a
report gets the pull request of its branch as its result. The open workers and the queue agents share the queue limit,
and each start checks the usage budget. The answer "Yes" to the depth question became the setting "Worker depth" in
Settings › Agents (1 to 5, default 2: a coordinator, its workers, and their workers). The Plans view shows each run as a
read-only page. Not tested live in the app.

**Design:**

- Add the MCP tools `start_worker`, `list_workers`, and `wait_for_worker` for a coordinator agent.
- Each worker gets its own worktree and its own task. Its result (PR link and summary) goes back to the coordinator.
- Reuse plans for the data model. A coordinator run is a plan with steps that the agent makes.
- Tell the coordinator when a worker stops or waits for 10 minutes.
- Check the usage budget and the queue limit for each worker.

**Files:** `src/main/mcp/tools.ts`, `src/shared/plans.ts`, `src/main/plans/plan-store.ts`, `src/shared/ask-agent.ts`.

**Open questions:** Can a worker start workers? Set a depth limit of 1 at first. - Answer: Yes

### 4.2 Native Slack integration

**Goal:** Get agent questions in Slack and answer them there.

**Status:** Done in branch `4.2-slack`. A Slack app of the user with Socket Mode (the global `WebSocket` of Node, no
Slack SDK) connects to one channel. After an agent waits for 10 seconds, ShipWarden posts the question in the thread of
its session. A reply in the thread goes to the agent (one digit is a key press, other text is a paste and Enter). A
mention "@ShipWarden <repository> <prompt>" starts an agent with `RemoteStarter` and answers in the thread. The
repository is the folder name or the display name. Only the Slack member IDs on the allow list of Settings › Slack can
start or answer agents (empty by default). The connection runs in the process that holds the automation lock. The
tokens are in the login keychain (the `security` tool), because the helper cannot read `safeStorage`. The app manifest
is in `docs/slack.md`. Not tested live with Slack, in the app, or in the helper.

**Design:**

- A Slack app with a bot token. Settings get a Slack section.
- `agent.needsInput` posts the question in a thread. A reply in the thread goes to the agent.
- A message that mentions the app starts an agent on a repository.
- This needs the headless engine of 2.1, or it works only while the app is open.

**Open questions:** Socket Mode removes the need for a public URL. Is that enough for teams? - Answer: I think so

## Phase 5: Small gaps

### 5.1 Open in an external editor

**Status:** Done in branch `5.1-external-editor`. ⌥⌘O opens the active file at its cursor line, or the selected
worktree. The editor setting is in Settings › Appearance › External editor.

Add "Open in editor" to the worktree menu and the file views. Detect VS Code, Cursor, Zed, and JetBrains IDEs. The user
selects one in Settings › Appearance.

### 5.2 Gitea and Forgejo

**Status:** Done in branch `5.2-gitea-forgejo`. The provider kind `gitea` serves Gitea and Forgejo. The user types the
server URL, or ShipWarden finds it: a new provider asks the unknown servers of the project remotes for
`/api/v1/version`. Pull requests, reviews, threads, merges, base changes (so the stack actions work), draft (the "WIP:"
prefix), labels, assignees, reviewers, and screenshots work. Actions uses the newer runs API when the server has it,
else the older task list, else only commit statuses. Rerun, cancel, dispatch, reply, and resolve fall back to a clear
error on a server without that API. Reactions, auto-merge, and pipeline approvals are hidden. Unit tests cover the
mapping with API fixtures, the client, the service, and the routing. Not tested live against a real server.

Add a `gitea` provider kind. Forgejo uses the same API. Follow `src/main/bitbucket/`. Map PRs, reviews, comments, and
Actions runs.

### 5.3 Stack actions

**Status:** Done in branch `5.3-stack-actions`. The "Stack" card of a plan PR group has "Rebase stack" and "Merge
stack". Rebase stack rebases each branch onto its parent, the bottom first, and pushes with `--force-with-lease`. It
stops at the first conflict and keeps that rebase in progress, so the user or the agent ("Send to agent") resolves it.
Merge stack merges the ready pull requests from the bottom up with the merge method of each repository, changes the
base of the next pull request after each merge, and stops at the first pull request that is not ready. It does not wait
for checks, and it stops above a squash or rebase merge until the next branch is rebased. Repositories with the GitHub
merge queue cannot use it. Unit tests cover the order and the stops with fake git and host calls. Not tested live.

Add "Rebase stack" and "Merge stack" to a plan PR group. Reuse the restack code of plans
(`src/main/plans/plan-store.ts`).

### 5.4 Keybinding remapping

**Status:** Done in branch `5.4-keybindings`. Settings › Keyboard lists 49 commands with a search field, "Record",
"Reset", and "Reset all". The file `~/.shipwarden/keybindings.json` maps a command ID to an accelerator
("CmdOrCtrl+Shift+K"), a list of accelerators, or null. ShipWarden reads and watches it, and ignores a bad entry with a
warning. A recorded key of another command asks first, and "Replace" moves the key. A conflict from a file edit shows
on both rows, and the first command of the list gets the key. The keys of macOS and the Edit menu are blocked. The find,
zoom, and terminal control keys get a warning. The key handlers, the menu accelerators (the menu is built again),
Monaco, the terminal, the palette, the Keyboard Shortcuts page, the tooltips, the tips, and the tour follow the
keymap. ⌘Q, ⌘H, ⌃V, and the browser keys stay fixed. Unit tests cover the parse, the merge, the conflicts, the formats,
the store, and the menu. Not tested live.

Add a Keyboard section to Settings. Store the user bindings in `~/.shipwarden/keybindings.json`. Show conflicts. The
current keys in `src/shared/shortcuts.ts` stay as the defaults.

### 5.5 Voice input

Add a dictation key in the agent prompt and the chat view. Use the macOS speech recognition, so no audio leaves the
Mac.

### 5.6 Document attachments

Let the chat view take PDF, Word, and spreadsheet files. Convert them to text or images before they go to the agent.

## Later

- **Linux, Windows, and Intel Mac builds.** Do this when users ask for it. The PTY host and the helper use launchd today
  (`src/main/pty-host`, `src/main/helper/launch-agent.ts`). Linux and Windows need a different way to keep agents
  alive.
- **Android app**, after the iPhone app leaves beta.
- **Translations of the UI.** Move the UI text to message files first.
- **A plugin catalog** for themes and panels, after the task plugin protocol is stable.
- **Agents with memory** (as Orca Bots): a named agent with a memory file that takes jobs from Slack, trackers, and
  schedules. Do this after 2.1, 4.1, and 4.2.
- **Cloud worktrees** on a hosted VM, after 2.4.
- **Bitbucket Data Center**, if users ask for it.

## Order

| Status | Order | Feature | Size | Why this order |
|---|---|---|---|---|
| 1 | 1.1 Codex state and tokens | M | Codex users see this gap first. In PR #248 |
| 2 | 1.3 MCP server for all agents | S | Small, and it uses code that exists |
| 3 | 1.2 Chat view for Codex | M | Needs 1.1 |
| 4 | 5.1 Open in an external editor | S | Small, and many users ask for it |
| 5 | 3.2 More MCP tools | M | Agents can fix their own PRs |
| 6 | 3.1 ShipWarden CLI | M | Reuses the MCP tools |
| 7 | 2.1 Headless automations and queue | L | The queue can run all night with the app closed |
| 8 | 2.2 Start agents from the phone | S | |
| 9 | 2.3 Push notifications | M | Decide on the relay first |
| 10 | 4.1 Coordinator and workers | L | Needs 3.2 |
| 11 | 4.2 Native Slack integration | M | Needs 2.1 |
| 12 | 3.3 Element picker | S | |
| 13 | 5.3 Stack actions | S | |
| 14 | 5.2 Gitea and Forgejo | M | |
| 15 | 5.4 Keybinding remapping | M | |
| 16 | 5.5 Voice input | S | |
| 17 | 5.6 Document attachments | S | |
| 18 | 1.4 Switch accounts | M | Check the plan terms first |
| 19 | 2.4 Remote worktrees on SSH hosts | XL | Design doc first |
