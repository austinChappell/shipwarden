---
name: shipwarden
description: Control ShipWarden from the terminal with the `shipwarden` command. Use it to list worktrees, create or remove a worktree, start an agent in a worktree, send a prompt to another agent and wait for its turn, read or move the task of a worktree, and run an automation. Use it when the user says "ShipWarden", "another worktree", "start an agent", or "run the automation".
---

# ShipWarden CLI

ShipWarden is a desktop app that runs coding agents, each in its own git worktree. The `shipwarden` command talks to
the running app. ShipWarden must be open.

## Rules

- Run `shipwarden status` first. If it fails with "ShipWarden is not running", tell the user to open ShipWarden.
- Add `--json` when you read the output in a script or parse it. The text output is for people.
- Without `--worktree`, a command uses the worktree of the working folder. A `<worktree>` is a path, a branch, or a
  name from `shipwarden worktree list --all`.
- The commands that change something ask the user in ShipWarden the first time in each worktree. The command waits
  for the answer for at most 2 minutes. If the user denies it, do not try again. Tell the user.
- To wait for the turn of a prompt, add `--wait` to the command that sends the prompt. A separate `agent wait` right
  after a prompt can end before the agent starts its turn.
- `--wait` and `agent wait` need the state of the agent. Claude Code, Codex, Gemini CLI, and opencode report it. For
  an agent without a state, the wait ends at once.
- Do not remove a worktree that you did not create, unless the user tells you to.

## Commands

| Command | What it does |
|---|---|
| `shipwarden status` | Shows the app, the current worktree, and the number of agents |
| `shipwarden worktree list [--all]` | Lists the worktrees of this repository, or of all projects |
| `shipwarden worktree create <branch> [--repo <path>] [--base <ref>] [--agent <id>] [--prompt <text>] [--wait]` | Creates a worktree. With `--prompt`, an agent starts in it and gets the prompt |
| `shipwarden worktree remove <worktree> [--delete-branch]` | Removes a worktree. A worktree with uncommitted changes stays |
| `shipwarden agent start [--worktree <w>] [--agent <id>] [--prompt <text>] [--wait]` | Starts a new agent tab |
| `shipwarden agent send <prompt> [--worktree <w>] [--wait] [--timeout <s>]` | Sends a prompt to the agent of a worktree. `-` reads the prompt from stdin |
| `shipwarden agent wait [--worktree <w>] [--timeout <s>]` | Waits until the agents of the worktree finish their turn |
| `shipwarden task get [--worktree <w>]` | Shows the task of the worktree and its comments |
| `shipwarden task status <status> [--worktree <w>]` | Moves the task to a status, for example "In review" |
| `shipwarden automation list` | Lists the automations |
| `shipwarden automation run <id> [--worktree <w>]` | Runs an automation now |

## Examples

Give work to a new agent, and wait for the result:

```sh
shipwarden worktree create fix/login-timeout --prompt "Fix the login timeout in src/auth. Run the tests." --wait --timeout 1800
```

Ask the agent of another worktree a question, and wait for its turn:

```sh
shipwarden agent send "Which API does the new parser use?" --worktree feature/parser --wait
```

Move the task of this worktree when the work is done:

```sh
shipwarden task status "In review"
```

## Exit codes

- 0: the command worked.
- 1: the command failed. The error text tells why.
- 2: the command or its values are not correct.
- 3: the time of the command ended (`--timeout`).
- 4: ShipWarden is not running, or its window is closed.
