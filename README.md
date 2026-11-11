# ShipWarden

ShipWarden is a desktop app that runs many coding agents at the same time.
Each agent works in its own git worktree. You give tasks to agents, watch
their work, review their pull requests and merge the results.

A ship warden keeps watch over the ships in a harbor and sends each ship
safely on its course. This app does the same job for coding agents.

## Goals

1. **Task sources that anyone can add.** ShipWarden defines an open plugin
   spec for task trackers. GitHub Issues and Linear are the first plugins.
   The community can write plugins for ClickUp, Jira and other trackers.
   Each plugin controls how its tasks show in the task UI.
2. **A real code editor.** ShipWarden includes a full editor with LSP
   support. Go to definition, find references, hover info and diagnostics
   must work in every worktree.
3. **Full pull request reviews.** You can read diffs, write inline
   comments, request changes and approve a PR in the app.
4. **GitHub Actions.** You can see check runs, read logs, run workflows
   again and send a failed job back to an agent.
5. **Mobile app.** An iPhone app shows agent status and lets you
   approve or reply to an agent.

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
logs, run jobs again and send a failed job or a review comment to the agent. ShipWarden uses
your GitHub CLI login (`gh auth login`).

The Agents view (⌥⌘2) shows all running agents in one list. Each row shows the state of the agent
(needs input, blocked on CI, working or done), the time since its last output, and its pull request
with the CI state. Click a row to open the agent's terminal. The header shows the plan usage of
Claude and Codex. ShipWarden has no usage data for each agent.

The Tasks view shows the tasks of a task tracker. Task trackers are plugins: GitHub Issues and
ClickUp are built in, and anyone can write a plugin with the
[ShipWarden Task Protocol](docs/task-plugin-protocol.md). "Start in worktree" creates a branch
for a task and gives the task to a new agent.

The Automations view (⌥⌘7) runs rules of the form "when this occurs, do that" while ShipWarden is open. For example:
send a CI failure or a review comment to the agent of the worktree, start an agent on each task that gets a label, or
remove the worktree after its pull request merges. Each automation is a JSON file in `~/.shipwarden/automations` that
you can export and share. Runs can wait for your approval, and limits stop loops. See
[docs/automations.md](docs/automations.md).

The iPhone app (`ios/`) connects to ShipWarden on your Mac over your network. It shows the
agents and their terminal screens, the worktrees with their pull requests and CI state. You
can reply to an agent, answer its questions and approve a pull request. Turn it on in
Settings › Mobile and pair the phone with the QR code. See [ios/README.md](ios/README.md).

## Development

You need Node 24 or later and git.

```sh
npm install        # also downloads Electron and fixes the node-pty helper
npm run dev        # starts the app with hot reload. A change in the main process restarts the app.
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

Do not delete `~/Library/Application Support/ShipWarden` to test a first start. Start the app with a separate data folder:

```sh
SHIPWARDEN_USER_DATA_DIR=/tmp/sw-fresh npm run dev
```

- The app does not copy the old Yardmaster data into this folder, and it does not connect to the PTY host of the old name.
- The PTY host socket is in the data folder, so the app starts a second PTY host. Quit it with ⇧⌥⌘Q after the test.
- The worktrees, notes, plugins and automations in `~/.shipwarden` are still your real folders.
- Delete the folder to start again from the first start.

### Repo layout

| Path | Contents |
|---|---|
| `src/main/` | The Electron main process: worktrees, files, GitHub, tasks, Ghostty config import |
| `src/main/pty-host/` | The PTY host process that keeps terminals and agents alive when the app quits |
| `src/preload/` | The bridge that gives `window.shipwarden` to the UI |
| `src/renderer/` | The React UI |
| `src/shared/` | Types and functions that the main process and the UI both use |
| `src/main/remote/` | The HTTPS server for the iPhone app |
| `ios/` | The iPhone app (SwiftUI) |
| `docs/ARCHITECTURE.md` | Decisions and the plan |

### Native install scripts

npm 11 does not run install scripts until you approve them. The `allowScripts` field in
`package.json` lists the approved packages. If you change a native dependency, run
`npm install-scripts ls` and approve the new version.
