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

**Open questions:** Do the plan terms of Claude and OpenAI permit this use? Check before we build it.

## Phase 2: Work without the app window

### 2.1 Headless automations and queue

**Goal:** Run automations and the task queue while the app is closed.

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
  the main process?
- Do approval gates wait for the app, or does the phone answer them?

### 2.2 Start agents from the phone

**Goal:** Start an agent on a task or a new worktree from the iPhone app.

**Design:**

- Add `startAgent` to the remote API: repository, task or prompt, agent, and model.
- Use the same start code as "Start in worktree". Check the usage budget.
- The phone shows the new agent at once from the response. It does not reload the list.

**Files:** `src/shared/remote.ts`, `src/main/remote/remote-server.ts`, `src/main/helper/remote-control.ts`, and the
`ios/` app.

**Tests:** Remote contract tests for the new call. A test that a device without the permission cannot start agents.

### 2.3 Push notifications to the phone

**Goal:** Tell the user on the phone when an agent needs input, also when the phone app is closed.

**Design:**

- Apple push needs a server with the APNs key. ShipWarden has no server today.
- Option A: a small relay that sends only the push payload ("Agent needs input" and the worktree name). It does not
  store or see the agent text.
- Option B: use a push service that the user selects (for example ntfy) through an automation. This works today with
  the `http` action, but the text cannot open the app.

**Open questions:** Do we want to run a relay? Pick A or B before any work starts.

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

**Open questions:** Ship a skill file for the CLI, as Orca does?

### 3.2 More MCP tools

**Goal:** Let agents act on PRs and the browser without the user.

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

**Design:** A "Pick element" button in the browser tab. Click an element to send its HTML, its styles, its selector,
and a screenshot to the agent of the worktree.

**Files:** `src/main/browser/browser-views.ts`, `src/renderer/src/components/BrowserView.tsx`.

## Phase 4: Agents work together

### 4.1 Coordinator and workers

**Goal:** Give a large task to one agent. It splits the work and starts worker agents.

**Design:**

- Add the MCP tools `start_worker`, `list_workers`, and `wait_for_worker` for a coordinator agent.
- Each worker gets its own worktree and its own task. Its result (PR link and summary) goes back to the coordinator.
- Reuse plans for the data model. A coordinator run is a plan with steps that the agent makes.
- Tell the coordinator when a worker stops or waits for 10 minutes.
- Check the usage budget and the queue limit for each worker.

**Files:** `src/main/mcp/tools.ts`, `src/shared/plans.ts`, `src/main/plans/plan-store.ts`, `src/shared/ask-agent.ts`.

**Open questions:** Can a worker start workers? Set a depth limit of 1 at first.

### 4.2 Native Slack integration

**Goal:** Get agent questions in Slack and answer them there.

**Design:**

- A Slack app with a bot token. Settings get a Slack section.
- `agent.needsInput` posts the question in a thread. A reply in the thread goes to the agent.
- A message that mentions the app starts an agent on a repository.
- This needs the headless engine of 2.1, or it works only while the app is open.

**Open questions:** Socket Mode removes the need for a public URL. Is that enough for teams?

## Phase 5: Small gaps

### 5.1 Open in an external editor

**Status:** Done in branch `5.1-external-editor`. ⌥⌘O opens the active file at its cursor line, or the selected
worktree. The editor setting is in Settings › Appearance › External editor.

Add "Open in editor" to the worktree menu and the file views. Detect VS Code, Cursor, Zed, and JetBrains IDEs. The user
selects one in Settings › Appearance.

### 5.2 Gitea and Forgejo

Add a `gitea` provider kind. Forgejo uses the same API. Follow `src/main/bitbucket/`. Map PRs, reviews, comments, and
Actions runs.

### 5.3 Stack actions

Add "Rebase stack" and "Merge stack" to a plan PR group. Reuse the restack code of plans
(`src/main/plans/plan-store.ts`).

### 5.4 Keybinding remapping

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

| Order | Feature | Size | Why this order |
|---|---|---|---|
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
