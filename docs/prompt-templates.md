# Prompt templates

A prompt template is a saved prompt with variables, for example "Write tests for {{file}}" or "Fix the lint errors in
{{branch}}". ShipWarden fills the variables from the worktree of the agent and inserts the prompt into the agent
terminal.

## Insert a template

There are three ways to insert a template:

- Click **Prompts** at the top right of an agent terminal, and select a template. The search field finds a template by
  its name. The template goes into this terminal.
- Open the command palette (⇧⌘P), and select **Insert a prompt template**. You can also type the name of the template.
  The template goes into the agent on the screen.
- Press the shortcut of the template. The template goes into the agent on the screen.

"The agent on the screen" is the focused terminal of the worktree. When the focus is on a file, it is an agent in a
different pane of the same tab. Else it is the first agent of the worktree.

By default, ShipWarden does not press Enter. You can edit the prompt in the terminal first, then press Enter. Select
**Send at once** in the template to press Enter after the insert.

The text goes in as a bracketed paste, the same as "Send to agent". A prompt with more than one line stays in one
piece. ShipWarden does not insert a template while the agent is asking a question. Answer the question first.

## Variables

The variables are the same as in the [automations](automations.md), plus `{{file}}`:

| Variable | Value |
|---|---|
| `{{file}}` | The open file, relative to the worktree |
| `{{branch}}` | The branch of the worktree |
| `{{repo}}` | The name of the repository |
| `{{worktree}}` | The folder of the worktree |
| `{{date}}`, `{{time}}` | The date and the time of the insert |
| `{{pr.number}}`, `{{pr.title}}`, `{{pr.url}}`, `{{pr.repo}}`, `{{pr.draft}}` | The pull request of the branch, when it has one |
| `{{task.key}}`, `{{task.title}}`, `{{task.url}}` | The task of the worktree, when it has one |

The pull request data comes from the branch data that the sidebar loads already. An insert sends no request to GitHub.

A variable without a value gets a field in a dialog before the insert. For example, `{{file}}` gets a field when no
file is open, and `{{pr.url}}` gets a field when the branch has no pull request. A variable that ShipWarden does not
know, for example `{{focus}}`, always gets a field. ShipWarden never inserts an empty value. The dialog shows the
complete prompt, and has two buttons: **Insert** and **Send**.

The filters of the automations also work, for example `{{branch|url}}`.

## Shortcuts

Each template can have a keyboard shortcut. Open Settings › Prompt templates, edit the template, click the Shortcut
field, and press the keys. A shortcut needs ⌘, ⌃, or ⌥, for example ⌃⌥T.

ShipWarden rejects a shortcut that is already in use:

- A key of ShipWarden, for example ⌘T or ⇧⌘P. Help › Keyboard Shortcuts lists them.
- A key of macOS or of a text field, for example ⌘C, ⌘V, or ⌘Z.
- A keybind of the terminal config that sends text, for example from the Ghostty config.
- The shortcut of a different template.

The shortcuts work in the worktree view and in the Terminal view. They do not work while a dialog shows.

## Files

Each template is one JSON file in `~/.shipwarden/prompts/<id>.json`, the same as the automations. The file name is
the ID. You can copy the files to share them, and change them in a text editor. ShipWarden watches the folder and
reads a changed file at once. A file that is not valid shows under "Files with problems" in Settings › Prompt
templates, with the reason.

```json
{
  "version": 1,
  "id": "write-tests",
  "name": "Write tests for the open file",
  "prompt": "Write tests for {{file}}. Use the test style of the files near it.",
  "shortcut": "⌃⌥T",
  "send": false
}
```

- `name` and `prompt` are necessary.
- `shortcut` is optional. Write the modifiers with the symbols ⌃, ⌥, ⇧, and ⌘.
- `send` is optional. `true` presses Enter after the insert.

Settings › Prompt templates creates, changes, and deletes the templates. A deleted template goes to the Trash. When you
have no templates, **Add starter templates** adds a few examples.
