# Get started with ShipWarden

This guide tells you how to install ShipWarden and start your first agent. Do steps 1 to 6 in this order. The
[Reference](#reference) part after them is for later.

These words have a special meaning in this guide:

| Word | Meaning |
|---|---|
| Agent | A coding agent CLI, for example Claude Code, that runs in a terminal tab of ShipWarden. |
| Worktree | An additional working folder of a repository. Each worktree has its own branch. Each agent works in its own worktree, so the agents do not change the files of a different agent. |
| Project | A group of repositories in the sidebar. ShipWarden makes the project "Default" for you. |
| Code review provider | Your GitHub, Azure DevOps, GitLab, Bitbucket, Gitea, or Forgejo account in ShipWarden. ShipWarden gets the pull requests and the checks from it. |

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

ShipWarden works with a local clone of your repository.

1. In the sidebar, click **Add a repository**. You can also click the folder icon next to the project name ("Add a
   repository or a folder to this project").
2. Select the folder of the clone.
3. Click **Add**.

If you have no clone, click **Clone a repository** (or the clone icon next to the project name). Type the repository,
for example `owner/name`. ShipWarden clones it into your code folder and adds it to the project. Set the code folder
in **Settings › Worktrees › Clones**.

You can also add a folder that is not a git repository. ShipWarden shows it as one worktree with terminals, agents,
files, and the editor. It has no worktrees, branches, pull requests, or checks.

The repository now shows in the sidebar. The **Tasks** item also shows in the sidebar after you add the first
repository.

## 4. Add a code review provider

The Dashboard, the Review view, the Pipelines view and the pull request panel get their data from a code review
provider. A new install has no provider. With no provider, the Dashboard shows zeros and "Nothing waits on you".
This also occurs when you have open pull requests.

1. Open **Settings** (⌘,).
2. Select **Code review**.
3. In **Add a provider…**, select **GitHub** (or **Azure DevOps**, **GitLab**, **Bitbucket**, or **Gitea or Forgejo**).
4. Click **Add**.
5. For Azure DevOps, type the name of your organization. For a self-hosted GitLab server, type its URL in
   **Server URL**, for example `https://git.example.com`. For Bitbucket with an Atlassian API token, type the email of
   your Atlassian account in **Email or username**. For Gitea or Forgejo, make sure that **Server URL** shows your
   server, for example `https://codeberg.org`.
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

For GitLab, ShipWarden uses the first token that it finds:

1. A token that you save in the **Personal access token** field. Give it the `api` scope.
2. The `GITLAB_TOKEN` environment variable, only for gitlab.com.
3. The glab CLI login of the server (`glab auth login --hostname <server>`).

A GitLab provider reads only the remotes of its server. Add one provider for each server. Use **Groups** to show only
the projects of some groups, for example `acme` or `acme/platform`. Subgroups are included. ShipWarden uses the CA
certificates of Settings › Network for the server.

For Bitbucket Cloud, ShipWarden uses a token that you save in the **Token** field, else the `BITBUCKET_TOKEN`
environment variable (with `BITBUCKET_USERNAME` for Basic auth). Two kinds of token work:

- An Atlassian API token with scopes for Bitbucket. Type the email of your Atlassian account in **Email or username**.
  An older app password also works with your Bitbucket username.
- A workspace, project, or repository access token. Keep **Email or username** empty. Type the workspace in
  **Workspaces**, because an access token cannot list your workspaces.

Give the token these scopes: account (read), repositories (read and write), pull requests (read and write),
pipelines (read and write), and workspace membership (read). Use **Workspaces** to show only some workspaces, for
example `acme`. Empty means the workspaces of your account (at most 10). Bitbucket Data Center is not supported.

For Gitea and Forgejo, add one provider for each server. When you add the provider, ShipWarden looks at the `origin`
remotes of your projects. It asks each unknown server for `/api/v1/version`, and it puts the first Gitea or Forgejo
server in **Server URL**. If ShipWarden finds no server, type the URL. ShipWarden uses the CA certificates of Settings ›
Network for the server, so a server with a private CA works.

ShipWarden uses a token that you save in the **Personal access token** field, else the `GITEA_TOKEN` environment
variable. Make the token in **Settings › Applications** on the server. Give it these scopes: repository (read and
write), issue (read and write), user (read), and organization (read). Use **Owners** to show only the repositories of
some organizations or users, for example `acme`. Empty means all repositories that you can access.

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
**Shell** or **Browser**. If you have only one agent, the menu shows **Agent**.

To create a worktree from a branch that is on the remote only, select **Remote branch** in the New worktree dialog.
To create a worktree from a pull request, open the pull request in the Review view and click the folder button in its
header.

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
**Merge pull request**, **Squash and merge** or **Rebase and merge**. If you cannot merge yet, click **Enable
auto-merge**. If the base branch uses a GitHub merge queue, click **Merge when ready**.

Click the title of a pull request to change it. Use the base branch menu to change the base branch.

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
| Scratch Pad | ⌥⌘6 | Your notes and scratch files, in `~/.shipwarden/notes`. **Run** (⌃R) runs a file. |
| Automations | ⌥⌘7 | Rules that do an action when an event occurs. See [automations.md](automations.md). |
| Plans | — | Multi-step plans. Each step is an agent and a pull request. See [plans.md](plans.md). |
| Queue | — | The tasks that wait to start, and the limit of agents that run at the same time |
| Stats | — | The merged pull requests, tokens, time to merge, and CI failures of each agent and model |
| Terminal | — | Terminal tabs in your home folder, outside of all repositories |
| Settings | ⌘, | All settings, and one page for each repository |

Press ⇧⌘P to open the command palette. It finds all views and commands. **Help › Keyboard Shortcuts** lists all keys.
To change a key, open **Settings › Keyboard**. See [keybindings.md](keybindings.md).

Click a worktree in the sidebar to open it. Use these keys in a worktree:

| Key | Action |
|---|---|
| ⌘E | Show or hide the right panel: files, changes, pull request, checks, pipelines, processes and ports, checkpoints, and screenshots |
| ⌘T | Open a new shell tab |
| ⌘D / ⇧⌘D | Split the pane to the right / down |
| ⌘W | Close the pane |
| ⌘B | Show or hide the sidebar |
| ⌘[ / ⌘] | Open the previous / next page |
| ⌘F | Find text in a terminal, a browser tab, the chat, or a Markdown preview |
| ⌥⌘O | Open the worktree or the file in your editor |
| ⌥⌘L | Dictate a prompt. See [dictation.md](dictation.md). |

## Optional setup

### Task managers

ShipWarden can show the tasks of a task manager. ShipWarden includes seven task managers: GitHub Issues, Linear,
ClickUp, Jira, Azure Boards, Trello, and Local tasks.

1. Open **Settings › Task managers**.
2. In **Add a task manager…**, select a task manager.
3. Click **Add**.
4. Type the credentials that the task manager needs:
   - **ClickUp:** an API token.
   - **Linear:** an API key.
   - **Jira:** the site URL (for example `https://acme.atlassian.net`), the email of your Atlassian account, and an
     API token. Make the token at id.atlassian.com › Security › API tokens. ShipWarden supports Jira Cloud only.
   - **Trello:** an API key and a token.
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

The iPhone app is in beta. Get it from the [App Store](https://apps.apple.com/us/app/shipwarden/id6832160464), or scan the QR code in **Settings › Mobile**.

## More features

When the first agent works, try these features. Each link tells you more.

- **Agents help each other.** Each agent gets the ShipWarden MCP tools. It can watch its pull request, fix failed
  checks, ask the agent of another worktree, test pages in its browser tab, and start worker agents. See
  [mcp-server.md](mcp-server.md).
- **Plans.** A plan splits a large task into steps. Each step gets its own agent and pull request. See
  [plans.md](plans.md) and [pr-groups.md](pr-groups.md).
- **Automations.** A rule does an action when an event occurs, for example "when CI fails, send the log to the
  agent". See [automations.md](automations.md).
- **Prompt templates.** Save the prompts that you type often. See [prompt-templates.md](prompt-templates.md).
- **Screenshots.** Compare the pages of a branch with the base branch. See [screenshots.md](screenshots.md).
- **Documents and voice.** Attach a PDF, Word, or Excel file in the chat, or dictate a prompt. See
  [document-attachments.md](document-attachments.md) and [dictation.md](dictation.md).
- **The command line.** The `shipwarden` command (short name `sw`) controls ShipWarden from scripts and agents. See
  [cli.md](cli.md).
- **Slack.** Answer your agents and start new agents from a Slack channel. See [slack.md](slack.md).

ShipWarden also shows a tip in the corner of the window at each start. To turn off the tips, click **Turn off tips**
on a tip.

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
| The pull request panel says that the worktree has no GitHub, Azure Repos, GitLab, Bitbucket, Gitea, or Forgejo remote named "origin". | This message also shows when you have no code review provider, or when the provider is off. Open **Settings › Code review** first. Then make sure that the repository has an `origin` remote. |
| "ShipWarden cannot get a GitHub token." | Run `gh auth login`, or save a token in **Settings › Code review**. If you installed `gh` while ShipWarden was open, quit ShipWarden and open it again. |
| "GitHub has no release of ShipWarden, or the repository is private." | The update check uses the token of your GitHub code review provider. Do [step 4](#4-add-a-code-review-provider). |
| Nothing occurs when you press ⌘N. | The project has no repository, or the selected item is a folder without git. Do [step 3](#3-add-a-repository). |
| The agent terminal shows "command not found". | Install the agent. Make sure that it is in the `PATH` of your login shell. Then quit ShipWarden and open it again. |
| No notifications show. | Allow notifications for ShipWarden in **System Settings › Notifications**. |

## Where ShipWarden keeps its data

| Folder | Contents |
|---|---|
| `~/Library/Application Support/ShipWarden/` | Projects, settings, providers, task managers, saved tokens (encrypted), and the terminal host log `pty-host.log` |
| `~/Library/Application Support/ShipWarden/attachments/` | The text files of the documents in the chat view. ShipWarden removes them after 7 days |
| `~/.shipwarden/worktrees` | The worktrees. You can change this folder in **Settings › Worktrees**. |
| `~/.shipwarden/automations` | The automations |
| `~/.shipwarden/notes` | The files of the Scratch Pad |
| `~/.shipwarden/tasks` | The tasks of Local tasks. With "Keep the tasks in the repository", they are in `<repository>/.shipwarden/tasks.json`. |
| `~/.shipwarden/prompts` | Your prompt templates |
| `~/.shipwarden/keybindings.json` | The keys that you changed in **Settings › Keyboard** |
| `~/.shipwarden/ci-logs` and `~/.shipwarden/review` | Job logs and review data that ShipWarden keeps |
| `~/.shipwarden/plugins` | Task manager plugins that you add |

**Settings › About** shows the data folder and the path of the terminal host log.
