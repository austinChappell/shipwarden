# ShipWarden architecture (draft)

This document is a draft. We change it when we make decisions.

## Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-11-06 | Use Eclipse Theia. | It gives a full IDE with LSP. |
| 2026-11-07 | Remove Theia. Use Electron, React and our own UI. | Theia looks and works like VS Code. The user wants a UI like Orca, with IDE navigation only in the file explorer and the editor. |
| 2026-11-07 | Use our own LSP bridge, not `monaco.lsp`. | `monaco.lsp` in Monaco 0.57 always sends `rootUri: null`, has no dispose, and selects documents only by language. With two worktrees, both servers would answer for each file. |
| 2026-11-07 | Use `tsc --lsp --stdio` from TypeScript 7 for TypeScript and JavaScript. | TypeScript 7 is native (Go) and has a built-in language server. It needs no Node process and no typescript-language-server. |
| 2026-11-07 | The phone connects to the main process over HTTPS on the local network, with a pinned self-signed certificate. | No server or account is necessary. A pinned certificate protects the token on a shared network, and it does not need a public CA. |
| 2026-11-07 | The Mac sends the terminal screen to the phone as styled text, not the raw output. | A headless xterm.js makes the screen from the same output. The phone needs no terminal emulator, and a dependency (SwiftTerm) is not necessary. |
| 2026-11-07 | Use ghostty-web for terminals and import the user's Ghostty config. | This is Orca's approach (Orca imports the Ghostty config into xterm.js), with Ghostty's own VT parser in place of xterm.js. Supacode embeds the native libghostty, but that needs a Swift app. |
| 2026-11-09 | Show PDF files in the built-in PDF viewer of Chromium, in a frame that loads a `shipwarden-file:` URL. | It needs no dependency. pdfjs-dist adds about 3 MB and a worker. The viewer has search, zoom and page thumbnails. |
| 2026-11-09 | The Review view gets go to definition and a file explorer from a hidden, detached git worktree at the PR head. | A language server needs the files on disk. The GitHub API gives files, but no server can run on them. The worktree uses the existing LspManager, FileExplorer and Monaco. |
| 2026-11-09 | A background helper (a launch agent) can run the phone server while the app is closed. The setting is off by default. | The agents already run in the PTY host. Only the phone server needed the app. The helper is a second entry of the same build, so it needs no other install. |
| 2026-11-09 | "Apply suggestion" changes the file in the local worktree. It does not commit with the GitHub API. | An agent works on the branch in the worktree. A commit on GitHub makes the local branch fall behind, and the next push fails. The user can check, test and commit the change with other changes. |
| 2026-11-10 | The onboarding state is in `settings.json`, and the setup checks reuse the PATH check and the GitHub token order. | All windows see the same state, and a cache clear does not show the welcome page again. One PATH check and one token lookup cannot disagree. See `docs/onboarding-plan.md`. |
| 2026-11-10 | Automations run in the page, while the app is open. Each automation is one JSON file in ~/.shipwarden/automations. | The page owns the agent tabs, the branch summaries and the Dashboard data, so it sees the events and can start agents. One file for each rule makes export, import and hand edits simple. An export has no paths of the Mac. |
| 2026-11-12 | A prompt from a pull request in the Review view goes to the agent of the worktree, and the Review view stays. A drawer at the bottom shows the agent terminal. | The user can read the pull request and type to the agent at the same time. The drawer shows the same terminal as the agent tab. The terminal pool keeps a list of the views of a session. A hidden view does not take the terminal from a visible view, and the terminal goes back to the agent tab when the drawer closes. |

## The old name (Yardmaster)

The app was Yardmaster before it was ShipWarden. `main/legacy-migration.ts` copies the old data one time, at the
first start:

- The app data folder (`Application Support/Yardmaster` → `Application Support/ShipWarden`), without caches and sockets.
- `~/.yardmaster/notes` and `~/.yardmaster/plugins` to `~/.shipwarden`. The notes index gets its new name.
- The copy leaves the old folders as they are. The worktrees in `~/.yardmaster/worktrees` stay there, because git keeps their paths.

Other compatibility:

- A PTY host of the old name still runs after the update. The app connects to its socket, so its terminals stay. New terminals use a host of the current build in the new folder.
- The agent hooks read `SHIPWARDEN_*` or `YARDMASTER_*` variables, and send both token headers.
- Setup, teardown and saved scripts get the `SHIPWARDEN_*` and the old `YARDMASTER_*` variables.
- A plugin can have `shipwarden-plugin.json` or the old `yardmaster-plugin.json`.
- The page copies its `yardmaster.*` local storage keys to `shipwarden.*`. Old theme IDs (lantern, junction, nightline, caboose, steel, dusk) convert to the new themes.
- The keychain key of the secrets has the app name, so secrets from Yardmaster (for example a ClickUp token) must be entered again.

## Releases and updates

See [RELEASING.md](RELEASING.md). The Release workflow (`.github/workflows/release.yml`) builds the DMG and the zip,
and publishes a GitHub release with the notes and `shipwarden-update.json`. `UpdateService` (main) reads the latest
release, and `UpdateNotice` (page) shows it. The install replaces the app bundle after the app quits.

**ShipWarden → Check for Updates…** (⇧⌘U) opens Settings › About and checks for a new release. The About section
shows the result.

## Stack

- **Electron 45** with **electron-vite**. ShipWarden is a macOS app first.
- **React 19** for the UI. Plain CSS with color tokens. No UI framework.
- **ghostty-web** for terminals: Ghostty's VT parser, compiled to WebAssembly, with an API like xterm.js.
- **node-pty** for the terminal processes.
- **Vitest** for tests.
- **Monaco** 0.57 for the editor. Since 0.55, Monaco has native LSP support (`monaco.lsp`). We plan to use it and not monaco-languageclient.
- **Lucide** icons, like Orca.

## Processes

```
┌──────────────────────── Renderer (React) ────────────────────────┐
│ Sidebar: repo, worktrees    │ Tabs: agent and shell terminals    │
│                             │ TerminalPool → ghostty-web         │
└──────────────────┬──────────┴────────────────────────────────────┘
                   │ IPC (preload exposes window.shipwarden)
┌──────────────────┴──────── Main process ─────────────────────────┐
│ ProjectStore       projects and their repos (projects.json)      │
│ GitWorktreeService git worktree list/add/remove                  │
│ PtyHostClient      connects to the PTY hosts (Unix sockets)      │
│ Ghostty loader     `ghostty +show-config` or the config files    │
│ FileService        folders, git ls-files, git grep, read/write   │
│ FileWatcher        recursive fs.watch (FSEvents) per worktree    │
│ LspManager         one language server per worktree and language │
│ GitHubService      PRs, reviews, checks, job logs, workflows     │
│ AzureDevOpsService the same for Azure Repos (SourceHosts selects)│
│ TaskHost           task plugin processes (JSON-RPC on stdio)     │
│ ProcessService     processes and ports per worktree, stop        │
└──────────────────┬───────────────────────────────────────────────┘
                   │ JSON-RPC on <app data>/pty-host-v1-<build ID>.sock
┌──────────────────┴──────── PTY host (detached process) ──────────┐
│ TerminalManager    node-pty sessions + output buffers            │
│ HookServer         agent state from Claude Code hooks (HTTP)     │
└──────────────────┬───────────────────────────────────────────────┘
                   │ the same JSON-RPC socket (a second client)
┌──────────────────┴──── Background helper (launch agent, optional) ┐
│ RemoteServer       the phone server while the app is closed       │
│ HelperServer       JSON-RPC on <app data>/helper-v1.sock          │
└───────────────────────────────────────────────────────────────────┘
```

The main process connects to the helper socket when the helper runs (see "Background helper" below).

### Terminals

- The terminal processes live in the PTY host, a separate process. The app starts it with Electron's Node runtime
  (`ELECTRON_RUN_AS_NODE=1`), detached from the app. The terminals and agents continue to run when the app quits.
  The next app run connects to the same host and shows the sessions again.
- The host stops when no app is connected and no session has a running process (after 10 seconds).
  A new host waits 30 seconds for its first app.
- Each build has its own host and socket (`pty-host-v<N>-<build ID>.sock`). The build ID is a hash of the host script.
  When a socket path in the app data folder is too long for macOS, the sockets go to a folder in the temporary folder.
- New sessions always go to the host of the app's build. The app starts it when it does not run.
- A host of another build is outdated. The app finds it in the socket folder, on the socket from before the per-build
  sockets (`pty-host-v<N>.sock`) and on the Yardmaster sockets.
  - When it has no running sessions, the app stops it.
  - When it has running sessions, it keeps them, and the app shows them with `hostOutdated`. Thus an update does
    not stop running agents. The host gets no new sessions.
  - When its last session ends, the app disconnects. With no app connected, the host stops.
- A terminal of an outdated host shows a bar: some features of the current build do not work in it. Its button stops
  the outdated hosts and their sessions (`shutdownOutdatedHosts`).

### Git changes

- The Changes tab of the right panel shows `git status` of the worktree (`GitChangesService`, main): the staged
  changes, the other changes with the untracked files, and the merge conflicts. `shared/git.ts` reads the
  `--porcelain=v2 -z` output.
- The page reads the status again every 4 seconds while it shows, when a file changes, on focus, and after an action
  (`git-store.ts`). The count shows on the tab.
- Stage is `git add -A`, unstage is `git restore --staged` (`git rm --cached` before the first commit). Commit reads
  the message on stdin (`git commit -F -`), so the hooks of the repository run. Push sets "origin" as the upstream
  when the branch has none.
- Discard is for unstaged changes only, after a confirmation. An untracked file goes to the Trash. A changed file gets
  the version of the index (`git restore --worktree`), and a copy of the working version goes to the Trash first.
  A file with a merge conflict is refused.
- Pull is `git pull --ff-only`. It makes no merge commit. When both sides have new commits, it stops with a message.
- While a worktree shows, the page asks for a background fetch every minute and on focus. The main process fetches
  the remote of the upstream (`git fetch --prune`) at most every 5 minutes for each repository (the worktrees of a
  repository share one fetch). Refresh fetches at once. Git cannot ask for a password, so a fetch that needs one fails
  quietly with a note. New commits show as "↓n" on the Changes tab and as a banner with Pull.
