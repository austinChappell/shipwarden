# Automations

An automation is a rule of the form "when this occurs, do that". For example: when CI fails on the pull request of a
worktree, send the failed checks to the agent of that worktree.

An automation can also be manual. Then it is a button in the view of a worktree, a pull request or a task. See
[Manual automations](#manual-automations).

Automations run only while ShipWarden is open. Open the Automations view with ⌥⌘7.

## Files

Each automation is one JSON file in `~/.shipwarden/automations/<id>.json`. The file name is the ID. You can read and
change the files in a text editor. ShipWarden watches the folder and reads a changed file at once. A file that is not
valid shows under "Files with problems", with the reason.

A file has two parts:

- **The definition** is portable: the trigger, the conditions, the actions and the limits.
- **The status and the binding** belong to your Mac: the repository folders, the task manager, the collections, the
  label rules and the secrets.

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
      "mode": "auto",
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
| `task.new` ("Task matches") | A task of a bound collection agrees with the filters for the first time: a new task, or a change such as a new label, a new assignee or a new status. Other changes do not count. A done or canceled task never counts. Each task runs one time only. | `labels`, `assignedToMe`, `status` |
| `schedule` | A time of day (`"HH:MM"`, local time) on the selected days (`0` is Sunday). | `days`, `time` |
| `manual` | You click the button of the automation. It never runs by itself. | `entity`, `button` |

The pull request triggers and `agent.done` act only on worktrees with a branch, not on the main worktree.
`conditions.branchPattern` limits them to branches that match a pattern. `*` matches any text.

## Manual automations

A manual automation has the trigger `manual`. Its `entity` sets where its button shows:

| Entity | The button shows in | Variables |
|---|---|---|
| `worktree` | The header of each worktree (the ⚡ menu). | `branch`, `repo`, `worktree`, `pr.*` when the branch has an open pull request, `task.*` of the task of the worktree |
| `pullRequest` | The pull request panel of each worktree, under the title. | `pr.number`, `pr.title`, `pr.url`, `pr.repo`, `pr.draft`, `pr.author`, `pr.base`, `pr.state`, `pr.body`, the worktree variables, `task.*` |
| `task` | The details of each task, next to the task actions. | `task.key`, `task.title`, `task.url`, `task.description`, `task.status`, `task.labels`, `task.assignees`, `task.priority`, `repo` |
| `none` | Nowhere. Use the play button in the Automations view. | `repo`, `date`, `time` |

`button` is the text of the button. Without it, the button shows the name of the automation.

A button shows only when all of these are true:

- The status of the automation is "On" or "Dry run".
- For a worktree or a pull request: the repository is in `binding.repos` (or the list is empty), and the branch matches
  `branchPattern`.
- The conditions agree (see [Conditions](#conditions)).

A click starts one run at once. A click is the approval, so a manual automation has no approval and no run limits. A
run still waits while the agent works. The Automations view shows the run and its result.

```json
{
  "name": "Deploy a preview",
  "trigger": { "type": "manual", "entity": "pullRequest", "button": "Deploy preview" },
  "conditions": {
    "when": { "all": [{ "var": "pr.draft", "op": "equals", "value": "false" }] }
  },
  "actions": [
    {
      "type": "http",
      "method": "POST",
      "url": "https://ci.example.com/api/previews",
      "headers": [{ "name": "Authorization", "value": "Bearer {{secret.CI_TOKEN}}" }],
      "body": "{\"branch\": {{branch|json}}, \"pr\": {{pr.number}}}"
    },
    {
      "type": "if",
      "condition": { "var": "http.json.url", "op": "isSet" },
      "then": [{ "type": "notify", "title": "The preview is ready", "body": "{{http.json.url}}" }],
      "else": [{ "type": "stop", "reason": "The CI did not give an address.", "fail": true }]
    }
  ],
  "limits": { "approval": "auto", "maxRunsPerTarget": 3, "maxRunning": 2 }
}
```

## Conditions

`conditions.when` is a condition. The automation starts a run only when it agrees. For a manual automation, the button
shows only when it agrees. An "If" action uses the same form in `condition`.

A rule compares a variable with a value:

```json
{ "var": "branch", "op": "matches", "value": "eng-*" }
```

| `op` | Agrees when the variable |
|---|---|
| `equals`, `notEquals` | is (is not) the value |
| `contains`, `notContains` | contains (does not contain) the value |
| `matches`, `notMatches` | matches (does not match) the pattern. `*` matches any text. |
| `isSet`, `isEmpty` | has a value (is empty) |
| `greaterThan`, `lessThan` | is a number more than (less than) the value. A text that is not a number never agrees. |

The text operators ignore case. The value can contain variables, for example `"value": "{{pr.base}}"`.

Groups combine rules. Groups can contain groups:

- `{ "all": [ ... ] }` agrees when each item agrees. An empty `all` agrees.
- `{ "any": [ ... ] }` agrees when one or more items agree.
- `{ "not": { ... } }` agrees when its item does not agree. The editor has no `not`. Use the negative operators.

A list in place of a condition is the same as `all`.

`conditions.when` uses the variables that the event gives without a request. It cannot use `checks`, `http.*` and the
details of the task of a worktree (the status, the description, the labels). An "If" action can use all variables.

## Templates

Prompts, titles, branch names, addresses, headers and bodies can contain variables, for example `{{pr.url}}`. A filter
after a bar changes the value:

- `{{comment.body|json}}` gives a JSON string with the quotes. Use it in a JSON body, so quotes and new lines in the text
  do not break the JSON.
- `{{branch|url}}` encodes the value for a part of a web address.

## Task automations

A `task.new` automation reads the tasks of one or more collections, for example ClickUp lists. Select them in the
"Collections" field. A task that is in two collections starts one run only.

A label of the task can select the repository. Add a rule in "Repository by label", for example the label `api` and the
repository of the API. The first rule with a label of the task applies. The labels ignore case. A task with no matching
rule goes to the default repository. When there is no default repository, that task does not run. It runs when it gets a
label with a rule.

```json
"binding": {
  "connectionId": "clickup",
  "collections": [{ "id": "901", "name": "Sprint" }, { "id": "902", "name": "Backlog" }],
  "repos": ["/Users/me/code/app"],
  "labelRepos": [{ "label": "api", "repo": "/Users/me/code/api" }]
}
```

A file of an older version has `collectionId` and `collectionName`. ShipWarden reads them as one collection.

## Actions

| Type | Does | Triggers |
|---|---|---|
| `sendToAgent` | Sends `prompt` to the agent of the worktree. ShipWarden starts the agent of the repository when no agent runs. `mode` sets the permission mode. | `ci.failed`, `pr.comment`, `pr.conflict`, `agent.done` |
| `startAgent` | Makes a worktree and gives `prompt` to a new agent. A task gives the branch name: the template of Settings › Worktrees › Branch names for tasks, else the task key and the title. A schedule uses `branch`. `agentId` selects the agent. `mode` sets the permission mode. | `task.new`, `schedule` |
| `runHeadless` | Runs the agent in print mode. The agent does not change files. With `saveNote`, the answer goes into a note in the folder "Automations". | all |
| `moveTask` | Moves the task to the status with the name `status`. | all except `schedule` |
| `removeWorktree` | Removes the worktree. Git refuses a worktree with uncommitted changes. With `deleteBranch`, a merged local branch goes away too. | `pr.merged` |
| `notify` | Shows a macOS notification with `title` and `body`. | all |
| `postMessage` | Posts `message` to a chat channel, for example a ClickUp channel. See [Chat channels](#chat-channels). | all |
| `http` | Sends an HTTP request. See [HTTP requests](#http-requests). | all |
| `if` | Runs the `then` actions when `condition` agrees, else the `else` actions. The lists can contain all actions, also `if`. | all |
| `stop` | Stops the run. The next actions do not run. `reason` goes into the run history. With `fail`, the run fails. | all |

For a manual automation, the entity sets the actions:

- `sendToAgent` and `removeWorktree`: `worktree` and `pullRequest`.
- `startAgent`: `task` and `none`.
- `moveTask`: `worktree`, `pullRequest` and `task`.
- `runHeadless`, `notify`, `postMessage`, `http`, `if` and `stop`: all entities.

### Chat channels

`postMessage` posts a message to a chat channel of a task manager. Today only ClickUp has chat channels. The action uses
the API token of the ClickUp connection in Settings › Task managers.

| Field | Value |
|---|---|
| `channel` | `{ "id", "name" }`. Select the channel in the editor. The ID contains the ClickUp workspace. |
| `message` | The text, in Markdown. It can contain all variables of the trigger, for example `{{pr.url}}` or `{{task.title}}`. |
| `connectionId` | The task manager. It is local to your Mac, so an export does not contain it. Without it, ShipWarden uses the only task manager with chat channels. |

To post to a different channel for each repository, put the actions in "If" actions. `{{pr.repo}}` is the repository
of the pull request, for example `acme/api`. `{{repo}}` is the name of the repository folder.

```json
{
  "name": "Announce merges",
  "trigger": { "type": "pr.merged" },
  "actions": [
    {
      "type": "if",
      "condition": { "var": "pr.repo", "op": "equals", "value": "acme/api" },
      "then": [
        {
          "type": "postMessage",
          "channel": { "id": "9012345:4-90123-8", "name": "api-releases" },
          "message": "Merged **{{pr.title}}** ({{pr.url}}) in {{pr.repo}}.\nTask: {{task.key}} {{task.title}}"
        }
      ],
      "else": [
        {
          "type": "postMessage",
          "channel": { "id": "9012345:4-90123-2", "name": "engineering" },
          "message": "Merged **{{pr.title}}** ({{pr.url}}) in {{pr.repo}}."
        }
      ]
    }
  ],
  "limits": { "approval": "auto", "maxRunsPerTarget": 3, "maxRunning": 2 }
}
```

For more than two channels, put an "If" action in the `else` list. To post to two channels, add two actions.

### HTTP requests

| Field | Value |
|---|---|
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. `GET` by default. |
| `url` | The address. It must start with `http://` or `https://`, or with a variable. |
| `headers` | A list of `{ "name", "value" }`. |
| `body` | The body. A `GET` request has no body. A body that starts with `{` or `[` gets `Content-Type: application/json` when no header sets the type. |
| `allowFailure` | `true` continues the run when the status is not 200 to 299. |
| `timeoutSeconds` | The time limit, 1 to 300 seconds. 30 by default. |

ShipWarden sends the request from the main process. The request uses the trusted certificates of Settings › Network, so
it also works on a network that inspects TLS traffic.

The next actions get the answer as variables:

- `{{http.status}}`: the status, for example `200`.
- `{{http.ok}}`: `true` when the status is 200 to 299, else `false`.
- `{{http.body}}`: the body. ShipWarden keeps at most 1 MB.
- `{{http.json.NAME}}`: a value of a JSON body, for example `{{http.json.data.id}}` or `{{http.json.items.0.name}}`. An
  object or a list gives its JSON text. A list also has `.length`.

A second request replaces the variables of the first request.

### Secrets

A request often needs a token. Do not write the token in the definition, because an export contains the definition. Add
it under "Secrets" in the editor, and use `{{secret.NAME}}` in the address, a header or the body.

```json
"binding": { "secrets": { "CI_TOKEN": "…" } }
```

- The secrets are in the binding, so an export never contains them. An import asks for them.
- Only the fields of an HTTP request can use a secret. Prompts, notifications and conditions cannot.
- The run history shows `•••` in place of a secret.
- ShipWarden keeps the secrets as plain text in the automation file on your Mac.
- An automation that uses a secret without a value can only be "Off".

### Agent mode

`sendToAgent` and `startAgent` can have a `mode`. The agent then works in that permission mode, so a run does not stop
for a permission question. Without `mode`, a new agent uses the mode of the agent in Settings › Agents. When that is
"Own setting", the agent uses its own configuration.

| Mode | Claude Code | Codex | Gemini CLI | opencode |
|---|---|---|---|---|
| `auto` | `--permission-mode auto` | `--sandbox workspace-write --ask-for-approval never` | `--approval-mode yolo` | `--auto` |
| `acceptEdits` | `--permission-mode acceptEdits` | `--sandbox workspace-write --ask-for-approval on-request` | `--approval-mode auto_edit` | none |
| `plan` | `--permission-mode plan` | `--sandbox read-only --ask-for-approval never` | `--approval-mode plan` | none |
| `bypassPermissions` | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | `--approval-mode yolo` | `--auto` |

The options go after the command of the agent when ShipWarden starts a new session. For a `sendToAgent` run, an agent
can run already in the worktree:

- Claude Code: ShipWarden presses Shift+Tab until the status line shows the mode. Then it sends the prompt.
- Other agents cannot change the mode while they run. The run fails with a message.

A mode that the agent does not have also makes the run fail with a message. A custom agent command has no modes.

Prompts, titles and branch names can contain variables, for example `{{pr.url}}`. The editor lists the variables of each
trigger. A variable that the trigger does not give becomes empty text.

## Run now

The play button of an automation starts one run at once. You select the target first:

- A pull request or agent trigger, and a manual `worktree` or `pullRequest` automation: a worktree of the repositories
  of the automation. The branch must match `branchPattern`. The run gets the pull request of the branch, if there is
  one. A `pullRequest` automation needs one. The comment and the last agent message stay empty.
- `task.new`: an open task of the collections of the automation.
- A manual `task` automation: use the button in the details of a task.
- `schedule` and a manual `none` automation: no target. The date and the time are now.

The conditions must agree with the target. Else the run does not start, and a message tells why.

A manual run ignores the trigger, the approval, the pause and the limits. It also runs when the automation is off, so
you can test an automation before you turn it on. It still waits while the agent works, and while `maxRunning` agents of
the automation work. A dry-run automation records
a dry run only. A manual run does not count for `maxRunsPerTarget`. Its tokens count for `dailyTokens`.

## Limits and safety

- `approval`: `"ask"` makes each run wait in the Automations view. A notification tells you. `"auto"` runs at once.
- `maxRunsPerTarget`: the most runs for one pull request, worktree or task. This stops a loop of fix, fail, fix.
- `maxRunning`: the most agents of a `startAgent` automation that work at the same time. More runs wait.
- `dailyTokens`: the most tokens of the runs of this automation from midnight (local time). Then the automation starts
  no runs until the next day. Leave it out for no limit.
- A run that sends a prompt waits while the agent works. It runs when the agent finishes its turn.
- Each event runs one time only, also after a restart.
- A new automation starts as a dry run. A dry run records what the automation would do, and does nothing.
- A new `task.new` automation records the tasks that match when it starts. Only later tasks start agents. A collection
  that you add later does the same.
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
- The history shows the cache reads of each run next to its tokens, so you can see them. The limits do not count them.
- Only Claude Code reports tokens. Runs of Codex, Gemini CLI and opencode count as 0 tokens.
- An agent that started before this version of ShipWarden has no transcript path, so its runs count as 0 tokens.
- "Tokens each day" in the Automations view limits all automations together. Each automation can also have its own
  limit (`limits.dailyTokens`). A limit stops new runs. A run that works already continues.
