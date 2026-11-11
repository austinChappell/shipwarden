# Automations

An automation is a rule of the form "when this occurs, do that". For example: when CI fails on the pull request of a
worktree, send the failed checks to the agent of that worktree.

Automations run only while ShipWarden is open. Open the Automations view with ⌥⌘7.

## Files

Each automation is one JSON file in `~/.shipwarden/automations/<id>.json`. The file name is the ID. You can read and
change the files in a text editor. ShipWarden watches the folder and reads a changed file at once. A file that is not
valid shows under "Files with problems", with the reason.

A file has two parts:

- **The definition** is portable: the trigger, the conditions, the actions and the limits.
- **The status and the binding** belong to your Mac: the repository folders, the task manager and the collection.

"Export to a file…" and "Copy as JSON" write only the definition. The text has no paths and no IDs of your Mac. "Import"
reads a file or the clipboard, and opens the editor. You select the binding there. An imported automation always starts
"Off", so you can read its prompts and actions before it runs.

The run history is in `automation-runs.json` in the app data folder. An export never contains it.

## Example

```json
{
  "kind": "shipwarden.automation",
  "version": 1,
  "id": "fix-failed-ci",
  "name": "Fix failed CI",
  "trigger": { "type": "ci.failed" },
  "conditions": { "branchPattern": "eng-*" },
  "actions": [
    {
      "type": "sendToAgent",
      "prompt": "CI failed on pull request #{{pr.number}} ({{pr.url}}):\n{{checks}}\n\nFind the cause of each failure and fix it."
    }
  ],
  "limits": { "approval": "auto", "maxRunsPerTarget": 3, "maxRunning": 2 },
  "status": "on",
  "binding": { "repos": ["/Users/me/code/app"] }
}
```

An export has `kind` and no `status` or `binding`.

## Triggers

| Type | Occurs when | Fields |
|---|---|---|
| `ci.failed` | The checks of the pull request of a worktree branch go from waiting to a failure. | |
| `pr.comment` | Another person comments on or reviews the pull request of a worktree branch. Approvals do not count. | `reviewsOnly`, `ignoreAuthors` |
| `pr.conflict` | The pull request of a worktree branch has merge conflicts. | |
| `pr.merged` | The pull request of a worktree branch is merged. | |
| `agent.done` | An agent ends its turn. | `withoutPullRequest` |
| `task.new` | A task of the bound collection agrees with the filters for the first time. | `labels`, `assignedToMe`, `status` |
| `schedule` | A time of day (`"HH:MM"`, local time) on the selected days (`0` is Sunday). | `days`, `time` |

The pull request triggers and `agent.done` act only on worktrees with a branch, not on the main worktree.
`conditions.branchPattern` limits them to branches that match a pattern. `*` matches any text.

## Actions

| Type | Does | Triggers |
|---|---|---|
| `sendToAgent` | Sends `prompt` to the agent of the worktree. ShipWarden starts the agent of the repository when no agent runs. | `ci.failed`, `pr.comment`, `pr.conflict`, `agent.done` |
| `startAgent` | Makes a worktree and gives `prompt` to a new agent. A task gives the branch name. A schedule uses `branch`. `agentId` selects the agent. | `task.new`, `schedule` |
| `runHeadless` | Runs the agent in print mode. The agent does not change files. With `saveNote`, the answer goes into a note in the folder "Automations". | all |
| `moveTask` | Moves the task to the status with the name `status`. | all except `schedule` |
| `removeWorktree` | Removes the worktree. Git refuses a worktree with uncommitted changes. With `deleteBranch`, a merged local branch goes away too. | `pr.merged` |
| `notify` | Shows a macOS notification with `title` and `body`. | all |

Prompts, titles and branch names can contain variables, for example `{{pr.url}}`. The editor lists the variables of each
trigger. A variable that the trigger does not give becomes empty text.

## Limits and safety

- `approval`: `"ask"` makes each run wait in the Automations view. A notification tells you. `"auto"` runs at once.
- `maxRunsPerTarget`: the most runs for one pull request, worktree or task. This stops a loop of fix, fail, fix.
- `maxRunning`: the most agents of a `startAgent` automation that work at the same time. More runs wait.
- `dailyTokens`: the most tokens of the runs of this automation from midnight (local time). Then the automation starts
  no runs until the next day. Leave it out for no limit.
- A run that sends a prompt waits while the agent works. It runs when the agent finishes its turn.
- Each event runs one time only, also after a restart.
- A new automation starts as a dry run. A dry run records what the automation would do, and does nothing.
- A new `task.new` automation records the tasks that match when it starts. Only later tasks start agents.
- A schedule time that passes while ShipWarden is closed does not run later.
- The Automations view can pause all automations. Automations also pause while the plan usage of Claude or Codex is at
  or above a limit: a whole number from 5% to 100% (90% by default). "No limit" turns the check off, for example
  when you use the API and have no plan.

## Tokens

ShipWarden counts the tokens of each run and shows them in the history.

- A run that sends a prompt counts the agent turn of that prompt: from the prompt to the end of the turn.
- ShipWarden reads the tokens from the transcript file of the Claude Code session. The hooks give the path of the file.
  Subagents count too. "Ask an agent" runs get their tokens from the JSON output of `claude -p`.
- Input tokens, cache writes and output tokens count. Cache reads do not count, because they cost a small part of the price of
  new input (2.5% to 10%, by model) and would fill a limit fast.
- Only Claude Code reports tokens. Runs of Codex, Gemini CLI and opencode count as 0 tokens.
- An agent that started before this version of ShipWarden has no transcript path, so its runs count as 0 tokens.
- "Tokens each day" in the Automations view limits all automations together. Each automation can also have its own
  limit (`limits.dailyTokens`). A limit stops new runs. A run that works already continues.
