# Get started with ShipWarden

This guide tells you how to install ShipWarden and start your first agent. Do steps 1 to 6 in this order. The
[Reference](#reference) part after them is for later.

These words have a special meaning in this guide:

| Word | Meaning |
|---|---|
| Agent | A coding agent CLI, for example Claude Code, that runs in a terminal tab of ShipWarden. |
| Worktree | An additional working folder of a repository. Each worktree has its own branch. Each agent works in its own worktree, so the agents do not change the files of a different agent. |
| Project | A group of repositories in the sidebar. ShipWarden makes the project "Default" for you. |
| Code review provider | Your GitHub or Azure DevOps account in ShipWarden. ShipWarden gets the pull requests and the checks from it. |

## 1. Get the tools that ShipWarden uses

ShipWarden starts other tools. It does not include them. Install these tools before you open ShipWarden:

| Tool | Why ShipWarden needs it | How to get it |
|---|---|---|
| A Mac with Apple silicon | The app is for arm64 only. | — |
| `git` | ShipWarden makes worktrees and branches with git. | Run `git --version`. If git is missing, macOS can ask you to install the Command Line Tools. |
| GitHub CLI (`gh`) | The GitHub code review provider can get your token from it. You do not need it if you save a token in step 4, or if you use only Azure DevOps. | Install it from [cli.github.com](https://cli.github.com). Then run `gh auth login`. |
| An agent | ShipWarden starts the agent in each worktree. | Claude Code (`claude`) is the default. Codex (`codex`), Gemini CLI (`gemini`) and opencode (`opencode`) also work. |

ShipWarden does not ask for an API key. Each agent uses its own sign-in. Before you use an agent in ShipWarden, start
it one time in a normal terminal. Sign in to the agent there.

ShipWarden finds the tools through the `PATH` of your login shell. To check a tool, run this command in a terminal:
`zsh -lic 'command -v claude'`. The command must show a path.

ShipWarden reads the `PATH` one time, when it starts. If you install a tool while ShipWarden is open, quit
ShipWarden and open it again.

## 2. Install the app

1. Download the DMG from the [ShipWarden releases page](https://github.com/austinChappell/shipwarden/releases).
2. Open the DMG.
3. Drag **ShipWarden** to **Applications**.
4. Open ShipWarden from **Applications**. macOS tells you that the app is from the internet. Click **Open**.

macOS can ask for these permissions:

- **Notifications.** ShipWarden tells you when an agent needs input or is done. Allow this.
- **Keychain access.** ShipWarden encrypts saved tokens with a key in the keychain. To show your Claude plan usage, it
  also reads the "Claude Code-credentials" keychain item. The request can show the name "security", not ShipWarden.
  Click **Always Allow**. If you click **Allow**, macOS can ask again many times. If you deny it, ShipWarden cannot show
  the Claude plan usage.

## 3. Add a repository

ShipWarden works with a local clone of your repository. If you have no clone, run `git clone <url>` first.

1. In the sidebar, click **Add a repository**. You can also click the folder icon next to the project name.
2. Select the folder of the clone.
3. Click **Add**.

If the folder is not a git repository, ShipWarden shows the error "The folder "…" is not in a git repository."

The repository now shows in the sidebar. The **Tasks** item also shows in the sidebar after you add the first
repository.

## 4. Add a code review provider

The Dashboard, the Review view, the Pipelines view and the pull request panel get their data from a code review
provider. A new install has no provider. With no provider, the Dashboard shows zeros and "Nothing waits on you".
This also occurs when you have open pull requests.

1. Open **Settings** (⌘,).
2. Select **Code review**.
3. In **Add a provider…**, select **GitHub** (or **Azure DevOps**).
4. Click **Add**.
5. For Azure DevOps, type the name of your organization.
6. Click **Test**. The message "The token works" shows the account of the token.

ShipWarden uses the first GitHub token that it finds. It tries these sources in this order:

1. A token that you save in the **Personal access token** field.
2. The `GITHUB_TOKEN` environment variable. ShipWarden sees this variable only when you start the app from a terminal
   that has it. When you open ShipWarden from Finder or the Dock, ShipWarden does not see it.
3. The GitHub CLI (`gh auth token`).

If you ran `gh auth login`, you do not have to save a token. If you make a token, give it the scopes `repo`,
`read:org` and `workflow`.

Use **Organizations** to select the pull requests that show. The default is "All organizations, also new ones".
Select "Only these organizations:" to show fewer.

For Azure DevOps, ShipWarden uses a saved personal access token or `az login`.

## 5. Start your first agent

1. Press ⌘N. ShipWarden uses the repository of the selected worktree. If no worktree is selected, it uses the first
   repository. To select a different repository, use the **+** icon that shows when you put the pointer on the
   repository row. You can also use **File › New Worktree…**.
2. Select **New branch**. Type a branch name, for example `login-page-rework`.
3. Keep the default values of **Name** and **Start from**.
4. Make sure that **Start an agent in the new worktree** is selected.
5. Click **Create worktree** (or press ⌘↩).

ShipWarden makes the worktree in `~/.shipwarden/worktrees` and starts the default agent in a terminal tab. The agent
can first ask if you trust the folder. Answer yes. Then type the task for the agent in the terminal.

If nothing occurs when you press ⌘N, the project has no repository. Do [step 3](#3-add-a-repository).

To open more tabs in a worktree, click **+** at the end of the tabs. Select an agent (for example **Claude Code**),
**Shell** or **Browser**.

The agents continue to run when you quit ShipWarden with ⌘Q. To stop them, see [Quit and update](#quit-and-update).

## 6. Make a pull request

1. Push the branch of the worktree. Use one of these methods:
   - Tell the agent to commit and push its work.
   - Open the right panel (⌘E). On the **Changes** tab, commit the changes. Then click **Push**.
2. Open the **Pull request** tab of the right panel.
3. Click **Create pull request**.

Read the comments, the reviews and the checks of the pull request in the right panel or in the Review view (⌥⌘4).

You can send these items to the agent:

- **Send this to the agent** sends a comment or a review to the agent.
- **Send to agent** on the banner of a merge conflict or a failed check gives the problem to the agent.
- **Send the log to the agent** sends the log of a failed job.
- In the editor, click the margin to the left of a line number, or press ⇧⌘A. Then you can ask the agent about the
  line, or send a note to an agent.

In a comment box, type `@` to tag a user. Type `#` to link an issue or a pull request. Click **Add a reaction** to
add a reaction to a comment.

In the Review view, you can **Approve**, **Request changes** or **Comment**. When the pull request is ready, click
**Merge pull request**, **Squash and merge** or **Rebase and merge**.

# Reference

## Views and keys

Use the sidebar or the **Go** menu to open a view.

| View | Key | What it shows |
|---|---|---|
| Dashboard | ⌥⌘1 | Your pull requests, the reviews that wait on you, and new comments |
| Agents | ⌥⌘2 | All running agents of all projects, with their state, pull request and CI |
| Tasks | ⌥⌘3 | The tasks of your task managers |
| Review | ⌥⌘4 | The pull requests of your repositories |
| Pipelines | ⌥⌘5 | The workflows, runs and job logs of your repositories |
| Notes | ⌥⌘6 | Your notes, in `~/.shipwarden/notes` |
| Automations | ⌥⌘7 | Rules that do an action when an event occurs. See [automations.md](automations.md). |
| Settings | ⌘, | All settings, and one page for each repository |

Click a worktree in the sidebar to open it. Use these keys in a worktree:

| Key | Action |
|---|---|
| ⌘E | Show or hide the right panel: files, changes, pull request, checks, pipelines, processes and ports |
| ⌘T | Open a new shell tab |
| ⌘D / ⇧⌘D | Split the pane to the right / down |
| ⌘W | Close the pane |
| ⌘B | Show or hide the sidebar |
| ⌘[ / ⌘] | Open the previous / next page |

## Optional setup

### Task managers

ShipWarden can show the tasks of a task manager. ShipWarden includes five task managers: GitHub Issues, Linear,
ClickUp, Azure Boards and Local tasks.

1. Open **Settings › Task managers**.
2. In **Add a task manager…**, select a task manager.
3. Click **Add**.
4. Type the credentials that the task manager needs:
   - **ClickUp:** an API token.
   - **Linear:** an API key.
   - **Azure Boards:** the organization and a personal access token.
   - **GitHub Issues:** no credentials. It uses the GitHub CLI. You can save a token for a second GitHub account.
   - **Local tasks:** no credentials.
5. Click **Save settings**.

In the Tasks view (⌥⌘3), click **Start in worktree** on a task. ShipWarden makes a branch for the task and gives
the task to a new agent.

### Language servers

The editor has go to definition, find references and diagnostics. TypeScript works with no setup. For Rust, Python
and Go, the editor offers to install the language server. ShipWarden asks you before each download. For Go, Go must
be installed.

### Notifications

Use **Settings › Notifications** to select when ShipWarden tells you about an agent. If no notification shows,
allow notifications for ShipWarden in **System Settings › Notifications**.

### The iPhone app

Open **Settings › Mobile** to connect the iPhone app. See [ios/README.md](../ios/README.md).

## Quit and update

- **ShipWarden › Quit ShipWarden (Keep Agents Running)** (⌘Q) quits the app. The agents continue their work. When
  you open ShipWarden again, the agents are still there.
- **ShipWarden › Quit and Stop All Agents…** (⇧⌥⌘Q) stops all agents and quits the app.

ShipWarden checks for updates a few seconds after it starts, and then every 4 hours. When an update is ready, click
**Update and restart**. The agents continue to run during the update. To check for an update now, use
**ShipWarden › Check for Updates…** (⇧⌘U) or **Settings › About**.

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| macOS does not open ShipWarden because it cannot check the app. | This can occur with a build that is not notarized. Open **System Settings › Privacy & Security** and click **Open Anyway**. |
| The Dashboard shows zeros. | You have no code review provider, or the provider is off. Do [step 4](#4-add-a-code-review-provider). |
| The pull request panel says that the worktree has no GitHub or Azure Repos remote named "origin". | This message also shows when you have no code review provider, or when the provider is off. Open **Settings › Code review** first. Then make sure that the repository has an `origin` remote. |
| "ShipWarden cannot get a GitHub token." | Run `gh auth login`, or save a token in **Settings › Code review**. If you installed `gh` while ShipWarden was open, quit ShipWarden and open it again. |
| "GitHub has no release of ShipWarden, or the repository is private." | The update check uses the token of your GitHub code review provider. Do [step 4](#4-add-a-code-review-provider). |
| Nothing occurs when you press ⌘N. | The project has no repository. Do [step 3](#3-add-a-repository). |
| The agent terminal shows "command not found". | Install the agent. Make sure that it is in the `PATH` of your login shell. Then quit ShipWarden and open it again. |
| No notifications show. | Allow notifications for ShipWarden in **System Settings › Notifications**. |

## Where ShipWarden keeps its data

| Folder | Contents |
|---|---|
| `~/Library/Application Support/ShipWarden/` | Projects, settings, providers, task managers, saved tokens (encrypted), and the terminal host log `pty-host.log` |
| `~/.shipwarden/worktrees` | The worktrees. You can change this folder in **Settings › Worktrees**. |
| `~/.shipwarden/automations` | The automations |
| `~/.shipwarden/notes` | Your notes |
| `~/.shipwarden/tasks` | The tasks of Local tasks |
| `~/.shipwarden/ci-logs` and `~/.shipwarden/review` | Job logs and review data that ShipWarden keeps |
| `~/.shipwarden/plugins` | Task manager plugins that you add |

**Settings › About** shows the data folder and the path of the terminal host log.