- A click on a file opens a diff tab (`ChangeDiffView`, with `@pierre/diffs`): HEAD and the index for a staged
  change, the index and the working file for an unstaged change.
- The main process runs git only in a worktree of a project, and checks that each path stays in the worktree.

### Chat about a review comment

- A review thread and a pending comment in a pull request diff have a "Chat" button. It opens a chat with the agent
  under the comment. The agent does not change files. "Send to agent" is still the way to give the agent work.
- Each message calls `ask.run` (the same runner as "Ask agent"). In the Review view, the agent runs in the local
  clone or in an empty folder. In a worktree, it runs in the worktree. Print mode keeps no memory, so
  `commentChatPrompt` (`shared/comment-chat.ts`) puts the comment, its lines, the diff of the file, and all earlier
  messages into each prompt.
- `comment-chat-store.ts` keeps the chats in memory for the app session. A chat stays when the diff makes its zone
  again. A thread chat uses the thread ID. A pending comment has no ID, so its chat uses its file and lines.
- "Use as reply" puts an answer into the reply box of a thread. "Use as comment" opens the edit box of a pending
  comment with the answer. The user saves the text.

### Agent drafts (commit messages and pull request descriptions)

- A ✨ button sits next to the commit message box, the description of the pull request form, and the description
  editor of the PR tab. A click calls `ask.draft`. The agent of the repository runs in print mode in the worktree
  (the same runner as "Ask agent"). A second click stops it.
- The main process collects the git data (`GitChangesService.commitDraftInput` and `pullRequestDraftInput`), and
  `shared/drafts.ts` writes the prompt. A commit message gets the staged diff and the last 15 commit subjects. An
  amend gets the diff from the parent of HEAD. A pull request gets the commits and the diff since the default branch
  of "origin" (`origin/HEAD`, else `origin/main` or `origin/master`).
- A pull request draft uses the template of the repository when it has one. `PULL_REQUEST_TEMPLATE_PATHS` lists the
  places of GitHub and Azure DevOps. The match ignores case. In a folder of templates, the first Markdown file applies.
- Settings › Agents has the global settings: Conventional Commits (on by default) and extra instructions for each
  kind. A repository adds its own instructions after the global ones, and it can change the Conventional Commits
  switch (`resolveDraftSettings`).
- The draft replaces the text in the box. When the box has text, the button asks first.

### Worktree processes and ports

- `ProcessService` (main) reads `ps` (PID, parent, CPU, memory, time, command), `lsof -iTCP -sTCP:LISTEN` (ports)
  and `lsof -d cwd` (working folders). It does not read process environments. `shared/processes.ts` groups the result.
- Terminal processes: the child processes of each terminal shell. A session has the PID of its shell. A session of an
  older PTY host has no PID, so its shell (a child of the host) gets its worktree from its working folder.
- Other processes: processes with a working folder in the worktree that no terminal started. Shells are left out, so
  the user's own terminal windows do not show. ShipWarden's own child processes (for example language servers) are left out.
- The Processes tab of the right panel shows them and their ports, and refreshes every 3 seconds. Stop sends SIGTERM to
  the process and its child processes, and SIGKILL after 3 seconds. The main process stops only a PID that the scan
  shows for the worktree.
- A closed terminal tab stops the processes that its shell started (only for sessions with a PID). A removed worktree
  stops its terminals, the processes that they started and the other processes in its folder, before git removes the folder.
- The host writes its log to `<app data>/pty-host.log`.
- **ShipWarden → Quit and Stop All Agents…** (⇧⌥⌘Q) stops all sessions and the host, then quits. It asks first when
  sessions run. A normal Quit (⌘Q) keeps the sessions running.
- The app sends the environment of each new process. The host does not have the login shell PATH of the app.
- Each session keeps its recent output (1 MB) with a sequence number for each chunk.
  A new view shows the replay and then only the live chunks with a larger number. This prevents lost and duplicate output.
- The renderer keeps one Ghostty terminal for each session (`TerminalPool`). A tab switch moves the terminal in the DOM. It does not create a new terminal.
- An agent starts as the shell command: `$SHELL -l -i -c 'claude; exec $SHELL -l'`. When the agent exits, the user gets a shell.
- The main process removes agent session variables (for example `CLAUDE_CODE_CHILD_SESSION`) at start.
  Without this, an agent in a ShipWarden terminal thinks that it is a child session.

### Agent state

- ShipWarden starts Claude Code with `--settings <app data>/claude-hooks.json`. This adds hooks and does not change
  the user's own Claude settings.
- Each hook runs `curl` and sends the hook's JSON to `HookServer` in the PTY host. The agent state stays correct while the app is closed. The server listens on 127.0.0.1
  only and needs a random token. The terminal environment supplies the URL, the token and the session ID
  (`SHIPWARDEN_HOOK_URL`, `SHIPWARDEN_HOOK_TOKEN`, `SHIPWARDEN_SESSION_ID`).
- States: starting → idle (SessionStart) → working (UserPromptSubmit, PreToolUse) → waiting (Notification) → done (Stop) → exited (SessionEnd).
  A Notification with `notification_type: "idle_prompt"` does not change done or idle. Claude Code sends it about
  60 seconds after a turn ends. A SessionEnd with `reason: "clear"` (from /clear) does not change the state.
- Gemini CLI has no `--settings` option. ShipWarden starts it with `GEMINI_CLI_SYSTEM_DEFAULTS_PATH=<app data>/gemini-hooks.json`.
  The system defaults file has the lowest priority, and Gemini CLI adds the hooks of all settings files together. Thus the
  user's `~/.gemini/settings.json` and the project's `.gemini/settings.json` stay the same. ShipWarden copies the values of
  the system defaults file that Gemini CLI uses without ShipWarden into its file (`writeGeminiHookSettings`).
- Gemini CLI states: idle (SessionStart) → working (BeforeAgent, BeforeTool, AfterTool) → waiting (Notification with
  `notification_type: "ToolPermission"`) → done (AfterAgent) → exited (SessionEnd). The hooks have the name
  `shipwarden-agent-state` in `/hooks`. Gemini CLI can remove variables with "TOKEN" in the name from the environment of a
  hook, so each terminal also gets `GEMINI_CLI_SHIPWARDEN_*` copies of the hook variables. Gemini CLI keeps those.
- opencode has no command hooks. ShipWarden writes a plugin to `<app data>/opencode/shipwarden-agent-state.js`
  (`writeOpencodePlugin`) and starts opencode with `OPENCODE_CONFIG_CONTENT={"plugin":["file://<plugin>"]}`. opencode adds
  the plugins of all config files together, so the user's own config stays the same. The plugin runs in the opencode
  process and sends Claude Code event names to the hook server: SessionStart (start), UserPromptSubmit (`chat.message`),
  PreToolUse (`tool.execute.before`, and again after `permission.replied` or `question.replied`), Notification
  (`permission.asked`, `question.asked`) and Stop (`session.status` idle after a prompt). The idle state of a subagent
  session (a session with a `parentID`) does not end the turn. opencode sends no SessionEnd. The process scan shows when it stops.
- The worktree list shows the state of the agent that needs the user most. A macOS notification appears when an agent
  needs input or is done, unless the user looks at that agent.
