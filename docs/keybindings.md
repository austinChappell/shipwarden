# Keybindings

You can give most commands of ShipWarden a different key. Open **Settings › Keyboard**, or change the file
`~/.shipwarden/keybindings.json` in a text editor. The keys in `src/shared/shortcuts.ts` are the defaults.

## Settings › Keyboard

- The field at the top finds a command by its name, its ID, or its key, for example "palette" or "⇧⌘P".
- Click **Record** and press the new keys. Backspace removes the key, so the command has no key. Escape cancels.
- **Reset** gives one command its default keys. **Reset all** gives all commands their default keys. It replaces the
  file with an empty object.
- A changed command shows the "Changed" chip.
- While a field records a key, the shortcuts of ShipWarden do not run. Only ⌘Q and ⌘H still work.

A change applies at once: the key handlers, the macOS menu, the editor, the diff, the terminal, the command palette,
the Keyboard Shortcuts page, the tooltips, the tips, and the tour show the new keys.

## Conflicts

ShipWarden checks each key in three ways:

1. **Blocked keys.** A command cannot get these keys. The keys of macOS and the Edit menu: ⌘Q, ⌥⌘Q, ⌘H, ⌥⌘H, ⌘M,
   ⇧⌘W, ⌘A, ⌘C, ⌘V, ⌘X, ⌘Z, ⇧⌘Z, ⌘Tab, ⌘Space, and ⌘\`. Also ⌃V, which pastes an image into Claude Code or Codex. A key
   needs ⌘ or ⌃, because a key with only ⌥ or ⇧ types a character. The function keys F1 to F12 can be alone.
2. **Keys of another command.** When you record a key of another command, the row asks first. **Replace** gives the
   key to this command and removes it from the other command. **Cancel** keeps all keys as they are. Two commands
   conflict only when they can get the same key event: one of them works in all of the window, or both work in the
   same place. For example, the terminal key "Clear" and the diff key "Comment" can share a key.
3. **Warnings.** A command can get these keys, but the other use of the key then stops. The row shows a warning. These
   keys are ⌘F, ⌘G, ⇧⌘G, ⌘S, ⌘L, ⌘R, ⌥⌘I, ⌘0, ⌘=, ⌘-, ⌃⌘F, the control keys of the terminal (⌃ and a letter without
   ⌘, for example ⌃C), the shortcuts of the prompt templates, and the text keybinds of your Ghostty config.

The file can still contain two commands with the same key, for example after an edit in a text editor. Settings ›
Keyboard then shows the conflict on both rows, and tells which command gets the key. A command of the whole window
gets the key before a command of one place. Between two commands of the same kind, the order of the commands table
below decides.

## The file

`~/.shipwarden/keybindings.json` is one JSON object. Each name is a command ID. Each value is one key, a list of keys,
or `null` for no key. The file has only the changed commands.

```json
{
  "commandPalette": "CmdOrCtrl+Shift+K",
  "previousTab": ["CmdOrCtrl+Shift+[", "Ctrl+Shift+Tab", "CmdOrCtrl+Alt+Left"],
  "newTab": null
}
```

- Write a key as an Electron accelerator: `CmdOrCtrl` (or `Cmd`) is ⌘, `Ctrl` is ⌃, `Alt` (or `Option`) is ⌥, and
  `Shift` is ⇧. The key is a letter, a digit, `F1` to `F12`, a sign such as `[` or `,`, or a name: `Left`, `Right`,
  `Up`, `Down`, `Tab`, `Enter`, `Escape`, `Space`, `Backspace`, `Delete`, `Home`, `End`, `PageUp`, or `PageDown`.
- The form of the UI also works, for example `"⇧⌘K"`.
- ShipWarden reads the file at the start and watches it. A change from a text editor applies at once.
- ShipWarden ignores an entry that is not valid, and the command keeps its default key. Settings › Keyboard lists each
  ignored entry with the reason. A file that is not valid JSON never stops the app. In that case, Settings › Keyboard
  cannot change the file. Correct the file, or click **Reset all**.
- A change from Settings › Keyboard keeps the other entries of the file, also the entries that are not valid.
- With `SHIPWARDEN_USER_DATA_DIR` (a test of a first start), the file is in that folder.

## Commands

The default keys are in the accelerator form.

| ID | Command | Default keys |
|---|---|---|
| `newWorktree` | New worktree | `CmdOrCtrl+N` |
| `newTab` | New shell tab | `CmdOrCtrl+T` |
| `close` | Close the pane, or the tab with one pane | `CmdOrCtrl+W` |
| `selectTab1` | Select tab 1 | `CmdOrCtrl+1` |
| `selectTab2` | Select tab 2 | `CmdOrCtrl+2` |
| `selectTab3` | Select tab 3 | `CmdOrCtrl+3` |
| `selectTab4` | Select tab 4 | `CmdOrCtrl+4` |
| `selectTab5` | Select tab 5 | `CmdOrCtrl+5` |
| `selectTab6` | Select tab 6 | `CmdOrCtrl+6` |
| `selectTab7` | Select tab 7 | `CmdOrCtrl+7` |
| `selectTab8` | Select tab 8 | `CmdOrCtrl+8` |
| `selectLastTab` | Select the last tab | `CmdOrCtrl+9` |
| `previousTab` | Select the previous tab | `CmdOrCtrl+Shift+[`, `Ctrl+Shift+Tab` |
| `nextTab` | Select the next tab | `CmdOrCtrl+Shift+]`, `Ctrl+Tab` |
| `right` | Split right | `CmdOrCtrl+D` |
| `down` | Split down | `CmdOrCtrl+Shift+D` |
| `focusLeft` | Select the split at the left | `CmdOrCtrl+Alt+Left` |
| `focusRight` | Select the split at the right | `CmdOrCtrl+Alt+Right` |
| `focusUp` | Select the split above | `CmdOrCtrl+Alt+Up` |
| `focusDown` | Select the split below | `CmdOrCtrl+Alt+Down` |
| `viewDashboard` | Dashboard | `CmdOrCtrl+Alt+1` |
| `viewAgents` | Agents | `CmdOrCtrl+Alt+2` |
| `viewTasks` | Tasks | `CmdOrCtrl+Alt+3` |
| `viewReview` | Review | `CmdOrCtrl+Alt+4` |
| `viewPipelines` | Pipelines | `CmdOrCtrl+Alt+5` |
| `viewNotes` | Scratch Pad | `CmdOrCtrl+Alt+6` |
| `viewAutomations` | Automations | `CmdOrCtrl+Alt+7` |
| `toggleSidebar` | Show or hide the sidebar | `CmdOrCtrl+B` |
| `focusSidebar` | Move the focus to the sidebar | `CmdOrCtrl+Shift+B` |
| `toggleRightPanel` | Show or hide the right panel | `CmdOrCtrl+E` |
| `focusExplorer` | Move the focus to the file explorer | `CmdOrCtrl+Shift+E` |
| `searchContents` | Search the file contents for the selected text | `CmdOrCtrl+Shift+F` |
| `focusWorkspace` | Move the focus to the workspace | `CmdOrCtrl+Shift+0` |
| `copyFilePath` | Copy the relative path of the active file, or the link of a pull request or task | `CmdOrCtrl+Shift+C` |
| `revealFileInFinder` | Show the active file in Finder | `CmdOrCtrl+Alt+R` |
| `openInEditor` | Open the active file or the worktree in the external editor | `CmdOrCtrl+Alt+O` |
| `commandPalette` | Open the command palette | `CmdOrCtrl+Shift+P` |
| `dictation` | Start or stop dictation in the agent prompt or the chat | `CmdOrCtrl+Alt+L` |
| `back` | Back | `CmdOrCtrl+[` |
| `forward` | Forward | `CmdOrCtrl+]` |
| `settings` | Settings | `CmdOrCtrl+,` |
| `checkForUpdates` | Check for updates | `CmdOrCtrl+Shift+U` |
| `newWindow` | Open a new window | `CmdOrCtrl+Shift+N` |
| `quitAndStop` | Quit and stop all agents | `CmdOrCtrl+Alt+Shift+Q` |
| `clearTerminal` | Clear the terminal screen and scrollback | `CmdOrCtrl+K` |
| `askAgent` | Ask the agent about the selected lines of the editor | `CmdOrCtrl+Shift+A` |
| `toggleBlame` | Show or hide git blame in the editor | `CmdOrCtrl+Alt+B` |
| `comment` | Comment on the selected lines of a diff | `CmdOrCtrl+Shift+M` |
| `openWorktree` | Open the worktree of a pull request | `CmdOrCtrl+O` |
| `openOnHost` | Open a pull request on GitHub | `CmdOrCtrl+Shift+O` |

The keys `clearTerminal` (terminal), `askAgent` and `toggleBlame` (editor), `comment` (diff), and `openWorktree` and
`openOnHost` (the header of a pull request) work only in their place. All other keys work in all of the window.

These keys cannot change: ⌘Q (Quit), ⌘H (Hide), ⌃V (paste an image), Shift+Tab in the terminal, N and P in the changed
files of a pull request, the keys of the in-app browser (⌘R, ⌘L, ⌘F, and ⌥⌘I), the keys of the macOS menus, and the
Enter keys of the forms (⌘↩).
