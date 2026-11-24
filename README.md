# ShipWarden

ShipWarden is a desktop app that runs many coding agents at the same time.
Each agent works in its own git worktree. You give tasks to agents, watch
their work, review their pull requests and merge the results.

A ship warden keeps watch over the ships in a harbor and sends each ship
safely on its course. This app does the same job for coding agents.

## Goals

1. **Task sources that anyone can add.** ShipWarden defines an open plugin
   spec for task trackers. ShipWarden includes seven plugins: GitHub
   Issues, Linear, ClickUp, Jira, Azure Boards, Trello, and Local tasks. The community can
   write plugins for other trackers.
   Each plugin controls how its tasks show in the task UI.
2. **A real code editor.** ShipWarden includes a full editor with LSP
   support. Go to definition, find references, hover info and diagnostics
   must work in every worktree.
3. **Full pull request reviews.** You can read diffs, write inline
   comments, request changes and approve a PR in the app.
4. **GitHub Actions.** You can see check runs, read logs, run workflows
   again and send a failed job back to an agent.
5. **Mobile app (beta).** An iPhone app shows agent status and lets you
   approve or reply to an agent, or start a new agent on a task or a prompt.

## Status

ShipWarden is an Electron app. It can open a repository, create and remove worktrees,
and run Claude Code or a shell in each worktree. The terminals use Ghostty's terminal
engine (ghostty-web) and your Ghostty config. A Files panel shows the worktree, filters
file names, searches file contents and opens files in a Monaco editor. Language servers
give go to definition, find references, hover, completion, diagnostics, rename and quick
fixes (code actions). TypeScript works with no setup. For Rust, Python and Go, ShipWarden
uses the language server in your PATH. When the server is missing, the editor offers to
install it into the app's data folder. ShipWarden asks you before each download:

- Rust: the `rust-analyzer` binary of the latest GitHub release, for the CPU of your Mac.
- Python: the `basedpyright` package from the npm registry. Node is not necessary.
- Go: `go install golang.org/x/tools/gopls@latest`. Go must be in your PATH.

The downloads use the CA certificates of Settings › Network.

The right panel also shows the pull request of the worktree's branch and its GitHub Actions
checks. You can review diffs with inline comments, approve, request changes, merge, read job
logs, run jobs again and send a failed job or a review comment to the agent. First add a
GitHub, Azure DevOps, GitLab, or Bitbucket provider in Settings › Code review. The GitHub provider uses a saved
token or your GitHub CLI login (`gh auth login`). The GitLab provider works with gitlab.com and with a
self-hosted server. It uses a saved token or your glab CLI login (`glab auth login`). The Bitbucket provider works
with Bitbucket Cloud (bitbucket.org). It uses an Atlassian API token with your email, or a workspace, project, or
repository access token.

The Agents view (⌥⌘2) shows all running agents in one list. Each row shows the state of the agent
(needs input, blocked on CI, working or done), the time since its last output, and its pull request
with the CI state. Click a row to open the agent's terminal. The header shows the plan usage of
Claude and Codex. For Claude Code and Codex, each row also shows the tokens of the agent session, and the
header shows the tokens of the running agents since midnight. ShipWarden reads these counts from
the Claude Code transcripts and the Codex session files. The other agents show no token count.

Codex reports its state through hooks, as Claude Code does. Codex runs a hook only after you trust it. Start Codex in
ShipWarden one time, type `/hooks`, and trust the 7 ShipWarden hooks under "Session flags". Until then, ShipWarden
shows a Codex agent as "working" while its terminal prints output.

Move the pointer over the state of an agent to see why it does not work. Examples are "Waiting for a permission
prompt", "The agent is asking a question", "Waiting for your reply", "Waiting for CI", and "The process stopped". The
iPhone app shows the same reason below the agent name.

When two worktrees of a repository change the same file, ShipWarden shows a warning before GitHub reports a merge
conflict. The Agents view and the Changes tab show a chip such as "Also changed in feat-login". Hover over the chip, or
click it in the Changes tab, to see the files. ShipWarden compares the commits since the default branch, the staged
files, the unstaged files, and the new files. It uses local git only. The `worktree.overlap` automation trigger can
send a note to the agents.

