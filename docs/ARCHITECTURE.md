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

## The old name (Yardmaster)

The app was Yardmaster before it was ShipWarden. `main/legacy-migration.ts` copies the old data one time, at the
first start:

- The app data folder (`Application Support/Yardmaster` → `Application Support/ShipWarden`), without caches and sockets.
- `~/.yardmaster/notes` and `~/.yardmaster/plugins` to `~/.shipwarden`. The notes index gets its new name.
- The copy leaves the old folders as they are. The worktrees in `~/.yardmaster/worktrees` stay there, because git keeps their paths.

Other compatibility:

- A PTY host of the old name still runs after the update. The app connects to its socket, so its terminals stay. A new host uses the new folder.
- The agent hooks read `SHIPWARDEN_*` or `YARDMASTER_*` variables, and send both token headers.
- Setup, teardown and saved scripts get the `SHIPWARDEN_*` and the old `YARDMASTER_*` variables.
- A plugin can have `shipwarden-plugin.json` or the old `yardmaster-plugin.json`.
- The page copies its `yardmaster.*` local storage keys to `shipwarden.*`. Old theme IDs (lantern, junction, nightline, caboose, steel, dusk) convert to the new themes.
- The keychain key of the secrets has the app name, so secrets from Yardmaster (for example a ClickUp token) must be entered again.

## Releases and updates

See [RELEASING.md](RELEASING.md). The Release workflow (`.github/workflows/release.yml`) builds the DMG and the zip,
and publishes a GitHub release with the notes and `shipwarden-update.json`. `UpdateService` (main) reads the latest
release, and `UpdateNotice` (page) shows it. The install replaces the app bundle after the app quits.

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
│ PtyHostClient      connects to the PTY host (Unix socket)        │
│ Ghostty loader     `ghostty +show-config` or the config files    │
│ FileService        folders, git ls-files, git grep, read/write   │
│ FileWatcher        recursive fs.watch (FSEvents) per worktree    │
│ LspManager         one language server per worktree and language │
│ GitHubService      PRs, reviews, checks, job logs, workflows     │
│ TaskHost           task plugin processes (JSON-RPC on stdio)     │
│ ProcessService     processes and ports per worktree, stop        │
└──────────────────┬───────────────────────────────────────────────┘
                   │ JSON-RPC on <app data>/pty-host-v1.sock
