# ShipWarden improvement plan

This plan lists the next features for ShipWarden. It does not include ports and services for each worktree.

The features are in 5 phases. Each phase can ship alone. Each feature has a goal, a design, the files to change, the
tests, and the open questions. File paths are the best start point today. They can change during the work.

## Rules for all phases

- Keep all network data in TanStack Query. A write updates the cache. Do not refetch to show a change.
- New network code uses the CA certificates of Settings › Network.
- New UI follows the 3 boards in `docs/design`. Use the Combobox for long lists. Buttons are inline and right-aligned.
- Write the UI text and the docs in Simplified Technical English. Update the README and `docs/` in the same PR.
- Add each new feature to the tips list (`src/shared/tips.ts`) when it is easy to miss.

## Phase 1: Know what the agents do

### 1.1 Agent stats

**Goal:** Show data that helps you choose agents and models.

**Design:**

- Add a Stats view to the sidebar. It shows the last 7, 30, or 90 days.
- The view shows these numbers for each agent and each model:
  - Tokens for each merged PR.
  - The median time from "Start in worktree" to merge.
  - The part of the time that agents spend in "needs input" and in "blocked on CI".
  - The CI failure rate of the first push.
  - The wins in Compare agents ("Keep this one").
- Collect the data from sources that exist now: the Claude Code transcripts, the agent states, the PR summaries, and
  `agent-compare.json`.
- Store one small event log in the app data folder (`agent-stats.jsonl`). Write one line at each state change, merge,
  and compare result. Do not read the full transcripts again for each view.
- Use local data only. The view sends no API requests.

**Files:**

- New: `src/main/stats/stats-store.ts`, `src/shared/stats.ts`, a Stats view in `src/renderer/src/`.
- Read from: `src/main/agents/transcript-watcher.ts`, `src/shared/agent-tokens.ts`, `src/shared/agent-overview.ts`,
  `src/main/compare/compare-store.ts`.

**Tests:** Unit tests for the math in `src/shared/stats.ts` (medians, rates, and empty data). A store test for the
append and the read of the log.

**Open questions:**

- Codex and the other agents give no token count. Show "No data" for them, or hide the token columns?
- Keep the log for all time, or remove the lines older than 90 days?

### 1.2 Search across all transcripts

**Goal:** Answer questions such as "Which agent changed `auth.ts` last week, and why?"

**Design:**

- Add a search field to the Agents view, with a filter for the repository, the agent, and the dates.
- Index the Claude Code transcripts that ShipWarden already watches. Index the user prompts, the agent text, and the
  file paths of the tool calls.
- Use SQLite FTS5 in the main process. Store the index in the app data folder. Update it from the transcript watcher.
- A result opens the session. A pinned session can resume in any worktree, as it does today.

**Files:**

- New: `src/main/agents/transcript-index.ts`.
- Change: `src/main/agents/transcript-watcher.ts`, `src/main/agents/transcript-reader.ts`, the Agents view.

**Tests:** Index and search tests with fixture transcripts. A test that a changed transcript updates only its new lines.

**Open questions:**

- Is `better-sqlite3` acceptable as a native dependency, or is a pure JS index better for the build?
- Index the tool output too? It gives better results, but the index gets much larger.

### 1.3 Explain why an agent is idle

**Goal:** Tell the user why an agent does not work.

**Design:**

- Add a reason to each idle state in the Agents view. Examples: "Waiting for a permission prompt", "Waiting for CI",
  "The process stopped", and "Waiting for your reply".
- Get the reasons from the hook events (`src/main/agents/hook-server.ts`), the PTY host, and the CI state.
- Show the reason in a tooltip on the state chip and in the iPhone app.

**Files:** `src/shared/agent-overview.ts`, `src/main/agents/hook-server.ts`, `src/shared/remote.ts`.

**Tests:** Unit tests that map each hook event and process state to its reason.

## Phase 2: Control the work

### 2.1 Task queue with a limit

**Goal:** Give a backlog to ShipWarden and let it run the tasks overnight.

**Design:**

- Add "Add to queue" next to "Start in worktree" on a task.
- The queue has a limit, for example "Run at most 3 agents". When an agent finishes, the next task starts.
- "Finished" means the agent opened a PR, or it was idle for a set time with no PR. The setting selects which.
- The queue has its own page with drag to change the order, as plan steps do.
- Each queue item uses the branch template and the agent of the task. A failed start goes to the end with its error.

**Files:**

- New: `src/main/queue/queue-store.ts`, `src/shared/task-queue.ts`, a Queue page.
- Reuse: the start code of "Start in worktree" and the concurrency limit code of automations (`maxRunning`).

**Tests:** Unit tests for the scheduler: the limit, the order, a failure, and a restart of the app with a full queue.

**Open questions:**

