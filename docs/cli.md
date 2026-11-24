# The shipwarden command

The `shipwarden` command controls ShipWarden from a terminal. Agents, scripts, and people can use it. It sends each
command to the running app through a local socket. ShipWarden must be open.

## Install

1. Open Settings › Agents › Command line.
2. Click **Install**. ShipWarden adds a link named `shipwarden` in `/usr/local/bin`. When that folder is not writable,
   the link goes to `~/.local/bin`. ShipWarden does not ask for an administrator password.
3. If the setting tells you that the folder is not in your PATH, add it to your shell. For zsh:
   `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`.

The link goes to `ShipWarden.app/Contents/Resources/bin/shipwarden`. That script runs the CLI with the Node of the app
(`ELECTRON_RUN_AS_NODE`), so you do not need Node. An update of the app also updates the command. **Remove** removes the
link.

### The short name

Install also adds a second link with a short name, `sw` by default, next to the `shipwarden` link. Then `sw status`
does the same as `shipwarden status`. In Settings › Agents › Command line, the **Short name** row changes the name or
turns it off. ShipWarden changes the link at once. When a file with that name exists and it is not a link of ShipWarden,
ShipWarden keeps the file, and the setting tells you to choose another name. **Remove** removes both links.

In a development checkout, run `npm run build`, then run `bin/shipwarden`. It uses the Electron of `node_modules`.

## Commands

| Command | What it does | Approval |
|---|---|---|
| `shipwarden status` | Shows the app, the current worktree, and the number of agents. | No |
| `shipwarden worktree list [--all]` | Lists the worktrees of the current repository. `--all` lists all projects. | No |
| `shipwarden worktree create <branch> [--repo <path>] [--base <ref>] [--agent <id>] [--prompt <text>] [--wait]` | Creates a worktree with the setup script of the repository. With `--prompt` or `--agent`, an agent starts in it. | First time in each repository |
| `shipwarden worktree remove <worktree> [--delete-branch]` | Removes a worktree. A worktree with uncommitted changes, a main worktree, and a worktree with a working agent stay. | First time in each worktree |
| `shipwarden agent start [--worktree <w>] [--agent <id>] [--prompt <text>] [--wait]` | Starts a new agent tab. Without `--agent`, the agent of the repository starts. | First time in each worktree |
| `shipwarden agent send <prompt> [--worktree <w>] [--wait] [--timeout <s>]` | Sends a prompt to the agent of the worktree. Without an agent, one starts. `-` reads the prompt from stdin. | First time in each worktree |
| `shipwarden agent wait [--worktree <w>] [--timeout <s>]` | Waits until the agents of the worktree finish their turn. The default time is 30 minutes. | No |
| `shipwarden task get [--worktree <w>]` | Shows the task of the worktree, with its newest comments. | No |
| `shipwarden task status <status> [--worktree <w>]` | Moves the task of the worktree to a status. | The approval of `set_task_status` |
| `shipwarden automation list` | Lists the automations. | No |
| `shipwarden automation run <id> [--worktree <w>]` | Runs an automation now, as the play button does. An automation on a task runs only from the Tasks view. | First time in each worktree |
| `shipwarden skill [install [--dir <folder>]]` | Prints the agent skill file, or installs it. | No |

- A `<worktree>` is a path, a branch, or a name. Without `--worktree`, a command uses the worktree of the working
  folder.
- `--json` prints the result as JSON, for scripts and agents. The text output is for people.
- `--wait` waits until the agent that got the prompt finishes its turn. It counts only the state changes after the
  prompt, so it does not end before the turn starts. Use `--wait` in place of a separate `agent wait` after a prompt.
- The waits read the agent state of the hooks. Claude Code, Codex, Gemini CLI, and opencode report it. For an agent
  without a state, the wait ends at once.

Exit codes: 0 when the command worked, 1 when it failed, 2 for a wrong command or value, 3 at the timeout, and 4 when
ShipWarden is not running or its window is closed.

## Approvals

The commands that change something use the approvals of the MCP server. The first time in a worktree, ShipWarden shows
a dialog. **Allow** applies to that command in that worktree until you revoke it in Settings › Agents › MCP server. Without
an answer in 2 minutes, the command fails. `worktree create` asks for the repository. An automation on a schedule asks
for its repository. `task status` uses the approval of the MCP tool `set_task_status`, so one approval covers both.

## Agent skill

The skill file tells an agent when and how to use the command. It is `skills/shipwarden/SKILL.md` in the repository,
and the CLI has a copy.

- Claude Code: run `shipwarden skill install`. The file goes to `~/.claude/skills/shipwarden/SKILL.md`. Claude Code
  loads it in new sessions.
- Another agent with skills, for example Codex: run `shipwarden skill install --dir <skills folder of the agent>`, for
  example `--dir ~/.codex/skills`.
- A project: run `shipwarden skill install --dir .claude/skills` in the repository, and commit the file.
- To read the file, run `shipwarden skill`.

Run the install again after an update of ShipWarden to get the newest file.

## Security

- The app writes `~/.shipwarden/cli.json` (mode 0600) at each start. The file has the socket path and a random token.
  A test with `SHIPWARDEN_USER_DATA_DIR` writes the file in that folder. Set `SHIPWARDEN_CLI_CONFIG` to the path of the
  file to use that app.
- The socket is in the app data folder (mode 0600), so only your user can connect.
- Each request must have the token. A request without the token, or with a wrong token, fails. The token changes at
  each start of the app.