To rebase a worktree onto the default branch, right-click the worktree in the sidebar and select **Rebase onto Default
Branch…**. The PR tab has **Rebase onto** and the base branch of the pull request in the conflict banner and in the
**More actions** (…) menu. ShipWarden fetches origin and runs `git rebase`. It refuses uncommitted changes and does
not stash them. When a commit has a conflict, the Changes tab shows "Rebase in progress" with the files. Resolve and
stage the files, then click **Continue**. You can also click **Skip** or **Abort**. **Send to agent** gives the agent
the files, the commits of both sides, and the other worktrees that change the same files. A rebase that you start in a
terminal shows the same state. ShipWarden never pushes after a rebase without a question. Then it pushes with
`--force-with-lease`.

A plan stacks its steps by default. Each step in a repository starts from the branch of the step before it, and its
pull request targets that branch. When a lower pull request merges, ShipWarden runs `git rebase --onto` on the next
branch and changes the base of its pull request. This also works after a squash merge. A conflict goes to the agent of
the worktree. See [Plans](docs/plans.md#stacked-pull-requests). The PR group of the plan has **Rebase stack** and
**Merge stack**. They rebase and push each branch onto its parent, or merge the ready pull requests from the bottom up.
Both stop at the first problem. See [Stack actions](docs/pr-groups.md#stack-actions).

The Tasks view shows the tasks of a task tracker. Task trackers are plugins. ShipWarden
includes seven: GitHub Issues, Linear, ClickUp, Jira, Azure Boards, Trello, and Local tasks. Anyone can write a
plugin with the [ShipWarden Task Protocol](docs/task-plugin-protocol.md). "Start in worktree" creates a branch
for a task and gives the task to a new agent.

The Jira plugin supports Jira Cloud. It needs the site URL, the email of your Atlassian account, and an API token. Each
Jira project is a collection. The task fields show the issue type, the sprint, the components, and the story points. The
filters are "Assigned to me", "Current sprint", "All open issues", and "All issues". A status change uses a transition
of the Jira workflow. ShipWarden shows the descriptions and the comments as Markdown. An attachment in a description
shows as a placeholder, and then you cannot edit that description in ShipWarden, because the edit would remove the
attachment.

### Search all transcripts

Type in **Search transcripts** in the header of the Agents view to search all your Claude Code sessions. Use it to
answer questions such as "Which agent changed `auth.ts` last week, and why?" The search reads the prompts that you
typed, the text of the agent, and the file paths of the tool calls. It does not read the tool output. Filter the results
by repository, model, and date. Each result shows the session, the text around the match, and the time of the match.
Click **Resume** to continue the session in its worktree, or use the menu to resume it in another worktree. A session
that runs now opens its tab.

ShipWarden keeps the search index in `transcript-index.db` in the app data folder. The index is an SQLite FTS5 table
(the built-in `node:sqlite` module). It reads only the new lines of a changed transcript. At the first start, it reads
all transcripts in the background, the newest first. The view shows "Indexing transcripts" until the index is ready.
The search sends no network request.

### Agent stats

Open **Stats** in the sidebar to see data that helps you choose agents and models. Select the last 7, 30, or 90 days,
and one row for each agent or each model. The view shows:

- The merged pull requests, and the median tokens of each merged pull request.
- The median time from "Start in worktree" to the merge.
- The part of the agent time in "needs input" and in "blocked on CI".
- The part of the pull requests whose first push failed CI.
- The wins in Compare agents ("Keep this one"), for example "2 of 5".

A number that the log cannot give shows "No data". Only Claude Code and Codex give a token count. Agents without
hooks give no states, so their time does not count. Codex sends hooks only after you trust them. Only the merges in ShipWarden count. A merge without a
"Start in worktree" line measures the time from the first agent state in the worktree.

ShipWarden writes a small event log for the stats to `agent-stats.jsonl` in the app data folder. It adds one line at
each agent state change, each "Start in worktree", each change of the CI state of a worktree pull request, each pull
request merge in ShipWarden, and each "Keep this one" in Compare agents. The CI state comes from the pull request data
that ShipWarden loads already. The log has no prompts and no code. ShipWarden removes the lines older than 90 days at
start. The Stats view reads only this log. It sends no network request.

### Compare agents

"Compare agents" gives one task to 2 to 4 agents at the same time. Then you keep the best result.

1. Open a task and click **Compare agents**. Select the agents. The list shows only the agents of Settings › Agents
   that are in the PATH of your login shell.
2. ShipWarden makes one worktree and one branch for each agent. The branch is the name from the branch template with
   the agent at the end, for example `ENG-12-fix-login-codex`. Each agent gets the task, the same as with
   "Start in worktree".
3. The task details show the compare list. Each row shows the agent, its state, the changed files, the added and
   removed lines since the branch left the default branch, and the CI state when the branch has a pull request.
   **Diff** shows the changes of each file.
4. Click **Keep this one** on the best run. ShipWarden asks before it removes the worktrees of the other agents. Git
   keeps their branches. A worktree with uncommitted changes stays.

ShipWarden does not open pull requests for the runs. Open a pull request from the kept worktree as usual. The
comparisons are in `agent-compare.json` in the app data folder.

### Task queue

The task queue runs a backlog while you sleep. It starts the tasks one after the other and keeps a limit of agents.

1. Open a task and click **Add to queue**. The repository is the repository that "Start in worktree" uses.
2. Open **Queue** in the sidebar. Drag the queued tasks to change the order, or press ⌥↑ and ⌥↓.
3. Set **Agents at the same time**, for example 3. When an agent finishes, the next task starts.
4. Select when an agent is finished: when it opens a pull request, or when it is idle for a set time. An agent that
   exits is always finished.

Each task gets a new worktree from the branch template and the agent of its repository, the same as with
"Start in worktree". A failed start goes to the end of the queue with its error, and waits one minute. After 3 failed
starts, the task stops, and **Try again** puts it back. The queue runs while ShipWarden is open, and while it is closed
when the Automations view has "Run while ShipWarden is closed" on. It continues after a restart of the app. The queue is in `task-queue.json` in the app data folder. The `queueTask` automation action adds
the new tasks of a collection to the queue.

### Usage budget

A usage budget stops new agents before the plan usage of Claude or Codex runs out. Set it in Settings › Agents ›
**Usage budget**, for example "Stop new agents at plan usage: 80%". Select **All limits** or **Only the 5-hour limit**.

While the usage is at or above the budget, the queue, plans, Compare agents, and the "Start an agent" automation action
do not start new agents. The queue and the plans show "Waiting for usage to reset" with the reset time, and continue
after the reset. The Compare agents dialog disables **Start** until the reset. A held automation run starts after the
reset. Agents that work now continue. Agents other than Claude Code and Codex have no usage data, so the budget does not
stop them. Just after ShipWarden starts, a set budget waits until the usage loads ("Waiting for usage data"). When
ShipWarden has no usage data after that (no sign-in, or a failed request), the budget does not stop a start.

The automation trigger "Plan usage reached" (`usage.threshold`) runs one time when a limit reaches a percent. It runs
again only after the limit resets. Use it to show a notification or to post a message.

### Checkpoints and rewind

A checkpoint lets you undo one bad agent turn and keep the good turns before it.

When an agent gets a prompt, ShipWarden saves all the files of the worktree as a hidden git commit: the tracked files
with their uncommitted changes and the new files that .gitignore does not ignore. The save does not change your index,
your files, or your stash list. When nothing changed since the last checkpoint, ShipWarden skips it. Claude Code,
Gemini CLI, opencode, and Codex tell ShipWarden about each prompt through their hooks. Agents without a turn hook, for
example Codex before you trust its hooks, get a checkpoint when their terminal output stops for 15 seconds. That checkpoint is the state after the turn.
ShipWarden saves checkpoints only while it is open.

1. Open the **Checkpoints** tab in the right panel of a worktree. It lists the turns of each agent session, with the
   prompt and the files that changed after it.
2. Click **Rewind** on a turn. The dialog shows the files that change and the diff first.
3. Click **Rewind** in the dialog. ShipWarden writes the files of the checkpoint again, also deleted and binary files.
   It deletes the files that are new since the checkpoint. Files that .gitignore ignores stay.

ShipWarden saves the current files before each rewind, so you can rewind back. Commits that the agent made after the
checkpoint stay on the branch. The dialog asks if you also want to move the branch back with `git reset`. Without the
reset, the index does not change. ShipWarden does not tell the agent about a rewind. Select **Tell the agent about the
rewind** to send a short note to its terminal. Stop the agent before you rewind.

The checkpoints are refs under `refs/shipwarden/checkpoints/` in the repository. ShipWarden removes them when it removes
the worktree, and removes the checkpoints older than 7 days at start.

### Branches

The Branches page lists the local and the remote branches of a repository in a table. To open it, put the pointer on a
repository in the sidebar and click the branch icon. The commit graph page also has a link to it.

- The table groups the branches by prefix. The branches of a plan (`plan/<plan>/<step>-<name>`) show their step
  number, and the group shows how many steps merged. A prefix with only one branch goes into **Other**. Set **Group
  by** to **None** for one flat list.
- Each row shows the ticket, the type and subject of the last commit, the remote state, and the age. The ticket comes
  from the plan step or the task link of the worktree, else from a key in the branch name or the commit subject.
- The remote state is the commits ahead and behind (↑3 ↓2), **local only**, or **remote deleted** after the remote
  branch is gone. A folder icon marks a branch that a worktree has checked out.
- The chips show only some branches: **Has worktree**, **Diverged** (ahead or behind), **Local only**, **Remote
  deleted**, and **Older than 7d**. The filter field matches the name, the ticket, and the commit subject.
- The default branch has its own card at the top. When it is behind its remote branch, **Pull** fetches and
  fast-forwards it.
- When some remote branches are gone, a notice shows. **Review and clean up** selects the **Remote deleted** chip.
- **Check out** checks out the branch in the main folder of the repository. For a remote branch, git makes the local
  branch and sets the remote branch as its upstream. **Open** goes to the worktree of the branch.
- The trash icon deletes a branch. A local branch with commits that are not merged into the default branch stays until
  you agree again. A remote branch always asks first, because the delete changes the remote for all people.
- **Delete all** deletes all the shown local branches, except the default branch and the branches that are checked
  out. With a chip or a filter, the button deletes only the shown branches. The remote branches stay.
- The refresh button fetches all remotes and removes the remote branches that do not exist now. The page does not
  fetch at other times.

### Screenshots of visual changes

The Screenshots tab of a worktree shows the visual result of a frontend change. It captures each page for the branch
and for the base, and shows the two images side by side.

1. In Settings › Repositories, add the preview URL of your dev server (for example `http://localhost:3000`) and the
   paths of the pages. You can also set a wait (milliseconds or a CSS selector) and the page width.
2. Run the dev server in the worktree, and click **Capture branch**.
3. Stop it. Run the dev server in the main worktree of the repository, and click **Capture base**.
4. Click **Add to PR** to upload the images in one comment. ShipWarden asks before it posts.

ShipWarden never starts or stops a dev server, and it cannot see which worktree the server uses. The images stay in
the app data folder, with the commit of each side. On GitHub, the images go to the branch `shipwarden-screenshots` of
the repository. Azure DevOps keeps them as attachments of the pull request, and GitLab keeps them in the uploads of the
project. Bitbucket Cloud has no API for images in comments, so **Add to PR** does not show for Bitbucket. See [docs/screenshots.md](docs/screenshots.md).

### Send a page element to an agent

The toolbar of a browser tab has a **Pick element** button (the pointer in a dashed square).

1. Click **Pick element**. A box shows above the element under the pointer.
2. Click the element. Press Escape to stop.
3. Add a note (optional), select the agent, and click **Send to agent**.

The agent gets the selector of the element, its size, its text, the computed styles that matter (for example display,
size, spacing, colors, and font), its HTML (cut at 6000 characters), and the path of a screenshot of the element. The
screenshot is a PNG file in the temporary folder of macOS. It shows only the part of the element in the viewport. The
first agent that runs in the worktree gets the element by default. You can also select another running agent, or a new
agent. The picker does not work in frames of other sites.

### Open in an external editor

Open a worktree or a file in your own editor. ShipWarden finds VS Code, VS Code Insiders, Cursor, Windsurf, Zed, and the
JetBrains IDEs (IntelliJ IDEA, WebStorm, PyCharm, GoLand, PhpStorm, RubyMine, CLion, Rider, RustRover, and Android
Studio) in `/Applications` and `~/Applications`.

- Right-click a worktree in the sidebar and click **Open in** and the name of the editor.
- In a file tab, click the open icon in the path bar, or press ⌥⌘O. The file opens at its cursor line. Without a file
  tab, ⌥⌘O opens the selected worktree.
- In the file explorer, right-click a file and click **Open in** and the name of the editor.

Select the editor in Settings › Appearance › External editor. Without a selection, ShipWarden uses the first editor of
the list above. VS Code, its forks, and Zed open the worktree and the file in one window. A JetBrains IDE opens the
worktree as a project, and then the file in it. A file tab of the Terminal view opens the worktree that contains the
file.

### ShipWarden MCP server

Agents can ask ShipWarden and each other for help, work on their pull requests, and test their changes in the browser,
without an automation in the middle. ShipWarden runs a local MCP
server on 127.0.0.1. Each new agent tab of Claude Code, Codex, Gemini CLI, or opencode gets it at start. ShipWarden does
not change your config files, and your own MCP servers stay. The tools act on the worktree of the agent:

| Tool | What it does | Approval |
| --- | --- | --- |
| `list_worktrees` | Lists the worktrees of the repository, with their branches, tasks, pull request states, and agents. `all` lists all projects. | No |
| `get_overlaps` | Lists the files that this worktree and other worktrees both change. | No |
| `get_task` | Returns the task of this worktree, with the newest comments. | No |
| `ask_agent` | Asks the agent of a different worktree a question and waits for the answer. The other agent runs in print mode and does not change files. | First time in each worktree |
| `set_task_status` | Moves the task of this worktree to a different status. | First time in each worktree |
| `get_pull_request` | Returns the pull request of the branch, with its reviews, comments, and open review threads. | No |
| `get_checks` | Returns the CI checks of the head commit. It can save the logs of the failed GitHub Actions jobs. | No |
| `create_pull_request` | Creates a pull request from the branch, on the code host of the repository. | First time in each worktree |
| `update_pull_request` | Changes the title, the description, the draft state, the base branch, or the state. | First time in each worktree |
| `reply_to_comment` | Replies to a review comment on a line of code. | First time in each worktree |
| `watch_pull_request` | Sends the agent a message when a check fails, a conflict occurs, or a person comments. | No |
| `open_page` | Opens an address in the browser tab of the worktree. | First time in each worktree |
| `read_page` | Returns the text of the page and its links, buttons, and fields. | No |
| `screenshot` | Returns an image of the page. | No |
| `click` | Clicks a link or a button. | First time in each worktree |
| `type` | Types text into a field. | First time in each worktree |
| `start_worker` | Starts a worker agent in a new worktree with a part of a large task. | First time in each worktree |
| `list_workers` | Lists the workers of this agent, with their states, pull requests, and reports. | No |
| `wait_for_worker` | Waits until a worker finishes, stops, or needs attention. | No |
| `report_result` | A worker sends its result to the agent that started it. | No |

An agent can split a large task and start workers with `start_worker`. Each worker gets its own worktree, branch, and
task. ShipWarden tells the coordinator when a worker sends its result, stops, or waits for 10 minutes. A worker can
start its own workers up to the limit of Settings › Agents › Worker depth (the default is 2). The usage budget and the
queue limit apply to each worker. The Plans view shows each coordinator run with its workers.

The first call of a write tool in a worktree shows a dialog. **Allow** applies to that tool in that worktree until you
revoke it in Settings › Agents › MCP server. Without an answer in 2 minutes, the tool call fails with a clear error.
Each agent session has its own token. A request without the token gets 401. Turn the server off in Settings › Agents.
See [docs/mcp-server.md](docs/mcp-server.md) for the options that each agent gets.

### The shipwarden command

Agents, scripts, and you can control ShipWarden from a terminal with the `shipwarden` command. Install it in Settings ›
Agents › Command line. It adds a link in `/usr/local/bin` or `~/.local/bin`. ShipWarden must be open.

```sh
shipwarden status
shipwarden worktree list --all
shipwarden worktree create fix/login --prompt "Fix the login timeout. Run the tests." --wait
shipwarden agent send "Which API does the parser use?" --worktree feature/parser --wait
shipwarden task status "In review"
shipwarden automation run nightly-review
```

The commands that change something use the approvals of the MCP server. `--json` prints the result for scripts.
`shipwarden skill install` gives Claude Code a skill file that explains the command. See [docs/cli.md](docs/cli.md).

The Automations view (⌥⌘7) runs rules of the form "when this occurs, do that" while ShipWarden is open. With "Run while
ShipWarden is closed", the background helper also runs the schedules, the CI failures, and the task queue while no
window is open, and the iPhone app can approve the runs that are waiting for approval. For example:
send a CI failure or a review comment to the agent of the worktree, start an agent on each task that gets a label,
post to Slack when an agent waits for your input for 10 minutes, or remove the worktree after its pull request merges. Each automation is a JSON file in `~/.shipwarden/automations` that
you can export and share. Runs can wait for your approval, and limits stop loops. See
[docs/automations.md](docs/automations.md).

Prompt templates save the prompts that you type often, for example "Write tests for {{file}}". They use the same
variables as the automations. Insert a template from the Prompts list of an agent terminal, from the command palette,
or with its own shortcut. A variable without a value gets a field before the insert. Each template is a JSON file in
`~/.shipwarden/prompts`. See [docs/prompt-templates.md](docs/prompt-templates.md).

At the first start, a welcome page checks your tools (git, the agent and GitHub access), helps you add or clone a
repository, choose your agent and start the first agent. Help › Show Welcome opens it again. A short guided tour shows
the main parts of the window. Help › Take the Tour starts it at all times. Help › Keyboard Shortcuts lists all keys.
A new user also gets a getting started checklist on the Dashboard.

Tips show the features that are easy to miss. At each start, one random tip from a list of 48 shows in the
bottom-right corner. While ShipWarden stays open, a new tip shows 12 hours after you close the last one. A tip does not
show again within 10 tips. Some views have their own tip, for example the Dashboard. Close a tip in a view, and it does not show again.
Turn off the tips in the corner notice or in Settings › Appearance › Tips.

The iPhone app (`ios/`) connects to ShipWarden on your Mac over your network. It shows the
agents and their terminal screens, the worktrees with their pull requests and CI state. You
can reply to an agent, answer its questions, approve a pull request, and approve or skip an automation run that is
waiting for approval. Turn it on in
Settings › Mobile and pair the phone with the QR code. See [ios/README.md](ios/README.md).

The phone can also start an agent in a new worktree, on a task or a prompt, with the agent and the model that you
select. A new phone cannot do this. Turn on **Start agents** for the phone in Settings › Mobile. The start uses the
same code as "Start in worktree" and the usage budget of Settings › Agents. While ShipWarden is closed, the background
helper starts the agent from a prompt. A start on a task needs the app.

The phone can get a push notification when an agent needs input or an automation is waiting for approval, also when
the app on the phone is closed. A tap opens the agent. The notifications go through a small push relay that you deploy
(see [relay/README.md](relay/README.md)). The relay sees only the worktree name and IDs, never the agent text. Turn on
**Send push notifications** in Settings › Mobile and type the relay address.

ShipWarden can also post the questions of your agents to a Slack channel. A reply in the thread goes to the agent, and
a message such as `@ShipWarden web Fix the login bug` starts an agent in a new worktree. Only the Slack members on the
allow list can start or answer agents. The Slack app uses Socket Mode, so your Mac needs no public address. Create the
app from the manifest in [docs/slack.md](docs/slack.md), then add its tokens in Settings › Slack.

> The iPhone app is in beta. It is in App Store review now, so it is not in the App Store yet. Until
> Apple approves it, build it from source with Xcode. See [ios/README.md](ios/README.md).

## Install and get started

ShipWarden is for Macs with Apple silicon. Do these steps in this order:

1. Install `git`, the GitHub CLI and an agent, for example Claude Code. Then run `gh auth login`.
2. Download the DMG from the [releases page](https://github.com/austinChappell/shipwarden/releases).
   Install ShipWarden from it.
3. In the sidebar, click **Add a repository**. Select a local clone.
4. Open **Settings › Code review**. Add a GitHub, Azure DevOps, GitLab, or Bitbucket provider. The Dashboard stays empty
   until you do this.
5. Press ⌘N. Type a branch name. Click **Create worktree**. An agent starts in the new worktree.

For all the steps, see [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

## Development

You need Node 24 or later and git.

```sh
npm install        # also downloads Electron and fixes the node-pty helper
npm run dev        # starts the app with hot reload. A change in the main process restarts the app.
npm run dev:fresh  # starts the app with empty app data in /tmp/sw-fresh, to test the onboarding
npm test           # runs the unit tests
npm run check      # checks the format and runs the linter (Biome). CI runs it on each pull request.
npm run format     # formats all files
npm run check:ios-contract  # checks that the iPhone models agree with src/shared/remote.ts
npm run typecheck
npm run build      # builds to out/
npm start          # runs the built app
npm run dist:dir   # builds dist/mac-arm64/ShipWarden.app
npm run dist       # builds the app and dist/ShipWarden-<version>-arm64.dmg
```

### macOS app

`npm run dist` signs the app with the certificate in `build.mac.identity` in `package.json`. That certificate must be in your login keychain. When the `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` variables are set, it also notarizes the app. See [docs/RELEASING.md](docs/RELEASING.md). The packaged app keeps these files outside `app.asar`, because macOS cannot run a file from an archive:

- the built-in task plugins, in `Contents/Resources/plugins`
- node-pty and its `spawn-helper`
- the native TypeScript binary for the language server

The app icon source is `build/icon.svg`. `build/icon.png` is a 1024 × 1024 render of it (`rsvg-convert -w 1024 -h 1024 build/icon.svg -o build/icon.png`).

Environment variables:

| Variable | Effect |
|---|---|
| `SHIPWARDEN_REPO=/path/to/repo` | Adds this repository to the active project at start. |
| `SHIPWARDEN_WORKTREES_DIR=/path` | Puts new worktrees here. The default is `~/.shipwarden/worktrees`. |
| `SHIPWARDEN_DEBUG_PORT=9333` | Opens the Chrome DevTools Protocol on this port, for automated UI checks. |
| `SHIPWARDEN_USER_DATA_DIR=/tmp/sw-fresh` | Uses this folder for the app data, to test a first start. See below. |

#### Test a first start

Do not delete `~/Library/Application Support/ShipWarden` to test a first start. Start the app with a separate, empty data folder:

```sh
npm run dev:fresh
```

This script deletes `/tmp/sw-fresh` and then runs `SHIPWARDEN_USER_DATA_DIR=/tmp/sw-fresh npm run dev`. To keep the data of the last test, run that second command yourself.

- The app does not copy the old Yardmaster data into this folder, and it does not connect to the PTY host of the old name.
- The PTY host socket is in the data folder, so the app starts a second PTY host. Quit it with ⇧⌥⌘Q after the test.
- The worktrees, notes, plugins and automations in `~/.shipwarden` are still your real folders.
- `npm run dev:fresh` deletes the folder each time, so each run is a first start.

### Repo layout

| Path | Contents |
|---|---|
| `src/main/` | The Electron main process: worktrees, files, GitHub, tasks, Ghostty config import |
| `src/main/pty-host/` | The PTY host process that keeps terminals and agents alive when the app quits |
| `src/cli/` | The `shipwarden` command. `bin/shipwarden` runs it with the Node of the app |
| `src/main/cli/` | The socket server and the commands of the CLI |
| `skills/shipwarden/` | The agent skill file of the CLI |
| `src/preload/` | The bridge that gives `window.shipwarden` to the UI |
| `src/renderer/` | The React UI |
| `src/shared/` | Types and functions that the main process and the UI both use |
| `src/main/remote/` | The HTTPS server for the iPhone app |
| `src/main/push/` | The push notifications to the iPhone app, through the relay |
| `src/main/slack/` | The Slack connection (Socket Mode): agent questions, replies, and agent starts |
| `relay/` | The push relay: a small Node server with the APNs key. It keeps no data. |
| `ios/` | The iPhone app (SwiftUI) |
| `docs/ARCHITECTURE.md` | Decisions and the plan |

### Native install scripts

npm 11 does not run install scripts until you approve them. The `allowScripts` field in
`package.json` lists the approved packages. If you change a native dependency, run
`npm install-scripts ls` and approve the new version.