- Other agents (for example Codex) run without hooks and show no detailed state.
- Each terminal gets the hook variables, also a shell tab. A zsh shell gets `ZDOTDIR=<app data>/shell-integration/zsh`.
  That `.zshenv` sets `ZDOTDIR` back to the user's value and reads the user's startup files. Before the first prompt,
  it adds a `claude` function that adds `--settings <hooks file>`, and a `gemini` function that sets
  `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, and an `opencode` function that sets `OPENCODE_CONFIG_CONTENT` (each only when the user
  did not set the variable). Thus `claude`, `gemini` or `opencode` typed in a shell tab reports its state.
  The shell tab then shows in the Agents view while the agent runs (`runsAgent`).
- A bash shell gets `SHIPWARDEN_BASH_INIT=<app data>/shell-integration/init.bash`, and the terminal manager starts it with
  `--init-file` and that file in place of `-l`. Such a shell is not a login shell, so the file reads `/etc/profile` and the
  first of `~/.bash_profile`, `~/.bash_login` and `~/.profile`, as `bash -l` does. Then it adds the same three functions.
  Other shells start as plain login shells.
- The main process finds agents in shell tabs itself (`ShellAgents`). Each 2 seconds it reads the process table and
  finds `claude`, `codex`, `gemini` and `opencode` processes below the shell of each tab. Only a process in the foreground
  process group of the tab's terminal counts (`pgid` = `tpgid`), so an agent that the user stopped with Ctrl+Z or started
  in the background does not count. The session then gets `agentProgram`.
  Thus Codex, which has no hooks, shows too, and the tab leaves the Agents view when the agent process stops. A session of a
  Yardmaster host has no shell PID, so it gets no agent program.
- Each state change carries a message and a time. PreToolUse gives a description of the tool call for people
  (`describeTool`, for example "Editing App.tsx" or "Running npm test"). UserPromptSubmit gives a one-line summary of
  the prompt, which the session keeps.
- The Agents view (the first row of the sidebar, ⌥⌘2) lists the running agents of all projects, grouped by project. A row
  shows the state, the time since the last output, a name (the linked task, else the last prompt, else the branch),
  the activity, the pull request with its CI state, and the repository and branch. A click or Enter switches to the
  agent's project if necessary and opens its tab. The arrow keys, Home and End move between the rows.
- `src/shared/agent-overview.ts` gives the state of a row (`overviewState`). The inputs are the hook state, the CI state
  of the branch's open pull request and the time of the last terminal output:
  - The hook states "waiting", "working" and "starting" stay as they are.
  - "done" becomes "Blocked on CI" while the checks of the pull request run or after they fail. Else it stays "done".
  - "idle" (ready, no prompt) becomes "Needs input", or "Blocked on CI" as above.
  - An agent without hooks (for example Codex) is "working" while its terminal sent output in the last 10 seconds.
    Else it is "Blocked on CI" as above, or "Quiet".
- The CI state comes from `github.branchSummaries` for each repository that has an agent. The view loads it every
  60 seconds while it is open.
- The renderer records the time of the last output of each terminal (`OutputActivity`). It starts when the window
  loads, so after a reload of the window the time is not known until the next output. The row then shows the time of
  the last state change. A redraw of a TUI agent (for example a spinner) also counts as output.
- The header shows the number of agents in each state and the plan usage of Claude and Codex from the status bar.
  ShipWarden has no token or cost data for each agent, so the rows show no usage.
- The project switcher is the header of the repository list, because only the repositories change with the project.
- The worktree list also shows the open PR of each branch and its combined CI state. One GraphQL request for all
  open PRs runs every 60 seconds and when the window gets focus.

### Projects and repositories

- A project is a named list of repositories. The sidebar shows the repositories of the active project only, so a long
  list of repositories stays short. A repository can be in more than one project.
- The project menu at the top of the sidebar switches, creates, renames and deletes projects. Removing a repository from
  a project or deleting a project never changes files, worktrees or running agents.
- Each repository is a group in the sidebar that collapses. A collapsed group shows its number of worktrees and the
  agent state that needs the user most.
- The saved tabs (`layout-store.ts`) belong to the project. A project without saved tabs uses the tabs of its first
  repository from before projects existed.
- The task source stays a setting of each repository. The Tasks view has a repository picker when the project has more
  than one repository.
- At the first start, the repository from the old `state.json` goes into the project "Default".

### Themes

- `src/shared/themes.ts` has six themes (Lantern, Junction, Nightline, Caboose, Steel, Dusk). Each theme has a light
  and a dark palette. A test checks the contrast of text, muted text and the accent color in each palette.
- Settings → Appearance: the color scheme (System, Light, Dark), one theme for light mode and one for dark mode, and the
  terminal colors. "System" follows macOS through `prefers-color-scheme`.
- Each palette color is a CSS variable (`--bg`, `--text-strong`, …). `useAppearance` sets the variables, the editor
  theme (built from the palette, with light or dark syntax colors) and `nativeTheme.themeSource` in the main process.
- The renderer saves the last palette in local storage and applies it before the first render, so a light theme does not
  start dark for a moment. The main process gives new windows the background of the active palette.
- Terminals keep the Ghostty colors by default. With "Match theme", they use the theme colors. ghostty-web 0.4 keeps the
  default colors from `open()` in its WASM engine, so a color change closes the terminal views and opens new ones. The
  sessions keep running, and the new views get their output from the replay.

### Agent usage in the status bar

- The status bar shows the plan usage of Claude Code and Codex, the same meters that `/usage` shows in the agents.
  A narrow window shows the highest value of each agent. A wide window (CSS container query) shows each limit with its reset time.
- `UsageService` (main process) uses the sign-ins of the agents on this Mac: Claude Code's OAuth token from the login
  keychain (`Claude Code-credentials`) or `~/.claude/.credentials.json`, and the ChatGPT token in `~/.codex/auth.json`.
  A token stays in memory for one request and goes only to the service that issued it. Error messages never contain it.
- Endpoints: `api.anthropic.com/api/oauth/usage` and `chatgpt.com/backend-api/wham/usage`. They use no model tokens.
- Intervals: Claude every 5 minutes, because its endpoint answers 429 to frequent requests. Codex every 2 minutes.
  After a 429, the provider waits for `Retry-After` (or 15 minutes). The refresh button sends at most one request
  each 30 seconds for each provider.
- An agent without a sign-in does not show. After a failure, the bar keeps the last values and shows a warning icon.

### Settings

- **ShipWarden → Settings…** (⌘,) or the gear row in the sidebar opens the settings page. Escape closes it.
- The page has a section list at the left (Appearance, Task managers, Agents, Terminal, About, then the repositories
  of the active project) and shows one section.
  It opens on the last section. Each section has titled groups (`SettingsGroup`), and a group card has rows
  (`SettingsRow`) with the label and the description at the left and the control at the right.
- The main process keeps the settings in `<app data>/settings.json` (`SettingsStore`). `normalizeSettings` replaces a
  value with a wrong type with its default.
- Settings > Agents keeps a list of named agents (name and command) and one default agent. Each command runs in the
  login shell, and the page checks that its program is in the login shell PATH. A shell alias is not in the PATH, so
  the page shows a warning, not an error. Older settings with one `agentCommand` become this list.
- Repository settings (the settings button of a repository in the sidebar, or Settings > Repositories): a display name
  (empty means the folder name), a default agent (else the global default) and a color marker. The main process keeps
  them by repository path in `settings.json`. A removed agent goes out of the repository settings.
- ShipWarden adds its hooks only to Claude Code, Gemini CLI and opencode. Only an agent with hooks starts with the state "starting".
  Another agent has no state, and the worktree list shows only that it runs.
- A new installation gets Claude Code, Codex, Gemini CLI and opencode. The page offers a "Built-in" button for each default
  agent that the list does not have, so an older installation can add Gemini CLI or opencode with one click.

### Split view

- A tab can have splits, as in Ghostty: a tree of panes (`shared/panes.ts`). A split shows two parts side by side
  (`row`) or one above the other (`column`) with a ratio. Each pane shows one view: a terminal, a file, a diff or a log.
- `panes[worktree]` is a list of split tabs (`SplitGroups`). A split tab is one entry in the tab strip, at the place of
  its first pane, with the title of its focused pane and the number of panes. A view in no split is a normal tab.
- `activeTabs` stays the active view of each worktree. In a split tab, it is the focused pane. App computes the
  layout of the active tab from both, without the panes of closed views (`pruneGroups`).
- Keys, as in Ghostty (`shortcutAction`): ⌘T a new shell tab, ⌘W close the focused pane (the tab when it has one
  pane; a running agent asks first), ⌘D and ⇧⌘D a new shell pane at the right of or below the focused pane, ⌥⌘ and an
  arrow key move the focus to the pane at that side. ⇧⌘W closes the window. ⌘N opens the New worktree dialog for the repository on the screen: the
  commit graph, else the selected worktree, else the first repository. ⇧⌘E moves the focus to the file explorer. It
  shows the right panel and the Files tab when necessary. ⌘B shows or hides the sidebar, and ⇧⌘B moves the focus to
  it. The sidebar shows first when necessary. In the sidebar, Up and Down move between the items, Enter or Space opens
  an item, Left and Right collapse and expand a repository, and ⇧F10 opens the context menu of a worktree.
  ⌘E shows or hides the right panel. A focused terminal takes all keys, so a menu shortcut alone does not work.
  The keys go through two ways: `before-input-event` in the main process (before the page and the menu), and a keydown
  listener of the page in the capture phase. Both send the same action. The File menu lists the keys.
- Tab keys, as in Ghostty: ⌘1 to ⌘8 select that tab of the strip, and ⌘9 selects the last tab. ⇧⌘[ and ⇧⌘] select
  the previous and the next tab. ⌃⇧Tab and ⌃Tab do the same. These keys work only in the worktree view. The tab
  strip is a `tablist`. Left and Right move the focus between the tabs, Home and End go to the first and the last tab,
  and Enter or Space selects the focused tab. ⌃⇧Left and ⌃⇧Right move the focused tab (`shared/tab-order.ts`). The
  new order stays until the app quits. The right panel tabs and the tabs of a pull request in the Review view are
  also tab lists with Left and Right (`renderer/src/tablist.ts`).
- View keys: ⌥⌘1 Dashboard, ⌥⌘2 Agents, ⌥⌘3 Tasks, ⌥⌘4 Review, ⌥⌘5 Pipelines and ⌥⌘6 Notes. Option changes the
  character of the key on macOS, so `shortcutAction` reads the code of the key (`Digit1`). ⌥⌘3 does nothing when the
  project has no repositories, because the sidebar then shows no Tasks item. The Go menu lists the keys.
- ⇧⌘0 moves the focus to the workspace: the focused pane of the worktree view (its terminal, its editor, its browser
  page or its first control), else the main area of the view. ⌘0 stays the key of Actual Size in the View menu.
  Escape in the sidebar also moves the focus to the workspace. Escape in a field or in an open menu of the sidebar
  does not.
- ⇧⌘M in a diff opens the comment box (`isCommentKey`). In the diff of a tab (`DiffView`), the box is for the line of
  the cursor or the selected lines. The comment goes on the last line. The files stream of the Review view has no
  cursor, so ⇧⌘M opens the box at the current search match (⌘F).
- Back and forward (`shared/nav-history.ts`): ⌘[ goes back and ⌘] goes forward, as in a web browser. App adds an
  entry for each change of the view, the worktree or the active tab. A focus change in a split also adds an entry,
  because the tab of the focused pane is the active tab. So ⌘[ also goes back to the last pane. The settings page has
  no entry. A step skips each entry whose worktree or tab closed. The Go menu lists the keys.
- When a terminal process ends (for example after `exit`), its pane closes, and the tab when it was its only pane.
  The app also tells the host to forget the session. An agent tab starts a shell when the agent ends, so it closes
  only when that shell ends.
- Drag a tab onto the content: the tab (with all its panes) joins the split of the active tab at the nearest side,
  and leaves the tab strip. A layer over each pane takes the drag events, so Monaco does not take the drop as text.
- Each pane in a split has buttons: "Move to its own tab" and "Close this pane". The close button of a split tab
  closes all its panes, after a confirmation.
- Only the focused pane gives the keyboard to its terminal (`terminalPool.attach(..., focus)`). Other panes are darker.
- `TerminalView` does not detach when its attach finishes after an unmount. React StrictMode mounts a view again at
  once with the same container, and the late detach removed the terminal from it (a black terminal in development).

### Worktree settings

- Global (Settings › Worktrees, `settings.worktrees`): the folder of new worktrees (`<folder>/<repository>/<branch>`,
  default `~/.shipwarden/worktrees`) and the git-ignored files to copy (on, with `.env` and `.env.*`).
- Repository (`repos[path].worktrees`): its own folder (`<folder>/<branch>`), copy settings ("Global", "Custom" or
  "Off"), a setup script and a teardown script. `resolveWorktreeSettings` joins both.
- Copy: `git ls-files --others --ignored --exclude-standard --directory` in the main worktree. `ignoredUnits` removes
  the folders that git lists only because they contain ignored entries (for example `apps/` next to
  `apps/web/.env.local`). An ignored folder such as `node_modules/` is one entry.
- Two modes (`selectCopyEntries`, gitignore-like patterns from `matchesCopyPattern`): "Matching files" copies the
  entries that match the patterns (default `.env`, `.env.*`). "All except" copies all entries except the exclusions
  (default: `node_modules/`, `dist/`, `build/`, `out/` and other build and cache folders). The settings pages show a preview.
- Setup: the renderer opens a "Setup" terminal tab in the new worktree with `setupCommand` (the variables, then the
  script), so the user sees the output. The agent starts next to it.
- Teardown: the main process runs the script with the login shell (`runScript`, 5 minutes) before `git worktree
  remove`. It first checks for uncommitted changes, because git would refuse the removal after the teardown. A failed
  script stops the removal, and the user can remove the worktree anyway (`skipTeardown`).
- The scripts get `SHIPWARDEN_ROOT_PATH`, `SHIPWARDEN_WORKTREE_PATH`, `SHIPWARDEN_BRANCH` and `SHIPWARDEN_REPO_NAME`.

### Notifications

- Settings › Notifications (`settings.notifications`): on or off, "also when ShipWarden is active", and for each event
  a switch and a macOS sound (`NOTIFICATION_SOUNDS`, from /System/Library/Sounds, or no sound).
- The page asks the main process (`notifications.show`), because only Electron's `Notification` can play a named
  macOS sound. `NotificationService` keeps a reference to each open notification, so its click handler stays. A click
  brings the window to the front and sends `notifications:clicked` with the target (a worktree and an agent tab, or
  the Dashboard). The sound preview uses `afplay`.
- Events: an agent needs input or finished (not when the user looks at that agent), CI finished (`ciChanges`: the
  checks of a worktree pull request went from waiting to a result, between two loads of the PR summaries), and new
  Dashboard items (`dashboardStore.onNews`: items that no earlier refresh had, without hidden authors and seen
  comments; one notification for each refresh, and none for the first refresh of a project).

### Onboarding

The plan is in `docs/onboarding-plan.md`. Phase 1 adds the state, the setup checks and the Help menu. Phase 2 adds the welcome page. Phase 3 adds the guided tour. Phase 4 adds the empty states. Phase 5 adds the Keyboard Shortcuts page and the checklist. The tips come after the five phases.

- **State.** `settings.onboarding` (`src/shared/onboarding.ts`): `welcome` ('new', 'done' or 'skipped'), `tourSeen`
  (a tour version), `checklist` (the steps that are done) and `checklistClosed`. `normalizeOnboarding` keeps a missing
  state missing. A wrong `welcome` value becomes 'done', so bad data never shows the welcome page to a current user.
- **First state.** After the projects load, `ensureOnboarding` (`src/main/onboarding.ts`) sets the state one time. A user
  with a repository in any project gets 'done'. A user without a repository gets 'new'.
- **Setup checks.** `SetupChecks` (`src/main/setup-checks.ts`) runs the checks only on request (`setup:check`). The pure
  functions in `src/shared/setup-checks.ts` map each raw result to a state (`ok`, `missing`, `warning`, `unknown`), a
  message and a list of fixes. The checks:
  - git and the default agent: `checkCommand` (`src/main/command-check.ts`), the same PATH check as Settings › Agents.
    An agent that is not in the PATH gives a warning, because a shell alias can start it.
  - GitHub: `ReviewProviders.githubTokenSource`. It uses the token order of `GitHubClient` (saved token, then
    `GITHUB_TOKEN`, then `gh auth token`) and does not call the GitHub API. A new user has no GitHub provider, so the
    check uses a client without a saved token. No token gives a warning, because agents work without GitHub.
  - Repository: the number of repositories in the active project.
  - Notifications: `settings.notifications.enabled`. Electron cannot read the macOS permission.
  A check that fails gives 'unknown' and does not stop the other checks.
- **Welcome page.** `WelcomeView` is the view `welcome` of the center area, with the layout of the settings page. The
  sidebar stays, so a fix button can open a settings section, and the close button of the settings page comes back.
  - It opens at the start when `onboarding.welcome` is 'new' (`shouldOpenWelcome`), after the saved view of the
    project. Help › Show Welcome opens it at all times. The saved layout never keeps it (`viewToSave`).
  - The steps: the words of ShipWarden, the tool checks, a repository (add, or clone with `CloneRepoDialog` and
    `projects.pullRepo`), the default agent, the theme and the task trackers, and "Create a worktree and start an
    agent". The theme and the task trackers open in place (`AppearanceSettings` and `TaskManagersSettings` in a
    `<details>` section), so the user does not leave the page. `welcomeStepStates` (`src/shared/welcome.ts`) gives the state of each step.
  - "Skip setup" saves 'skipped'. The start button saves 'done' and opens the New worktree dialog.
  - The check results are in TanStack Query (`useSetupChecks`, key `setup`). They load one time and never on a timer or
    on focus. A fix updates one entry: the repository and notification results come from the page state, a new default
    agent checks the agent again, and a fix that leaves the page (Settings or a web page) checks its check again when
    the page shows again. "Check again" in the tools group runs all checks.
- **Guided tour.** `Tour` (`components/Tour.tsx`) and the pure step model `src/shared/tour.ts` (steps, keys, callout
  place, `shouldOfferTour`). There is no tour library.
  - Each step points at an element with `data-tour="<target>"`, never at a CSS class. The step first opens what it
    needs (`needs`: the sidebar, the worktree view or the right panel). At the end, the tour puts the panels and the
    view back.
  - `calloutPosition` tries the right side, the left side, below and above. When the target is not on the screen or
    the callout does not fit, the callout goes to the center. A spotlight with a large shadow dims the rest.
  - Keys: → and Enter go forward, ← goes back, Escape closes. `useModal` keeps the focus in the callout and gives it
    back at the end. The focus moves to the Next button after the callout has its place, because a hidden element
    cannot take the focus.
  - Finished or closed, the tour saves `onboarding.tourSeen = TOUR_VERSION`. `TourOffer` asks one time ("Take a
    short tour of ShipWarden?") when the welcome page is done or skipped and `tourSeen` is lower than
    `TOUR_VERSION`. So current users get the offer, and new users get it after the welcome page.
- **Empty states.** `EmptyState` (`components/EmptyState.tsx`) gives each empty view an icon, a title, one sentence
  and one action, so all views look the same:
  - Worktree area: no repositories (Add or Clone a repository), no selected worktree (Create a worktree, ⌘N), and a
    worktree without tabs (Start the agent, with a hint for ⌘T and ⌘N).
  - Agents: "Start an agent in a worktree". `startAgentAction` shows the selected worktree, opens the New worktree
    dialog, or adds a repository first.
  - Tasks: no task manager (Open Settings › Task managers).
  - Review and Pipelines: no code review account (Open Settings › Code review). The Dashboard shows the same fix in a
    card at the top, because its task comments work without an account. The hint names `gh auth login`.
  - Pipelines: a repository without workflows gets one sentence about GitHub Actions.
- **Keyboard Shortcuts.** `ShortcutsDialog` (Help › Keyboard Shortcuts) shows `shortcutRows()` from
  `src/shared/shortcuts.ts`. `SHORTCUT_INFO` is a `Record<ShortcutAction, …>`, so a new action does not compile
  without its text. Tests send each listed key through `shortcutAction`, `appKeyAction` and the terminal key
  functions, and check that each menu accelerator is in the list. So the page cannot get out of date.
- **Checklist.** `ChecklistCard` at the top of the Dashboard. `updatedChecklist` (`src/shared/checklist.ts`) marks a
  step done from the state of the app: a repository, a worktree that is not the main worktree, a running agent, the
  Agents view, and a worktree branch with a pull request. A step stays done. The close button saves
  `checklistClosed`. A current user gets `checklistClosed` at the first start, so only new users see the card.
- **Saves.** `saveOnboarding` runs the saves one after the other, and each save reads the newest state first. Two
  changes at the same time (for example "No thanks" and a checklist step) then both stay.
- **Tips.** The tip text and the pure rules are in `src/shared/tips.ts`. The state is in `settings.onboarding`:
  `tipsOff`, `tipsClosed` (the inline tips that the user closed), `recentTips` (the last 9 notice tips), and
  `tipClosedAt` (the time of the last close of the notice). The tips are on by default.
  - `TipNotice` (`components/Tips.tsx`) shows one tip of `NOTICE_TIPS` in the bottom-right corner. It has no "next"
    button. `useTips` (`app/use-tips.ts`) shows a tip at each start of the app. While the app stays open, it shows a new
    tip 12 hours after the user closed the last one (`shouldShowTipNotice`). It checks when the settings load, when
    the window gets the focus, and each 5 minutes. `pickTip` picks a random tip that is not in `recentTips`, so a tip
    does not show again within 10 notices.
    It does not show while the welcome page, the tour, the tour offer, or a dialog shows.
  - The corner notices (the update notice, the result of ⇧⌘U, and the tip) go into one container through `CornerNotice`
    (`components/CornerNotice.tsx`), a portal to `.corner-notices`. They stack in a column. The CSS `order` puts the
    update notice at the bottom and the tip above it.
  - `InlineTip` shows a tip of `INLINE_TIPS` in its view (Dashboard, Agents, Tasks, Review, and Automations). It reads the
    tip state from a small store that App.tsx fills (`useProvideTips`), so the views need no new props. Its close button
    adds its ID to `tipsClosed`.
  - The tip buttons open a view, a settings section, the New worktree dialog, or the Keyboard Shortcuts page
    (`TipAction`).
- **Help menu.** Show Welcome, Take the Tour and Keyboard Shortcuts send `app:help` to the page. ShipWarden on GitHub
  opens the README page.
- **Test data folder.** `SHIPWARDEN_USER_DATA_DIR` calls `app.setPath('userData', …)` before the app reads data. The app
  then does not run the legacy migration and does not connect to the PTY hosts of the old name.

### Pipelines

- The sidebar item "Pipelines" (below "Review") shows the GitHub Actions workflows of one repository. The name is
  neutral, because GitLab and Azure DevOps (planned providers) call these pipelines. The repositories come from the
  GitHub providers of Settings › Code review, the same as the Review view.
- Columns: the workflows (with a run button when the workflow has a `workflow_dispatch` trigger), the newest 40 runs
  (of all workflows or one), and the selected run: its actions, its jobs (latest attempt) and the log of a job.
- Run dialog: a branch (from `/branches`, the default branch first) and the inputs of the trigger. GitHub has no API
  for the inputs, so `parseWorkflowFile` reads the workflow YAML (js-yaml) of the chosen branch.
  `dispatchInputs` uses the defaults and refuses an empty required input.
- Actions: cancel a run that waits or runs, re-run failed jobs, re-run all jobs, open on GitHub. Each asks first.
- The runs refresh every 8 seconds while a run waits or runs, else every minute.

### Automations

The user guide and the file format are in [automations.md](automations.md).

- **Files.** `AutomationStore` (main process) keeps one JSON file for each automation in `~/.shipwarden/automations`,
  and watches the folder (`automations:changed`). `normalizeAutomation` (`src/shared/automations.ts`) checks a file. A
  file that is not valid goes into `problems`. The portable part (the definition) and the local part (the status and
  the binding: repository folders, task connection, collection) are in the same file. `exportAutomation` writes only
  the definition. An import gets a free ID, an empty binding and the status "off".
- **Runs.** `automation-runs.json` in the app data folder keeps the run history (at most 500 runs), the fired event
  keys (45 days), the times of the last schedule runs and the task automations that recorded their first list.
  `claim` records a run only when its key (`<automation>|<event key>`) did not fire before. The check and the write
  are one step, so an event runs one time only, also after a restart.
- **Engine.** `AutomationEngine` (`src/renderer/src/automations/engine.ts`) runs in the page, because the page owns the
  agent tabs. `useAutomationEngine` gives it the state of the app at each render. It makes events from data that the
  app loads already (`src/shared/automation-events.ts`), so a rule adds few requests:
  - `ci.failed` and `pr.merged`: the branch summaries (`ciChanges`, and a pull request that left the open list). The
    summaries of the active project load each minute already. The engine also watches the repositories with an agent
    and the repositories of the rules, only while a pull request rule is on. A pull request that left the list costs one
    `github.status` request, which tells merged from closed.
  - `pr.comment` and `pr.conflict`: the news of each Dashboard refresh (`onDashboardNews`), the same news as the
    notifications. The "origin" remote of each folder comes from the cache (`repoOf`).
  - `agent.done`: the agent hooks.
  - `task.new`: `tasks/list` of the bound collection every 5 minutes, with the query key of the Tasks view, so the
    view shows the same list. The first list of a new or re-enabled rule only records its tasks (`seed`).
  - `schedule`: a timer every 30 seconds. A time before the start of the app or before the rule was turned on does not run.
- **Run flow.** A matching rule makes a run: a dry run, a skip (the limit for the target, or the plan usage at or
  above `settings.automations.pauseAtUsage`), a pending run ("ask first"), or a run that starts at once. A run with
  `sendToAgent` waits ("held") while the agent works, starts or waits for an answer. The engine tries held runs again
  when an agent becomes done or idle, and every 30 seconds. A held run fails after 12 hours. At start, a run that was
  "running" fails, because the app closed during it.
- **Actions.** The app gives the engine quiet versions of its actions: `promptAgent`, `startTaskQuietly`,
  `startInNewWorktree`, `removeWorktreeQuietly` and `moveTaskToStatus`. They show no dialog and no banner, and they do
  not change the selected worktree. `promptAgent` reads the screen of an agent that the page does not show from the
  main process (`terminals.screenText`, a headless terminal from the replay), so it can wait for a folder trust dialog.
- **Tokens.** `agentStateFromHook` keeps `transcript_path` of the Claude Code hooks, and the PTY host sends it with each
  agent state (`agentTranscript`). A run that sends a prompt records its turn (`turn`: session, start, end). The engine
  counts the tokens of the turn with `automations.countTokens`, at each tick and at the end of the turn.
  `TokenCounter` (main process) reads only the new end of a transcript, takes one usage for each message ID (Claude
  Code writes one line for each content block), and adds `<session>/subagents/*.jsonl`. It reads only files in
  ~/.claude or `CLAUDE_CONFIG_DIR`. `countedTokens` counts input, cache writes and output, not cache reads. "Ask an agent"
  runs use `claude -p --output-format json`. `tokenLimitReached` checks the limit of the automation and the limit of all
  automations (`settings.automations.dailyTokens`) before a run, and before a held run continues.
- **Notifications.** The event "Automations" in Settings › Notifications: a run waits for approval, or a run failed.
  A click opens the Automations view. A `notify` action needs only the main switch.

### Repository scripts

- Each repository can have saved scripts (`repos[path].scripts`: ID, name, command). The ▷ button of the workspace
  header, left of the side panel button, opens their menu (`ScriptsMenu`): run a script, edit or delete it, or add one.
- A script runs in a new terminal tab of the selected worktree, titled with its name, in the login shell, with the
  variables of the setup script (`setupCommand`). After the script, the tab keeps a shell, so the output stays.

### Notes

- The sidebar item "Notes" (below "Review") opens notes that all projects share, like the scratch files of JetBrains IDEs.
- A note is a file with any extension in `~/.shipwarden/notes`, or in a folder there. Folders are optional, and they
  can be in other folders (up to 10 levels). The user and agents can open the files directly.
- The ID of a note is its path in the notes folder: "todo.md" or "work/2026/plan.md". `NotesService` (main) refuses a
  path part with a leading dot or a backslash, so no path leaves the notes folder.
- Tags are in `.shipwarden-notes.json` in the notes folder, by the path of the note (`normalizeTags`: no "#", no spaces,
  no duplicates). A move or a folder rename moves the tags with the notes.
- The list shows the folders as a tree. A note or a folder moves by drag and drop, and a note also with the folder
  menu in its header. A folder goes to the Trash with all its notes.
  A rename keeps the tags. Delete moves the file to the Trash.
- The editor is Monaco with a `note:` URI, so the language comes from the extension and the language servers of the
  worktrees ignore notes. Changes save 0.5 s after typing stops, with ⌘S, and when the note closes.
- The folder is watched. A change from another app or an agent updates the list, and the open note when it has no
  unsaved changes.

### Network (trusted certificates)

- For a network that inspects TLS traffic (for example a company VPN), Settings › Network has a CA certificates file
  (PEM) and a switch for the macOS keychain. An empty file setting uses `NODE_EXTRA_CA_CERTS` of the login shell
  (`loginShellCaFile`, read with `PATH`). The idea comes from the CA setting of the ClickUp plugin for Orca.
- Chromium (the renderer) uses the macOS keychain already. The settings are for the Node parts and for the in-app browser.
- Main process: `TrustedCertificates.apply` reads the certificates and calls `tls.setDefaultCACertificates` with the
  default certificates plus the extra ones. It runs before the first request (`networkReady`: the GitHub client and the
  usage bar wait for it) and again when the setting changes. New connections use the new certificates.
- Task plugins are other processes. `apply` writes the extra certificates to `trusted-ca.pem` in the user data folder,
  and the task host starts each plugin with `NODE_EXTRA_CA_CERTS` set to it. A change of the setting stops the plugins.
  They start again at the next request.
- A failed fetch shows its cause (`networkErrorDetail`, and `networkDetail` in the plugin SDK). A certificate error
  such as `SELF_SIGNED_CERT_IN_CHAIN` also tells the user to go to Settings › Network. "Test" connects to GitHub and ClickUp.

### In-app browser
- A browser tab is a tab of the worktree ("b:<view ID>"), next to the terminal, file, diff and log tabs. It can go
  into a split. The "+" menu of the tab strip has "Browser". Browser tabs do not stay after a restart.
- `BrowserViews` (main) makes one `WebContentsView` for each browser tab and adds it to the main window. The page
  (`BrowserView`) shows the toolbar and sends the place of its content element in each frame. The view hides when the
  tab does not show, while a dialog or a menu of the page is above it, and while the user drags a tab.
- The views have no preload script, no Node integration, context isolation and the sandbox. They use their own
  session (`persist:shipwarden-browser`), so they do not share cookies or storage with the app. Only http, https
  and `about:blank` load. All permission requests are refused, except the clipboard write.
- A page that opens a new window gets a new browser tab. A "mailto:" link opens the mail app.
- Links: `openLink` (renderer, `links.ts`) opens all links of the app. ⇧⌘-click opens the in-app browser. ⌘-click,
  and a plain click outside the terminal, open the default browser. In the terminal, a plain click does nothing.
  ghostty-web 0.4 does not give the modifier keys to `window.open`, so `TerminalPool` wraps the link providers of
  the terminal.
- Keys in a page: the workspace keys and the app keys work. ⌘R loads the page again, ⌘L selects the address bar and
  ⌥⌘I opens the developer tools of the page.
- Certificates: Chromium uses the macOS keychain. When Chromium refuses a chain with `ERR_CERT_AUTHORITY_INVALID`,
  `setCertificateVerifyProc` checks the chain again with the extra CA certificates of Settings › Network
  (`verifyWithExtraCas`: the host name, the dates, each signature, and a CA of the setting at the top).
### Ghostty config import

- If Ghostty is installed, ShipWarden runs `ghostty +show-config`. Ghostty then resolves themes and included files.
- If not, ShipWarden reads the config files directly.
- ShipWarden imports colors, the 16-color palette, the font family and size, the cursor style, and `text:` keybinds (for example `shift+enter=text:\n`).
- ShipWarden includes JetBrains Mono, because that is Ghostty's default font.

### Known problems in ghostty-web 0.4

- An empty `write()` throws "offset is out of bounds". `TerminalPool` skips empty writes.
- ghostty-web frees WASM memory and uses it again without clearing it. With one shared WASM instance, a new terminal
  showed old text and garbled characters of a closed terminal, also at a different width. Spare terminals with a reset
  (`ESC c` and a clear) did not stop it. Probably a clear frees the old pages, and the next output uses them again.
  Now each terminal gets its own Ghostty instance (`loadGhostty`), so a terminal can show only its own memory. The
  instance goes away with the terminal. Upstream issues: coder/ghostty-web#138, #141, #210.
- ghostty-web pastes only text, and it sends nothing for Ctrl+V. `TerminalPool` sends Ctrl+V (`\x16`) for Ctrl+V and
  for a ⌘V with only an image. Claude Code and Codex then read the image from the clipboard.

## Planned parts

### Task plugins (goal 1)

The protocol is in [task-plugin-protocol.md](task-plugin-protocol.md). It does not depend on Electron,
so that the mobile app and a CLI can use the same plugins.

- A plugin is a separate process with a `shipwarden-plugin.json` manifest. It speaks JSON-RPC on stdio with
  `Content-Length` headers, like an LSP server.
- `initialize` returns the capabilities and the UI as data: extra fields, actions and list filters.
  The manifest lists the settings. ShipWarden encrypts secret settings with the macOS keychain (Electron safeStorage).
- `TaskHost` (main process) finds the plugins in `plugins/` (built-in) and `~/.shipwarden/plugins/` (installed by the user).
  It starts one process for each connection, and all projects use it. The process gets the repositories of all projects
  and starts again when they change, except for a plugin with `"usesRepositories": false` (ClickUp, Linear).
  A plugin with `"command": "node"` runs on ShipWarden's own Node runtime.
- `plugins/sdk` is a JavaScript SDK with no dependencies and TypeScript declarations.
- Built-in plugins: GitHub Issues (each repository is a collection, the scope is users and organizations, uses the
  GitHub CLI login or its own token) and ClickUp (each list is a collection, the scope is workspaces, needs a personal
  API token).
- Task managers (connections): Settings > Task managers lists the connections. Each one has its own settings and an
  optional scope, and can be off. All projects use the connections that are on. The main process keeps this in
  `task-managers.json`, and the secrets by connection ID in `plugin-settings.json`.
  At the first start, the ClickUp token and GitHub Issues of version 2 become the connections "ClickUp" and "GitHub".
- The Tasks view shows the connections that are on, one collection at a time, with the details, the status,
  comments and plugin actions. It has no repository picker: "Start in worktree" asks for the repository when the
  project has more than one. The query keys of the view do not contain the project, so a project switch shows the
  cached tasks and sends no requests. The selected task manager is the same in all projects (`task-selected-connections.json`).
- "Start in worktree" makes a branch from the task (for example `abc-1684-fix-the-login-page`), links the worktree
  to the task and sends the task to a new agent. A new branch starts from the newest default branch of "origin".
- Next: a Linear plugin, Markdown for descriptions, and an option that moves the task to "in progress" at start.
- Open question: a plugin can wrap the MCP server of a tracker.

#### Worktree and task links

- "Start in worktree" saves a `TaskLink` for the new worktree (`task-links.json`). The task card shows a worktree
  button, and the task details have "Open worktree".
- The sidebar shows the task under the worktree. A click on it, or on the task chip in the workspace header, opens
  the Tasks view with the task manager of the task and the task in the details (`openTask`), also when the task is
  in another collection.
- `linkMatchesTask` matches a link by the task ID, or by the URL for links of older plugin versions.
- The right-click menu of a worktree (a native menu, `app.contextMenu`) has "Open Task", "Remove Worktree…" and
  "Remove Worktree and Delete Branch…". The branch delete uses `git branch -d`. For a branch that is not merged,
  ShipWarden asks before `git branch -D`. The remote branch stays.

#### Start status

- Each connection can have a start status (`TaskConnection.startStatus`, Settings › Task managers), for example
  "in progress". When a worktree starts from a task, `applyStartStatus` reads the statuses of the task
  (`tasks/statuses`, because each ClickUp list has its own), finds the status with that name without case, and sends
  `tasks/update`. A task without such a status keeps its status. The worktree and the agent do not wait for it.
- A change of only the start status does not restart the plugin, because the plugin does not use it.

#### Collections, list and board

- Each task source has collections (protocol version 2): ClickUp lists, GitHub repositories, later Linear teams.
  The task view shows one collection at a time. The picker groups the collections by path.
- The main process keeps the last selected collection of each source (plugin) in `task-collections.json`, so a switch
  back to a source and the next start show the same collection. The choice applies in all repositories.
- The list groups the tasks of the collection by status, in the collection's workflow order.
- The board has a column for each status of the workflow, also without tasks. Done and canceled columns start collapsed.
- A drag to another column changes the status (`tasks/statuses` for the task, then `tasks/update`).
  The card moves at once and moves back when the change fails.

### File explorer and editor (goal 2)

Done:

- A right-side Files panel like Orca's. It shows the tree of the selected worktree.
  Git-ignored entries are dim and italic, with a ⊘ mark.
- "Names" filters all files that git does not ignore (`git ls-files`) with a fuzzy match.
  "Contents" searches with `git grep` and opens the file at the matching line.
- The tree updates itself when files change on disk. One recursive watch covers each worktree.
- Files open in Monaco tabs next to the terminal tabs. Cmd+S saves.
  An open file without unsaved changes reloads when an agent changes it.
- The open files and the active tab of each worktree stay after a reload or a restart (`layout-store.ts`, in local
  storage). A file that does not exist now does not get a tab. Each file also keeps its cursor and scroll position
  (`editor/editor-positions.ts`). A closed tab or a removed worktree removes its positions.
- A handle on the left edge of the right panel changes its width (`ResizeHandle`). The width stays in local storage.
  The handle is a `separator` with `aria-valuenow`. Left and Right change the width, Shift makes bigger steps, End sets
  the largest width, and Enter or Home sets the default width.
- File viewers (`FileView`). The main process tells the kind of a file (`files.info`): from the extension, else from
  the first bytes (`shared/file-types.ts`).
  - Images (png, jpg, gif, webp, svg, bmp, ico, avif): fit, 100% and zoom (also ⌘ and the scroll wheel), the size in
    pixels and in bytes, and a checkerboard behind transparent parts. An SVG shows in an `<img>`, so its scripts do not run.
  - PDF: the built-in PDF viewer of Chromium in an `<iframe>`. The window has `plugins: true` for this viewer.
  - Audio and video: the `<audio>` and `<video>` elements.
  - Binary files and text files larger than 5 MB: a panel with "Show in Finder", not the editor.
  - Markdown: Source (Monaco), Side by side, or Preview. The preview reads the Monaco model, so it shows unsaved
    changes and the changes of agents. Relative links and images resolve against the folder of the file. The last
    mode applies to the next Markdown file.
- The viewers load files through the `shipwarden-file:` protocol (`main/files/file-protocol.ts`). A URL has the form
  `shipwarden-file://root/<root as hex>/<relative path>`. The handler sends a file only when these conditions are true:
  - The root is a worktree of a project (`knownWorktree`).
  - The real path (after symbolic links) is in the real path of the root.
  - The file is an image, PDF, audio or video file. Source code and other text files are refused.
  It sends byte ranges for `<video>` and `<audio>`. An SVG gets a CSP with `sandbox`. The page CSP allows the protocol
  only in `img-src`, `media-src` and `frame-src`.

### Language servers

- `LspManager` (main process) starts one server for each worktree and language, with the worktree as `rootUri`.
  It answers the server's requests (configuration, workspace folders) and sends diagnostics to the UI.
  It sends `workspace/applyEdit` requests to the UI with an `id` and waits up to 30 seconds for `lsp.respond`.
- Servers:
  - TypeScript and JavaScript: `tsc --lsp --stdio` from TypeScript 7. ShipWarden uses the worktree's own TypeScript if it is version 7 or later. If not, it uses the TypeScript 7 that ShipWarden includes.
  - Rust: `rust-analyzer`. Python: `basedpyright-langserver` or `pyright-langserver`. Go: `gopls`.
  - The launcher looks first in `<userData>/language-servers`, and then in the PATH.
- Install of a missing server (`main/lsp/server-install.ts`):
  - The editor banner shows an Install button. A dialog shows the source and the folder. ShipWarden installs nothing without consent.
  - Rust: the `rust-analyzer-<target>.gz` file of the latest GitHub release. The installer checks its size and the SHA-256 that the GitHub API gives.
  - Python: the `basedpyright` npm package, with a check of its `integrity` value. Electron runs `langserver.index.js` with `ELECTRON_RUN_AS_NODE=1`.
  - Go: `go install golang.org/x/tools/gopls@latest` with `GOBIN` in the folder. Without `go` in the PATH, the banner tells the user to install Go.
  - Each install writes to a staging folder first, and then moves it into place.
  - Downloads wait for `networkReady`, so the CA certificates of Settings › Network apply. `go install` gets `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`.
  - The banner shows the step, the download progress and the error.
- The main process reads the PATH of the login shell at start. An app that starts from Finder does not get it.
- `LspBridge` (renderer) syncs each Monaco model in a worktree with incremental changes.
  It registers Monaco providers for definition, type definition, implementation, references, hover, document highlights,
  completion, rename and code actions.
  It routes each request to the server of the worktree that contains the file.
- Rename: the bridge sends `textDocument/prepareRename` when the server supports it, then `textDocument/rename`.
- Code actions: the bridge sends `textDocument/codeAction` with the original LSP diagnostics. Each Monaco action runs the
  command `shipwarden.lsp.applyCodeAction`. This command sends `codeAction/resolve` when the action has no edit,
  applies the edit and sends `workspace/executeCommand` for the action's command.
- Workspace edits (`LspBridge.applyWorkspaceEdit`): the bridge checks all files first. Then it changes them.
  - A file in the document store gets the edit in its Monaco model, so undo works. A model without unsaved changes is saved.
  - Other files of a worktree get the edit on the disk (`files.read`, then `files.write`).
  - The bridge refuses the full edit for a file outside the worktrees, a file operation (create, rename, delete),
    overlapping edits, or a document version that changed.
- Diagnostics: the bridge pulls them (`textDocument/diagnostic`) after each change and also accepts pushed diagnostics.
- "Go to definition" into another file opens that file in a ShipWarden tab. Peek views load the models of the result files first.

Next:

- Signature help from the servers.
- File operations in workspace edits. An error message in the editor when a code action fails.

### GitHub (goals 3 and 4)

- `GitHubService` (main process) uses the GitHub REST and GraphQL APIs. The token comes from `gh auth token`. `GITHUB_TOKEN` has priority.
- The repository comes from the "origin" remote of the worktree. The pull request is the newest PR with the worktree's branch as its head.
- The right panel has three tabs: Files, Pull request and Checks.
- Pull request tab: state, branches, description, changed files, review threads (reply, resolve, send to agent),
  the review box (comment, approve, request changes) and merge with the methods that the repository allows.
  ShipWarden asks for confirmation before each action that changes GitHub.
- Diff tabs: Monaco's diff editor with the base and head versions from GitHub. Review threads show under their lines.
  A click on a line number adds a pending comment. Pending comments go out with the next review.
- Checks tab: the check runs and commit statuses of the PR head (or the local HEAD without a PR), re-run failed jobs,
  re-run one job, and start a workflow that has a `workflow_dispatch` trigger. It polls every 10 seconds while checks run.
- Log tabs: the log of a GitHub Actions job without timestamps and ANSI codes, with colors for errors and commands.
- "Send to agent": ShipWarden saves the job log in `~/.shipwarden/ci-logs/` and pastes a prompt into the agent of the
  worktree (a bracketed paste, then Enter). A review thread goes to the agent as a prompt with the comments.
- `RepoTarget`: each GitHub call takes a worktree root (the repository of its "origin") or `{owner, name}`.
  The review store keys its state with `targetKey(target)`.
- Suggested changes (`shared/suggestion.ts`, `CommentBody`):
  - A "```suggestion" block in a review comment shows as a diff: the old lines in red, the new lines in green.
    `splitSuggestions` finds the blocks. A suggestion fence in a different code block is text.
  - The old lines come from the `diffHunk` of the first comment of the thread (`threadSuggestionTarget`).
    The thread query also gets `startLine` and `originalStartLine`, so a comment on more than one line works.
  - "Suggest a change" in the comment box puts a suggestion block with the selected lines at the cursor. It shows
    only on the new side. A selection of more than one line sends `start_line` and `start_side` with the review.
  - "Apply suggestion" shows only in the worktree panel. It changes the file in the worktree, and the user commits.
    `applySuggestion` finds the old lines by their text, near the line of the thread, so lines that moved still work.
    When the old lines are not in the file, the suggestion is stale and the file does not change.
    A file with unsaved changes in the editor does not change.
  - The Review view shows suggestions, but it has no "Apply suggestion", because the PR has no worktree there.
- Reactions (`Reactions`, page):
  - Review comments, conversation comments and review texts show their reactions, and a button that adds a reaction.
    A click on a reaction adds the reaction of the user or removes it.
  - `PullRequest.reactionKinds` tells the page which reactions the host accepts. Undefined means the 8 reactions of
    GitHub. The picker shows only these reactions. With one reaction, the button adds it at once.
  - GitHub: `reactionGroups` in the pull request query, and `addReaction` or `removeReaction` with the node ID.
  - Azure DevOps: a comment has only likes (`usersLiked`). A like shows as a thumbs up. The like goes to
    `threads/{thread}/comments/{comment}/likes` (POST adds it, DELETE removes it). A vote has no reactions.
  - The change goes into the cache (`withReaction`). The pull request does not load again. A comment that exists only
    in the cache (a new reply) shows no reactions until the next load, because the host does not know its ID yet.
  - A reaction needs no confirmation. The user can remove it with one more click.
- Viewed files: `viewerViewedState` from GraphQL, changed with `markFileAsViewed` and `unmarkFileAsViewed`.
  The file list shows "x of y viewed". The diff header has a "Viewed" box. The change shows at once and goes back on an error.

#### PR groups

- A PR group (`shared/pr-groups.ts`) is a saved list of pull requests from any repository and host, with a name and a
  note for the agent. `PrGroupStore` (`main/pr-groups/`) keeps the groups in `pr-groups.json`. The page reads them
  with one TanStack query, and each change patches the cache (`renderer/src/github/pr-group-store.ts`).
- The page of a group is the page `group:<id>` of the Review view (`groupPage` in `app/review-page.ts`).
- A group review loads each pull request and its files, and builds one prompt (`groupReviewPrompt`). The main process
  (`main/ipc/pr-groups.ts`) makes a review checkout of each pull request and runs the agent in print mode in the first
  checkout, with the other checkouts as extra folders (`exploreCommand`). The answer is JSON with a review for each
  pull request (`parseGroupReview`). `reviewStore.applyAgentReview` adds each review to the pending comments and the
  review text of its pull request, the same as a review of one pull request.
- The group keeps only the summary, the head commits, and the counts of the last review (`lastReview`). A head commit
  that is different now shows the pull request as changed.

#### Azure DevOps (Azure Repos)

- `SourceHost` (`main/source-host.ts`) is the interface of a host of pull requests and pipelines. `GitHubHost` adapts
  `GitHubService` to it, and `AzureDevOpsService` (`main/azure/`) implements it.
- `ReviewProviders` (`main/review-providers.ts`) keeps the code review providers of Settings › Code review in
  `review-providers.json`. Each provider has a kind (`github` or `azure`), a name, an on/off switch, an optional scope
  (a list of organizations, else all) and, for GitHub, an optional GitHub CLI account. Each provider has its own client,
  token and caches. The user can add more than one provider of a kind, for example two GitHub accounts.
- Routing: a worktree whose "origin" remote is Azure Repos goes to an Azure DevOps provider. All other targets go to a
  GitHub provider. `pickProvider` (`shared/review-providers.ts`) selects the provider of the kind: first a provider whose
  scope has the organization of the remote, then a provider with all organizations, then the first provider of the kind.
  Calls that change a thread or a file take the target too, so they go to the same provider.
- A new user has no providers. The user adds each provider in Settings › Code review, as with the task managers.
  Without a provider of a kind, the worktrees of that kind show no pull requests.
- At the first start, a user of an older version keeps the setup of that version: a GitHub provider when
  `reviewOwners` is set (a list becomes its scope), and an Azure DevOps provider with the ID `azure-devops` when a token
  of that ID is saved, so it keeps the token.
- The IPC API keeps the name `github`, so the page did not change its calls. The models stay the GitHub models.
  `PullRequest.host`, `reviewEvents` and `hasAssignees`, and `BranchStatus.host` and `createUrl`, tell the page the
  differences.
- Remotes (`parseAzureRemote`): `https://[user@]dev.azure.com/{org}/{project}/_git/{repo}`,
  `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}` and `https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}`.
  All REST calls go to `https://dev.azure.com/{org}` with `api-version=7.1`.
- Token (`AzureDevOpsClient`): the personal access token of the provider (encrypted with safeStorage in
  `source-host-secrets.json`, by provider ID), else `AZURE_DEVOPS_EXT_PAT`, else `az account get-access-token` for the
  Azure DevOps resource. The GitHub client uses the same order: the saved token, else `GITHUB_TOKEN`, else
  `gh auth token`. A GitHub provider with a GitHub CLI account skips `GITHUB_TOKEN` and runs `gh auth token --user`. The client uses the global fetch after `networkReady`, so the trusted certificates of Settings › Network apply.
- Mapping (`main/azure/azure-mapping.ts`):
  - Votes: 10 approve, 5 approve with suggestions, -5 wait for author, -10 reject. A negative vote gives "changes
    requested". A required reviewer without approval gives "review required".
  - Threads with a file are review threads. Threads without a file are the conversation. System threads stay out.
    "fixed", "wontFix", "closed" and "byDesign" are resolved. A reply goes to the thread (`databaseId` is the thread ID).
  - Files come from the changes of the newest iteration against the base. The diff base is the common commit of the
    iteration. Azure gives no line counts, so the counts are 0.
  - A build is one check, with its build ID as job ID and run ID. The log is the task logs in timeline order. The tasks
    are the steps. A pull request build tests a merge commit, so `checks` matches builds by `triggerInfo['pr.sourceSha']`.
    Statuses of other services on the commit are checks too.
  - Pipelines are build definitions. "Run" queues a build on the branch. Re-run failed jobs is a build retry.
- Complete (merge) sends the head commit, so Azure refuses it when the branch changed. Auto-merge is auto-complete.
- Not available for Azure: the Review view and the Pipelines view (they list GitHub repositories), the Dashboard,
  assignees, the label list, and a stored "viewed" state (it stays in memory until the app quits).

#### Review view

- The sidebar item "Review" (below "Tasks") opens a main view for the pull requests of any repository, not only local ones.
- The repositories come from all GitHub providers that are on, each in its scope. Without a GitHub provider, the view
  shows a link to Settings › Code review.
- The view shows one repository at a time (from `/user/repos`, grouped by owner, without archived repositories).
  Filters: open, review requested, mine, assigned to me, closed. They become a GitHub search query (`pullRequestSearch`).
  The list refreshes every 60 seconds.
- A pull request has a header and the tabs of GitHub (`ReviewPullRequest`):
  - Overview: the description, the conversations, the review box and merge (`PullRequestPanel` with `variant="overview"`).
  - Commits: the newest 100 commits from the PR query, the newest first.
  - Checks: `ChecksPanel` on the left, the job log on the right.
  - Files changed: `PullRequestFileList` on the left. `PullRequestFilesStream` on the right shows all files in one stream, with `@pierre/diffs` (`PatchDiff` in a `Virtualizer`).
    - `shared/patch.ts` makes a full patch from the hunks that GitHub sends. A file without a patch loads both versions (`MultiFileDiff`).
    - Each file can collapse. Viewed files start collapsed, and a file collapses when the user marks it as viewed.
    - Review threads, pending comments and the comment box are line annotations. The "+" in the gutter starts a comment.
    - A click in the file list opens the file and scrolls to it. The Unified/Split choice is in localStorage.
    - The worktree panel still uses `DiffView` (Monaco) for one file.
  The counts come from the PR query (`commitCount`, `checkCount`, `changedFiles`). The selected tab is kept in localStorage.
- Code navigation (`ReviewCheckouts`, main, and `review-checkout-store`, page):
  - The page asks for a local copy of the PR only when the user needs it: ⌘-click on a name in a diff, the file
    button in a file header, or "All files" above the file list.
  - The copy is a detached git worktree at the head commit: `~/.shipwarden/review/<owner>/<name>/pr-<number>`.
    It belongs to the project repository whose "origin" is the GitHub repository (`localClone`). The user's clone
    gets no branch. A fetch of `refs/pull/<number>/head` gets the commit, also for a PR from a fork.
  - Without such a project, the page asks first. Then ShipWarden clones to `~/.shipwarden/review/<owner>/<name>/repo`
    with `--filter=blob:none`, so git gets file contents only for the commits that the user opens.
  - Git runs with no hooks, with no Git LFS downloads and with no password prompt. A new head commit moves the
    worktree with `checkout --force`. Untracked files (for example `node_modules`) stay.
  - `review-checkouts.json` (user data) keeps the copies. A copy that the user did not open for 7 days goes away
    at the next start. A clone of ShipWarden goes away with its last copy.
  - The sidebar and the phone do not show these worktrees. `knownWorktree` accepts them, so the file, watch and
    protocol calls work.
  - The page adds the copy as an extra root of `LspBridge` with its own opener (`addRoot`). "Go to definition" into
    another file of the copy opens it in the code pane of the review, not in a worktree tab.
  - ⌘-click uses `onTokenClick` of `@pierre/diffs`. Only the new side works, because the copy has only the head
    commit. The code pane opens the file at the name and runs Monaco's "Go to Definition" after the server has the file.
  - The code pane is a read-only Monaco editor with a "Back" list. "All files" shows `FileExplorer` on the copy.
  - When the review closes the PR, the page closes the models of the copy and stops its language servers. The copy stays.
- Merge shows only for the user's own PRs. "Send to agent" is not available, because the PR has no worktree.
- Images: an image of a private repository is a `github.com/user-attachments` link that works only with a GitHub login
  session. The PR query also gets `bodyHTML`, which has signed `private-user-images` URLs (valid for a few minutes).
  `signedImageUrls` and `withSignedImages` put these URLs into the description, reviews and comments.

#### Dashboard

- The app starts on the Dashboard (the sidebar item above "Agents"). Its badge counts the items that need the user.
  `dashboard-store` loads the items for the whole app every 5 minutes, so the badge is correct in all views.
- GitHub (`dashboardPullRequests` first, then the slow `dashboardComments`), from each GitHub provider in its scope.
  The results of all providers merge, without duplicates:
  - Review requests: `is:open draft:false review-requested:@me`.
  - The user's open PRs with an action: changes requested, CI failing, merge conflicts, or ready to merge (`myPullRequestReasons`).
  - New comments: light searches (`author:@me`, `commenter:@me`, `reviewed-by:@me`, updated in the last 7 days) give the PRs.
    The comments come from `nodes(ids:)` in batches of 10, only for PRs whose `updatedAt` changed. The service keeps the
    rest in memory. Heavy searches with comments made GitHub fail with 502 and the secondary rate limit.
  - `newComments`: from other people, not bots, in the last 7 days, and after the user's own last comment on the PR.
- Task managers with the `activity` capability answer `activity/list` (see the protocol). ClickUp reads the comments of
  the assigned tasks that changed, and keeps them by the task's `date_updated`. ClickUp has no inbox API, so mentions
  on other tasks are not found.
- Seen comments: `seen.json` in the user data folder (`SeenStore`), keys `gh:<node id>` and `task:<connection>:<id>`.
  Nothing goes to GitHub or ClickUp. A comment is seen when it shows in the PR panel or a diff, when its task opens,
  when it opens on the Dashboard, or with "Mark as seen".
- Settings › Dashboard: hidden authors (`dashboardHiddenAuthors`), for example accounts of automations, and hiding
  rules (`dashboardHiddenRules`): an optional author and a text match ("starts with", "contains" or a regular expression
  with the "i" flag). `isHiddenComment` applies both. The filter button on a Dashboard comment fills in a new rule with
  the fixed start of the comment (`fixedStart`: the words before the first word with a digit). The form shows which
  comments on the Dashboard the rule hides before the user adds it.

Next:

- Markdown for PR descriptions and comments.
- PR and CI state in the worktree list.

### Mobile (goal 5)

The iPhone app is in `ios/` (SwiftUI, iOS 17). It connects to the main process of the desktop app. The API types
are in `src/shared/remote.ts` and again in `ios/ShipWarden/Models.swift`. Change both together. A contract check
finds a difference: the unit tests write sample JSON from the TypeScript types to `ios/ContractFixtures`, and
`npm run check:ios-contract` decodes the samples with `Models.swift` and encodes them again. After a change to
`remote.ts`, run `UPDATE_CONTRACT_FIXTURES=1 npm test` and then the check.

- **Server.** `RemoteServer` (`src/main/remote/`) is an HTTPS server on all interfaces, port 7429 by default. It runs
  only while Settings › Mobile has it on (`settings.remote`). It runs in the main process, or in the background helper
  when that setting is on (see "Background helper"). Only one process listens on the port.
- **Certificate.** At the first start, `ensureTlsIdentity` makes a P-256 key and a self-signed certificate with
  `/usr/bin/openssl` (`remote-key.pem`, `remote-cert.pem` in the app data folder). The phone accepts only the
  certificate with the SHA-256 fingerprint from the pairing code. A new certificate needs a new pairing.
- **Pairing.** "Pair a phone" makes a random code for 10 minutes. The QR code contains
  `shipwarden://pair?name=…&h=<hosts>&p=<port>&fp=<fingerprint>&c=<code>`. The hosts are the `.local` name and the IPv4
  addresses, so a VPN such as Tailscale also works. The phone sends the code to `POST /v1/pair` and gets a random
  token. The code works one time and stops after 5 wrong codes. `remote-devices.json` keeps only the SHA-256 hash of
  each token. "Remove" stops the token at once and closes the streams of that phone.
- **API.** All requests except the pairing need `Authorization: Bearer <token>`.
  - `GET /v1/state`: the projects, repositories, worktrees (with task links and pull requests) and agents.
    The pull requests of a repository stay for 60 seconds (`RemoteSnapshotBuilder`).
  - `GET /v1/events`: server-sent events. `agents` sends the agent list after each change (200 ms debounce).
  - `GET /v1/sessions/<id>/screen`: server-sent events. `screen` sends the screen, `exit` the end of the agent.
  - `POST /v1/sessions/<id>/input`: `{ text, key, submit }`. Only agent sessions accept input. A phone cannot type
    in a shell.
  - `POST /v1/pull-requests/approve`: `{ worktreePath, number, headSha, body }`. The worktree must be in a project.
    The head SHA makes GitHub refuse the approval when the branch has newer commits.
  - Each stream gets a comment every 15 seconds, so the phone finds a dead connection.
- **Screen.** `ScreenMirror` runs the output of a session through a headless xterm.js (`@xterm/headless`): first the
  replay, then the live chunks with a larger sequence number. A snapshot has 150 lines of scrollback and the screen,
  as runs of text with colors and styles. It goes out at most every 150 ms, and only when it changed. A mirror
  exists only while a phone shows the agent, and 30 seconds after.
- **Size.** The mirror needs the size of the terminal. The PTY host keeps `cols` and `rows` in each session. For a
  session of an older host, the main process uses the last size from the page.
- **Input.** The text and Enter go in separate writes, 120 ms apart. Claude Code takes text and Enter in one chunk
  as a paste, and Enter in a paste adds a new line. Text with a new line goes in a bracketed paste when the program
  turned it on. The arrow keys follow the application cursor mode.
- **Phone.** The app tries all hosts at the same time and uses the first that answers with the pinned certificate.
  It connects again after a failure (1 s, then up to 15 s) and when it comes to the foreground. The token is in the
  keychain (`AfterFirstUnlockThisDeviceOnly`). The system Camera opens pairing links through the `shipwarden` URL
  scheme.
- **Limits.** There are no push notifications, because iOS stops the connections of an app in the background, and
  push needs a server. The phone cannot start agents yet, because the page owns the tabs.

#### Background helper

The setting "Keep agents and phone access running when ShipWarden is closed" (`settings.remote.keepRunning`, off by
default) runs the phone server in a background helper. The page asks before it turns the setting on.

- **Program.** `src/main/helper/main.ts` is a third entry of the main build (`out/main/helper.js`), next to the PTY host.
  Electron's Node runtime runs it (`ELECTRON_RUN_AS_NODE=1`). It does not load Electron.
- **Launch agent.** The setting writes `~/Library/LaunchAgents/dev.shipwarden.helper.plist` and loads it with
  `launchctl bootstrap gui/<uid>`. launchd starts the helper at login (`RunAtLoad`) and after a stop (`KeepAlive`).
  `AbandonProcessGroup` keeps the PTY host alive when launchd stops the helper. The arguments are the app data folder
  and the app version. Off: `launchctl bootout` and the app removes the plist. The app does not change the launch agent
  for any other reason. At each start with the setting on, the app writes the plist again when the app path or the
  version changed.
- **Agents.** The agents already run in the PTY host, outside the app. The helper connects to the PTY host as a
  second client, with the same `PtyHostClient`. While the helper is connected, the PTY host does not stop. The helper
  has its own `ShellAgents` scan.
- **Handoff.** `RemoteControl` (main process) selects the owner of the server (`remoteOwner`): the helper when the
  setting is on and the app has a connection to the helper socket, else the app. Before the helper gets the settings,
  the server of the app stops, so the port is free. When the helper stops, the app runs the server again and tries to
  connect each 3 seconds. Each server of the app is new and reads `remote-devices.json` again.
- **Versions.** The helper sends a hash of its script (`hello`). When the hash is not the hash of the app's
  `helper.js` (for example after an update), the app restarts the helper one time (`launchctl kickstart -k`).
- **Data.** While the app is open, the helper asks the app for the snapshot and for approvals, so the phone gets the
  pull requests. While the app is closed, the helper reads `projects.json`, `settings.json` and `task-links.json`
  again for each snapshot, and runs `git worktree list`. It shows no pull requests then, and an approval gets 503.
  The helper makes no outbound network requests, so it does not need the trusted certificates of Settings › Network.
- **Security.** The pairing, the tokens, the certificate and the bind address do not change. The helper uses the same
  `RemoteDevices` file and TLS identity in the app data folder. The helper socket is a Unix socket with mode 0600,
  like the PTY host socket. Only processes of the user can connect.
- **Logs.** The helper writes to `<app data>/helper.log`.
- **Next steps.** Pull requests and approvals while the app is closed (the helper needs the review providers, the
  tokens without Electron `safeStorage`, and the trusted certificates). Start agents from the phone. Push notifications.