- Is the queue global, or one queue for each project?
- Can an automation add a task to the queue? (A new `queueTask` action.)

### 2.2 Usage budgets

**Goal:** Stop new agents before the plan usage runs out.

**Design:**

- Add a budget to Settings › Agents. Example: "Do not start new agents above 80% of the 5-hour limit".
- The queue, plans, Compare agents, and the `startAgent` action check the budget before they start an agent.
- A blocked start waits and shows "Waiting for usage to reset" with the reset time. It does not fail.
- Add a `usage.threshold` automation trigger, so a user can send a notification or a message.

**Files:** `src/main/usage/usage-service.ts`, `src/shared/usage.ts`, `src/shared/automations.ts`, and the start paths.

**Tests:** Unit tests for the budget check at, below, and above the limit, and with no usage data.

**Open questions:** Should a budget also pause the agents that run now, or only block new agents?

### 2.3 Checkpoints and rewind

**Goal:** Undo one bad agent turn and keep the good turns before it.

**Design:**

- At the start of each agent turn (the `UserPromptSubmit` hook), save the worktree state with `git stash create`. Save
  the commit in a hidden ref: `refs/shipwarden/checkpoints/<session>/<turn>`. This includes the uncommitted files and
  does not change the index or the files.
- Save the new files that git does not track too. `git stash create` does not include them, so use a temporary index
  (`GIT_INDEX_FILE`) and `git add -A`.
- Show the turns of a session in a list, each with its prompt and its changed files.
- "Rewind to before this prompt" shows the diff first. Then it restores the files. Commits that the agent made after
  the checkpoint stay on the branch, and ShipWarden asks before it resets them.
- Remove the checkpoint refs when the worktree goes away, and after 7 days.

**Files:**

- New: `src/main/git/checkpoints.ts`, `src/shared/checkpoints.ts`.
- Change: `src/main/agents/hook-server.ts`, `src/main/worktrees/git-worktree-service.ts` (clean up on remove).

**Tests:** Git tests in a temporary repository: tracked changes, new files, deleted files, binary files, and a rewind
past a commit.

**Open questions:**

- Claude Code has its own rewind. Should ShipWarden tell the agent about the rewind, so its context agrees with the
  files?
- Other agents have no turn hook. Use the `agent.done` event for them?

## Phase 3: Integrations

### 3.1 GitLab review provider

**Goal:** Support teams that use GitLab, on gitlab.com and on self-hosted servers.

**Design:**

- Add a `gitlab` provider kind next to GitHub and Azure DevOps. Map merge requests, discussions, approvals, and
  pipelines to the shared review types.
- Map GitLab pipeline jobs to the checks panel, with logs, retry, and "send to agent".
- Use a personal access token, or the `glab` CLI login. This is the same pattern as the GitHub provider.

**Files:**

- New: `src/main/gitlab/` (client, mapping, service), following `src/main/azure/`.
- Change: `src/main/review-providers.ts`, `src/shared/review-providers.ts`, Settings › Code review.

**Tests:** Mapping tests with recorded API fixtures, as the Azure tests do.

### 3.2 Bitbucket review provider

Do this after GitLab, with the same design. Bitbucket Cloud first. Bitbucket Data Center only when users ask for it.

### 3.3 Jira task plugin

**Goal:** Ship a built-in Jira plugin, because Jira is the most common tracker.

**Design:**

- Add `plugins/jira/` with the ShipWarden Task Protocol. Follow `plugins/linear/` and `plugins/clickup/`.
- Support Jira Cloud with an API token first. Map the issue types, the statuses, the sprints, and the components to
  task fields and filters.
- Convert the Atlassian Document Format of the descriptions to Markdown.

**Files:** `plugins/jira/`, `plugins/package.json`, and the plugin list in the README.

**Tests:** Add Jira to `plugins/plugins.test.js`. Add mapping tests for the ADF to Markdown conversion.

### 3.4 Trigger when an agent needs input

Automations already have `notify`, `http`, and `postMessage`, so a Slack webhook works today. The gap is the trigger.

- Add an `agent.needsInput` trigger. It occurs when an agent waits for a permission or asks a question.
- Add an optional `idleFor` field, so the automation runs only after the agent waits a few minutes.
- Add an example template: "Post to a Slack webhook when an agent waits for 10 minutes".

**Files:** `src/shared/automations.ts`, `src/shared/automation-events.ts`, `src/shared/automation-templates.ts`,
`docs/automations.md`.

## Phase 4: Agents work together

### 4.1 ShipWarden MCP server

**Goal:** Let agents ask ShipWarden and each other for help, without automations in the middle.

**Design:**

- Run a local MCP server in the main process. Listen on 127.0.0.1 with a token for each session, as the hook server
  does.