┌──────────────────┴──────── PTY host (detached process) ──────────┐
│ TerminalManager    node-pty sessions + output buffers            │
│ HookServer         agent state from Claude Code hooks (HTTP)     │
└──────────────────────────────────────────────────────────────────┘
```

### Terminals

- The terminal processes live in the PTY host, a separate process. The app starts it with Electron's Node runtime
  (`ELECTRON_RUN_AS_NODE=1`), detached from the app. The terminals and agents continue to run when the app quits.
  The next app run connects to the same host and shows the sessions again.
- The host stops when no app is connected and no session has a running process (after 10 seconds).
  A new host waits 30 seconds for its first app.
- Each protocol version has its own socket (`pty-host-v<N>.sock`). The host sends a build ID (a hash of its script).
  When the build ID is not the app's build ID, the app replaces the host only if the host has no running sessions.
  Otherwise the app uses the old host, so an update does not stop running agents.

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
  60 seconds after a turn ends.
- The worktree list shows the state of the agent that needs the user most. A macOS notification appears when an agent
  needs input or is done, unless the user looks at that agent.
- Other agents (for example Codex) run without hooks and show no detailed state.
- Each terminal gets the hook variables, also a shell tab. A zsh shell gets `ZDOTDIR=<app data>/shell-integration/zsh`.
  That `.zshenv` sets `ZDOTDIR` back to the user's value and reads the user's startup files. Before the first prompt,
  it adds a `claude` function that adds `--settings <hooks file>`. Thus `claude` typed in a shell tab reports its state.
  The shell tab then shows in the Agents view until the agent sends SessionEnd (`runsAgent`).
- Each state change carries a message and a time. PreToolUse gives a description of the tool call for people
  (`describeTool`, for example "Editing App.tsx" or "Running npm test"). UserPromptSubmit gives a one-line summary of
  the prompt, which the session keeps.
- The Agents view (the first row of the sidebar) lists the running agents of all projects, grouped by project. A row
  shows the state and its time, a name (the linked task, else the last prompt, else the branch), the activity, and the
  repository and branch. A click switches to the agent's project if necessary and opens its tab.
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
- ShipWarden adds its hooks only to Claude Code. Only an agent with hooks starts with the state "starting". Another agent
  has no state, and the worktree list shows only that it runs.

### Split view

- A tab can have splits, as in Ghostty: a tree of panes (`shared/panes.ts`). A split shows two parts side by side
  (`row`) or one above the other (`column`) with a ratio. Each pane shows one view: a terminal, a file, a diff or a log.
- `panes[worktree]` is a list of split tabs (`SplitGroups`). A split tab is one entry in the tab strip, at the place of
  its first pane, with the title of its focused pane and the number of panes. A view in no split is a normal tab.
- `activeTabs` stays the active view of each worktree. In a split tab, it is the focused pane. App computes the
  layout of the active tab from both, without the panes of closed views (`pruneGroups`).
- Keys, as in Ghostty (`shortcutAction`): ⌘T a new shell tab, ⌘W close the focused pane (the tab when it has one
  pane; a running agent asks first), ⌘D and ⇧⌘D a new shell pane at the right of or below the focused pane, ⌘[ and ⌘]
  move the focus. ⇧⌘W closes the window. A focused terminal takes all keys, so a menu shortcut alone does not work.
  The keys go through two ways: `before-input-event` in the main process (before the page and the menu), and a keydown
  listener of the page in the capture phase. Both send the same action. The File menu lists the keys.
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

### Pipelines

- The sidebar item "Pipelines" (below "Review") shows the GitHub Actions workflows of one repository. The name is
  neutral, because GitLab and Azure DevOps (planned providers) call these pipelines. The repositories come from the
  organizations of Settings › Code review, the same as the Review view.
- Columns: the workflows (with a run button when the workflow has a `workflow_dispatch` trigger), the newest 40 runs
  (of all workflows or one), and the selected run: its actions, its jobs (latest attempt) and the log of a job.
- Run dialog: a branch (from `/branches`, the default branch first) and the inputs of the trigger. GitHub has no API
  for the inputs, so `parseWorkflowFile` reads the workflow YAML (js-yaml) of the chosen branch.
  `dispatchInputs` uses the defaults and refuses an empty required input.
- Actions: cancel a run that waits or runs, re-run failed jobs, re-run all jobs, open on GitHub. Each asks first.
- The runs refresh every 8 seconds while a run waits or runs, else every minute.

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
- Chromium (the renderer) uses the macOS keychain already. The settings are for the Node parts.
- Main process: `TrustedCertificates.apply` reads the certificates and calls `tls.setDefaultCACertificates` with the
  default certificates plus the extra ones. It runs before the first request (`networkReady`: the GitHub client and the
  usage bar wait for it) and again when the setting changes. New connections use the new certificates.
- Task plugins are other processes. `apply` writes the extra certificates to `trusted-ca.pem` in the user data folder,
  and the task host starts each plugin with `NODE_EXTRA_CA_CERTS` set to it. A change of the setting stops the plugins.
  They start again at the next request.
- A failed fetch shows its cause (`networkErrorDetail`, and `networkDetail` in the plugin SDK). A certificate error
  such as `SELF_SIGNED_CERT_IN_CHAIN` also tells the user to go to Settings › Network. "Test" connects to GitHub and ClickUp.

### Ghostty config import

- If Ghostty is installed, ShipWarden runs `ghostty +show-config`. Ghostty then resolves themes and included files.
- If not, ShipWarden reads the config files directly.
- ShipWarden imports colors, the 16-color palette, the font family and size, the cursor style, and `text:` keybinds (for example `shift+enter=text:\n`).
- ShipWarden includes JetBrains Mono, because that is Ghostty's default font.

### Known problems in ghostty-web 0.4

- An empty `write()` throws "offset is out of bounds". `TerminalPool` skips empty writes.
- A new terminal can reuse the WASM memory of a closed terminal without clearing it. Old text and garbled characters
  can then show. `TerminalPool` clears the screen and the scrollback of each new terminal, and it does not free the
  terminal of a closed session: it keeps up to 4 spares with the same settings and resets a spare (`ESC c` and a clear)
  for the next session. Only a color change frees terminals (`resetAll`), because the colors need new terminals.
- We should report both problems to coder/ghostty-web.

## Planned parts

### Task plugins (goal 1)

The protocol is in [task-plugin-protocol.md](task-plugin-protocol.md). It does not depend on Electron,
so that the mobile app and a CLI can use the same plugins.

- A plugin is a separate process with a `shipwarden-plugin.json` manifest. It speaks JSON-RPC on stdio with
  `Content-Length` headers, like an LSP server.
- `initialize` returns the capabilities and the UI as data: extra fields, actions and list filters.
  The manifest lists the settings. ShipWarden encrypts secret settings with the macOS keychain (Electron safeStorage).
- `TaskHost` (main process) finds the plugins in `plugins/` (built-in) and `~/.shipwarden/plugins/` (installed by the user).
  It starts one process for each connection and project. A plugin with `"command": "node"` runs on ShipWarden's own Node runtime.
- `plugins/sdk` is a JavaScript SDK with no dependencies and TypeScript declarations.
- Built-in plugins: GitHub Issues (each repository is a collection, the scope is users and organizations, uses the
  GitHub CLI login or its own token) and ClickUp (each list is a collection, the scope is workspaces, needs a personal
  API token).
- Task managers (connections): Settings > Task managers lists the connections. Each one has its own settings and an
  optional scope, and can be off. All projects use the connections that are on. The main process keeps this in
  `task-managers.json`, and the secrets by connection ID in `plugin-settings.json`.
  At the first start, the ClickUp token and GitHub Issues of version 2 become the connections "ClickUp" and "GitHub".
- The Tasks view shows the connections of the active project, one collection at a time, with the details, the status,
  comments and plugin actions. It has no repository picker: "Start in worktree" asks for the repository when the
  project has more than one.
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

### Language servers

- `LspManager` (main process) starts one server for each worktree and language, with the worktree as `rootUri`.
  It answers the server's requests (configuration, workspace folders) and sends diagnostics to the UI.
- Servers:
  - TypeScript and JavaScript: `tsc --lsp --stdio` from TypeScript 7. ShipWarden uses the worktree's own TypeScript if it is version 7 or later. If not, it uses the TypeScript 7 that ShipWarden includes.
  - Rust: `rust-analyzer`. Python: `basedpyright-langserver` or `pyright-langserver`. Go: `gopls`. These must be in the PATH.
- The main process reads the PATH of the login shell at start. An app that starts from Finder does not get it.
- `LspBridge` (renderer) syncs each Monaco model in a worktree with incremental changes.
  It registers Monaco providers for definition, type definition, implementation, references, hover, document highlights and completion.
  It routes each request to the server of the worktree that contains the file.
- Diagnostics: the bridge pulls them (`textDocument/diagnostic`) after each change and also accepts pushed diagnostics.
- "Go to definition" into another file opens that file in a ShipWarden tab. Peek views load the models of the result files first.

Next:

- Rename, code actions and signature help from the servers.
- Downloads of language servers that are not installed.
- Open files stay open after a reload. The panel width can change.

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
- Viewed files: `viewerViewedState` from GraphQL, changed with `markFileAsViewed` and `unmarkFileAsViewed`.
  The file list shows "x of y viewed". The diff header has a "Viewed" box. The change shows at once and goes back on an error.

#### Review view

- The sidebar item "Review" (below "Tasks") opens a main view for the pull requests of any repository, not only local ones.
- Settings › Code review: the provider (only GitHub now) and the organizations (`reviewOwners`: `'all'` or a list of logins).
  Without a choice, the view shows a link to these settings.
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
- Merge shows only for the user's own PRs. "Send to agent" is not available, because the PR has no worktree.
- Images: an image of a private repository is a `github.com/user-attachments` link that works only with a GitHub login
  session. The PR query also gets `bodyHTML`, which has signed `private-user-images` URLs (valid for some minutes).
  `signedImageUrls` and `withSignedImages` put these URLs into the description, reviews and comments.

#### Dashboard

- The app starts on the Dashboard (the sidebar item above "Agents"). Its badge counts the items that need the user.
  `dashboard-store` loads the items for the whole app every 5 minutes, so the badge is correct in all views.
- GitHub (`dashboardPullRequests` first, then the slow `dashboardComments`), in the owners of Settings › Code review:
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
- Suggested changes in review comments.

### Mobile (goal 5)

The iPhone app is in `ios/` (SwiftUI, iOS 17). It connects to the main process of the desktop app. The API types
are in `src/shared/remote.ts` and again in `ios/ShipWarden/Models.swift`. Change both together.

- **Server.** `RemoteServer` (`src/main/remote/`) is an HTTPS server on all interfaces, port 7429 by default. It runs
  only while Settings › Mobile has it on (`settings.remote`). It is in the main process, so ShipWarden must be open.
  The window can be closed.
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