- Add it to each agent at start. Claude Code gets it with `--mcp-config`. Add the other agents when they support MCP.
- First tools:
  - `list_worktrees`: the worktrees, their branches, their tasks, and their PR states.
  - `get_overlaps`: the files that other worktrees also change.
  - `ask_agent`: send a question to the agent of a different worktree and wait for the answer. Reuse
    `src/main/agents/ask-agent.ts`.
  - `get_task`: the task of this worktree, with the comments.
  - `set_task_status`: move the task of this worktree.
- Each write tool needs approval the first time, with the same approval UI as automations.

**Files:** New `src/main/mcp/`. Change the agent start code in `src/main/agents/` and `src/shared/agent-programs.ts`.

**Tests:** Tool tests with a fake service layer. A test that a request with no token or a wrong token fails.

**Open questions:** Which tools need approval each time, and which only one time?

### 4.2 Stacked PRs for plans

**Goal:** Let plan steps build on each other.

**Design:**

- Add a "Stack the steps" setting to plans. Each step then branches from the branch of the step before it, and its PR
  targets that branch.
- When a lower PR merges, rebase the next branch onto the default branch and change the PR base. Send conflicts to the
  agent of that worktree.
- The PR group shows the stack in order, with the state of each PR.

**Files:** `src/shared/plans.ts`, `src/main/plans/plan-store.ts`, `src/shared/plan-group-order.ts`,
`src/main/github/pull-requests.ts`, and the Azure equivalent.

**Tests:** Unit tests for the branch and base order. Git tests for the rebase after a merge.

**Open questions:** Support squash merges in the stack? A squash merge needs `git rebase --onto` with the old base.

## Phase 5: Better reviews

### 5.1 Rebase onto the default branch with conflict help

**Goal:** Fix merge conflicts in the app.

**Design:**

- Add "Rebase onto main" to the worktree menu and the PR panel.
- When the rebase stops on a conflict, show the files. "Send to agent" gives the agent the conflict, the commits of
  both sides, and the overlap data.
- "Abort" runs `git rebase --abort`. ShipWarden never force-pushes without a question.

**Files:** `src/main/git/git-changes-service.ts`, the Changes tab, and a new `pr.conflict` template.

**Tests:** Git tests for a clean rebase, a conflict, and an abort.

### 5.2 Screenshots of visual changes

**Goal:** Show the visual result of a frontend PR in the review.

**Design:**

- The repository settings get a preview URL and a list of pages to capture.
- "Capture screenshots" opens each page in the browser pane for the branch and for the default branch. Then it saves
  both images.
- The review shows the images side by side. "Add to PR" uploads them in a PR comment.
- Without ports for each worktree, the user starts the dev server. ShipWarden captures one worktree at a time.

**Files:** `src/main/browser/browser-views.ts`, `src/shared/browser.ts`, the repository settings, and the review panel.

**Open questions:** Where do the uploaded images live for Azure DevOps?

### 5.3 Prompt templates

**Goal:** Send repeated prompts quickly.

**Design:**

- Save prompts with variables, for example "Write tests for {{file}}" or "Fix the lint errors in {{branch}}".
- Use the same variables as automations. Each template can have a keyboard shortcut.
- Open the list from the terminal of an agent and from the command palette.
- Store each template as a file in `~/.shipwarden/prompts`, so users can share them, as with automations.

**Files:** New `src/main/prompts/`, `src/shared/prompt-templates.ts`. Reuse the variable code of automations.

## Later

- **Linux and Intel Mac builds.** Do this only when users ask for it. The PTY host uses launchd today
  (`src/main/pty-host`), so Linux needs a different way to keep the agents alive after a force quit.
- **Bitbucket Data Center**, if users ask for it after 3.2.

## Order

| Order | Feature | Size | Why this order |
|---|---|---|---|
| 1 | 1.3 Explain why an agent is idle | S | Small, and it helps at once |
| 2 | 3.4 Trigger when an agent needs input | S | Small, and it uses code that exists |
| 3 | 2.1 Task queue | M | The largest gain for each hour of work |
| 4 | 2.2 Usage budgets | S | The queue needs it to run overnight safely |
| 5 | 1.1 Agent stats | M | Needs a few weeks of data, so start the log early |
| 6 | 2.3 Checkpoints and rewind | M | |
| 7 | 1.2 Transcript search | M | |
| 8 | 3.3 Jira plugin | M | |
| 9 | 5.3 Prompt templates | S | |
| 10 | 5.1 Rebase with conflict help | M | |
| 11 | 4.1 ShipWarden MCP server | L | |
| 12 | 3.1 GitLab provider | L | |
| 13 | 4.2 Stacked PRs for plans | L | Easier after 5.1 |
| 14 | 5.2 Screenshots | M | |
| 15 | 3.2 Bitbucket provider | L | |

Start the event log of 1.1 in the first PR, even before the Stats view exists. Then the view has data when it ships.
