import type { OnboardingSettings } from './onboarding';

/** A view that a tip can open. */
export type TipView = 'dashboard' | 'agents' | 'tasks' | 'review' | 'pipelines' | 'notes' | 'automations' | 'plans' | 'queue' | 'stats';

/**
 * The button of a tip: it opens a view, a settings section, the New worktree dialog, the keyboard shortcuts, or the
 * command palette.
 */
export type TipAction =
    | { kind: 'view'; view: TipView; label: string }
    | { kind: 'settings'; section: string; label: string }
    | { kind: 'newWorktree'; label: string }
    | { kind: 'shortcuts'; label: string }
    | { kind: 'commandPalette'; label: string };

export interface Tip {
    id: string;
    title: string;
    body: string;
    action?: TipAction;
}

/** The tips of the corner notice. The notice shows one tip at random (see `pickTip`). */
export const NOTICE_TIPS: readonly Tip[] = [
    {
        id: 'snoozePullRequest',
        title: 'Snooze a pull request',
        body: 'Click the snooze button of a pull request in the Dashboard or in Review, or press S on the pull request list. It leaves "Needs me" until the time ends, or until a new commit, comment, or review.',
        action: { kind: 'view', view: 'review', label: 'Open Review' }
    },
    {
        id: 'sessionTags',
        title: 'Tag your agent sessions',
        body: 'In the Agents view, open the menu of a session and click "Add tag…". Click a tag above the lists to show only its sessions. ShipWarden keeps a copy of each pinned transcript, so Resume works also after Claude Code deletes it.',
        action: { kind: 'view', view: 'agents', label: 'Open Agents' }
    },
    {
        id: 'stopSelected',
        title: 'Stop many agents in one step',
        body: 'In the Agents view, select the checkbox of each agent, or of a project. Shift-click selects a range. Then click "Stop selected" in the bar at the bottom.',
        action: { kind: 'view', view: 'agents', label: 'Open Agents' }
    },
    {
        id: 'findText',
        title: 'Find text in a terminal',
        body: 'Press ⌘F in a terminal, a browser tab, the chat, or a Markdown preview. In a terminal, Enter goes to the next older match in the scrollback.'
    },
    {
        id: 'agentModel',
        title: 'Choose the model of each agent',
        body: 'In Settings › Agents, select a model for Claude Code or Codex. ShipWarden gets the list of models from the agent. Each new session then starts with that model.',
        action: { kind: 'settings', section: 'agents', label: 'Open Settings › Agents' }
    },
    {
        id: 'agentChat',
        title: 'Show an agent as a chat',
        body: 'Turn on "Show agent tabs as a chat" in Settings › Agents. Claude Code and Codex tabs then show as a chat. Type the next prompt while the agent works, and it waits in a queue. "Send now" sends it at once.',
        action: { kind: 'settings', section: 'agents', label: 'Open Settings › Agents' }
    },
    {
        id: 'scratchRun',
        title: 'Run a scratch file',
        body: 'Open a file in the Scratch Pad and click Run, or press ⌃R. ShipWarden uses the shebang or the file extension, or a command that you set, for example "psql -f {file}". "Ask an agent about the file" starts an agent on it.',
        action: { kind: 'view', view: 'notes', label: 'Open Scratch Pad' }
    },
    {
        id: 'rebaseWithAgent',
        title: 'Change the base or the title of a pull request',
        body: 'Click the title of a pull request to change it. Use the base branch menu to change the base. "Rebase with agent" in the header menu tells the agent to rebase, run the tests, and push.',
        action: { kind: 'view', view: 'review', label: 'Open Review' }
    },
    {
        id: 'promptAgents',
        title: 'Send one prompt to many agents',
        body: 'On a plan or a PR group, use "Prompt the agents" to send one prompt to the agent of each selected pull request. "Commit and push" is on by default.',
        action: { kind: 'view', view: 'plans', label: 'Open Plans' }
    },
    {
        id: 'pipelineApprovals',
        title: 'Approve a deployment from the Dashboard',
        body: 'Runs that wait for your approval show in "Waiting on your approval" on the Dashboard and in Pipelines. Click Approve, or snooze all runs of the pipeline.',
        action: { kind: 'view', view: 'dashboard', label: 'Open Dashboard' }
    },
    {
        id: 'jobGraph',
        title: 'See the job graph of a run',
        body: 'In Pipelines or in the Checks tab, click Graph to see the jobs of a GitHub Actions run and the jobs that each one needs. Click a job to open its log.',
        action: { kind: 'view', view: 'pipelines', label: 'Open Pipelines' }
    },
    {
        id: 'plainFolder',
        title: 'Add a folder without git',
        body: 'Click the folder icon next to the project name and select any folder. ShipWarden shows it with terminals, agents, files, and the editor, but with no worktrees or branches.'
    },
    {
        id: 'closeTabs',
        title: 'Close many tabs at once',
        body: 'Right-click a tab and select "Close other tabs", "Close tabs to the left", "Close tabs to the right", or "Close all tabs".'
    },
    {
        id: 'pinSession',
        title: 'Pin an agent session',
        body: 'Right-click an agent tab and select "Pin session". The Agents view lists it under "Pinned sessions", and Resume continues it in any worktree.',
        action: { kind: 'view', view: 'agents', label: 'Open Agents' }
    },
    {
        id: 'documentAttachments',
        title: 'Attach documents in the chat',
        body: 'Drop a PDF, Word, or Excel file on the chat view, or click the paperclip in the chat field. ShipWarden converts the file to text on your Mac, and the agent reads the text file.'
    },
    {
        id: 'dictation',
        title: 'Dictate a prompt',
        body: 'Click the microphone in the chat field or on an agent terminal, or press ⌥⌘L. ShipWarden uses the speech recognition of macOS on your Mac, so no audio leaves the Mac. Press ⌥⌘L again to insert the text.',
        action: { kind: 'settings', section: 'keyboard', label: 'Change the key' }
    },
    {
        id: 'keybindings',
        title: 'Change the keyboard shortcuts',
        body: 'Open Settings › Keyboard, click "Record" next to a command, and press the new keys. ShipWarden keeps your keys in ~/.shipwarden/keybindings.json, so you can also change the file.',
        action: { kind: 'settings', section: 'keyboard', label: 'Open Settings › Keyboard' }
    },
    {
        id: 'giteaProvider',
        title: 'Review Gitea and Forgejo pull requests',
        body: 'Add a "Gitea or Forgejo" provider in Settings › Code review. ShipWarden finds the server in the remotes of your projects. Pull requests, reviews, threads, and Gitea Actions runs then show in ShipWarden.',
        action: { kind: 'settings', section: 'review', label: 'Open Settings › Code review' }
    },
    {
        id: 'codexHooks',
        title: 'See the state of Codex agents',
        body: 'Start Codex in ShipWarden, type /hooks, and trust the ShipWarden hooks under "Session flags". The Agents view then shows when Codex needs input, and how many tokens it used.',
        action: { kind: 'view', view: 'agents', label: 'Open Agents' }
    },
    {
        id: 'openInEditor',
        title: 'Open a worktree in your editor',
        body: 'Right-click a worktree and click "Open in" with the name of your editor, or press ⌥⌘O. A file tab opens the file at its cursor line. ShipWarden finds VS Code, Cursor, Windsurf, Zed, and the JetBrains IDEs.',
        action: { kind: 'settings', section: 'appearance', label: 'Select the editor' }
    },
    {
        id: 'branchesPage',
        title: 'Clean up old branches',
        body: 'Click the branch icon of a repository in the sidebar. The Branches page checks out, deletes, and fetches branches. Select the filter "Remote deleted" or "Older than 7d", then click "Delete" to delete the local branches in the list. The remote branches stay.'
    },
    {
        id: 'bitbucketProvider',
        title: 'Review Bitbucket pull requests',
        body: 'Add a Bitbucket provider for Bitbucket Cloud. Pull requests, threads, approvals, and pipeline steps then show in ShipWarden, as GitHub pull requests do.',
        action: { kind: 'settings', section: 'review', label: 'Open Settings › Code review' }
    },
    {
        id: 'gitlabProvider',
        title: 'Review GitLab merge requests',
        body: 'Add a GitLab provider for gitlab.com or for your own server. Merge requests, threads, approvals, and pipeline jobs then show in ShipWarden, as GitHub pull requests do.',
        action: { kind: 'settings', section: 'review', label: 'Open Settings › Code review' }
    },
    {
        id: 'screenshots',
        title: 'Show the visual result of a pull request',
        body: 'Add a preview URL and pages in the settings of a repository. The Screenshots tab of a worktree then captures each page for the branch and for the base, shows them side by side, and adds them to the pull request in one comment.'
    },
    {
        id: 'stackedPlans',
        title: 'Merge a stack of plan pull requests',
        body: 'With "Stack the steps" on, each pull request of a plan targets the branch of the step before it in the same repository. When one merges, ShipWarden rebases the next branch and changes its base. This works after a squash merge too.'
    },
    {
        id: 'stackActions',
        title: 'Rebase or merge a whole stack',
        body: 'The PR group of a stacked plan has "Rebase stack" and "Merge stack". Rebase stack rebases each branch onto its parent and pushes it. Merge stack merges the ready pull requests from the bottom up. Both stop at the first problem.',
        action: { kind: 'view', view: 'review', label: 'Open Review' }
    },
    {
        id: 'automations',
        title: 'Let automations do the routine work',
        body: 'An automation is a rule of the form "when this occurs, do that". For example, when CI fails, it sends the log to the agent of the worktree. Start from a template.',
        action: { kind: 'view', view: 'automations', label: 'Open Automations' }
    },
    {
        id: 'needsInputAutomation',
        title: 'Get a Slack message when an agent waits',
        body: 'The automation trigger "Agent needs input" runs when an agent waits for a permission or asks a question. Set a wait time, and it runs only when nobody answers in time. Start from the template "Tell Slack when an agent waits".',
        action: { kind: 'view', view: 'automations', label: 'Open Automations' }
    },
    {
        id: 'usageBudget',
        title: 'Stop new agents before the plan usage runs out',
        body: 'Set a usage budget in Settings › Agents, for example 80%. Above it, the queue, plans, and automations wait for the usage to reset. Agents that work now continue.',
        action: { kind: 'settings', section: 'agents', label: 'Open Settings › Agents' }
    },
    {
        id: 'promptTemplates',
        title: 'Save the prompts that you type often',
        body: 'A prompt template is a saved prompt with variables, for example "Write tests for {{file}}". Insert it from the Prompts list of an agent terminal, from the command palette, or with its own shortcut.',
        action: { kind: 'settings', section: 'prompts', label: 'Open Settings › Prompt templates' }
    },
    {
        id: 'mcpServer',
        title: 'Let agents ask other agents',
        body: 'Each new agent gets the ShipWarden MCP tools. It can list the worktrees, find files that other worktrees also change, read and move its task, and ask the agent of another worktree. Turn it off in Settings › Agents.',
        action: { kind: 'settings', section: 'agents', label: 'Open Settings › Agents' }
    },
    {
        id: 'mcpPullRequests',
        title: 'Let agents fix their own pull requests',
        body: 'Tell an agent to call watch_pull_request after it pushes. ShipWarden then sends it a message when a check fails, a merge conflict occurs, or a reviewer comments. The agent can read the checks, reply to comments, and change the pull request with the ShipWarden tools.'
    },
    {
        id: 'mcpWorkers',
        title: 'Let one agent split a large task',
        body: 'Tell an agent to split a task and start workers with start_worker. Each worker gets its own worktree and opens its own pull request. ShipWarden sends each result back to the agent. The Plans view lists the workers.',
        action: { kind: 'view', view: 'plans', label: 'Open Plans' }
    },
    {
        id: 'mcpBrowser',
        title: 'Let agents test in the browser',
        body: 'An agent can open a page in the browser tab of its worktree, read it, click, type, and take a screenshot. You see the same tab. For example, tell the agent: "Open localhost:3000 and check the sign-up form."'
    },
    {
        id: 'cliCommand',
        title: 'Control ShipWarden from a terminal',
        body: 'Install the shipwarden command in Settings › Agents. It also adds the short name "sw". Scripts and agents can then create worktrees, start agents, send prompts, wait for a turn, move tasks, and run automations. Run "shipwarden skill install" to teach Claude Code the command.',
        action: { kind: 'settings', section: 'agents', label: 'Open Settings › Agents' }
    },
    {
        id: 'automationsWhenClosed',
        title: 'Run automations while ShipWarden is closed',
        body: 'Turn on "Run while ShipWarden is closed" in Automations, and turn on the background helper in Settings › Mobile. The helper then runs the schedules, the CI failures, and the task queue overnight. Approve the waiting runs on your iPhone.',
        action: { kind: 'view', view: 'automations', label: 'Open Automations' }
    },
    {
        id: 'phoneStartAgents',
        title: 'Start agents from your iPhone',
        body: 'Turn on "Start agents" for your phone in Settings › Mobile. Then tap + in the Agents tab of the iPhone app to start an agent on a task or a prompt in a new worktree.',
        action: { kind: 'settings', section: 'mobile', label: 'Open Settings › Mobile' }
    },
    {
        id: 'slackAgents',
        title: 'Answer your agents in Slack',
        body: 'Create a Slack app from the manifest in docs/slack.md and add its tokens in Settings › Slack. Add your Slack ID to "People who can start and answer agents". Questions of the agents then go to a channel, and a reply in the thread goes to the agent.',
        action: { kind: 'settings', section: 'slack', label: 'Open Settings › Slack' }
    },
    {
        id: 'phonePush',
        title: 'Get a notification on your phone',
        body: 'Deploy the push relay (relay/README.md), then turn on "Send push notifications" in Settings › Mobile and type the relay address. Your phone then tells you when an agent needs input, also when the app on the phone is closed.',
        action: { kind: 'settings', section: 'mobile', label: 'Open Settings › Mobile' }
    },
    {
        id: 'checkpoints',
        title: 'Undo one bad agent turn',
        body: 'ShipWarden saves the files of the worktree when an agent gets a prompt. Open the Checkpoints tab in the right panel of a worktree, and select "Rewind" on a turn. The diff shows first.'
    },
    {
        id: 'agentStats',
        title: 'See which agent merges the most work',
        body: 'The Stats view shows the merged pull requests, the tokens, the time to merge, the time in "needs input", and the CI failures of each agent and model. It uses local data only.',
        action: { kind: 'view', view: 'stats', label: 'Open Stats' }
    },
    {
        id: 'taskQueue',
        title: 'Run a backlog overnight',
        body: 'Click "Add to queue" on a task. The Queue view starts the tasks one after the other and keeps a limit, for example 3 agents at the same time. When an agent finishes, the next task starts.',
        action: { kind: 'view', view: 'queue', label: 'Open Queue' }
    },
    {
        id: 'sendThread',
        title: 'Send a review comment to an agent',
        body: 'Each review thread on a pull request has a "Send to agent" link. The agent of the worktree gets the comment and can fix the code.'
    },
    {
        id: 'remoteBranch',
        title: 'Create a worktree from a remote branch',
        body: 'In the New worktree dialog (⌘N), choose "Remote branch". The new local branch tracks the remote branch.',
        action: { kind: 'newWorktree', label: 'New worktree' }
    },
    {
        id: 'pullRequestWorktree',
        title: 'Create a worktree from a pull request',
        body: 'Open a pull request in Review and click "New worktree" in its header, or press ⌘O. On the pull request list of a repository, press C.',
        action: { kind: 'view', view: 'review', label: 'Open Review' }
    },
    {
        id: 'agentReview',
        title: 'Let an agent review a pull request first',
        body: 'On the review card, click "Run agent review". Its menu sets how strict the review is. You accept or remove each comment of the agent. Nothing goes to the pull request until you submit the review.',
        action: { kind: 'view', view: 'review', label: 'Open Review' }
    },
    {
        id: 'failedCheck',
        title: 'Send a failed check to the agent',
        body: 'When CI fails, the pull request shows a "Send to agent" button. The Checks tab can also send the log of one check to the agent.'
    },
    {
        id: 'askAboutLines',
        title: 'Ask an agent about lines of code',
        body: 'Select lines in the editor and press ⇧⌘A to ask the agent about them. In a diff, press ⇧⌘M to comment on the lines, ask the agent, or send a note to it.'
    },
    {
        id: 'reviewKeys',
        title: 'Review with the keyboard',
        body: 'On the pull request list of a repository, J and K move and Enter opens. C makes a worktree from the pull request. A starts an agent review. S snoozes the pull request.',
        action: { kind: 'view', view: 'review', label: 'Open Review' }
    },
    {
        id: 'startTask',
        title: 'Start a task in a worktree',
        body: 'In Tasks, click "Start in worktree". ShipWarden creates a worktree for the task and starts an agent on it.',
        action: { kind: 'view', view: 'tasks', label: 'Open Tasks' }
    },
    {
        id: 'splits',
        title: 'Split the workspace',
        body: 'Press ⌘D to split right and ⇧⌘D to split down. Press ⌥⌘ and an arrow key to go to the next split. ⌘W closes a split.'
    },
    {
        id: 'viewKeys',
        title: 'Open each view with the keyboard',
        body: '⌥⌘1 to ⌥⌘7 open Dashboard, Agents, Tasks, Review, Pipelines, Scratch Pad, and Automations. ⌘[ and ⌘] go back and forward. Open Plans, Queue, and Stats from the sidebar or the command palette.',
        action: { kind: 'shortcuts', label: 'Keyboard shortcuts' }
    },
    {
        id: 'commandPalette',
        title: 'Do it from the command palette',
        body: 'Press ⇧⌘P and type. Create, open, or remove a worktree, open a pull request, a plan, or a Scratch Pad file, change the theme, and more.',
        action: { kind: 'commandPalette', label: 'Open the command palette' }
    },
    {
        id: 'newWindow',
        title: 'Open a second window',
        body: 'Press ⇧⌘N to open a new ShipWarden window. Look at another view in it, and your first window stays as it is.'
    },
    {
        id: 'quit',
        title: 'Agents continue to run after ⌘Q',
        body: '⌘Q closes the application, and your agents continue their work. Press ⇧⌥⌘Q to quit and stop all agents.'
    },
    {
        id: 'worktreeMenu',
        title: 'Rename, hide, or snooze a worktree',
        body: 'Right-click a worktree in the sidebar. Snooze hides it for 1 hour, for 4 hours, until tomorrow, or until next week. Then it shows again.'
    },
    {
        id: 'browserTab',
        title: 'Open a browser next to the agent',
        body: 'The + button of the tab strip opens an agent, a shell, or a browser tab. Split the browser next to the agent to see your app while the agent works.'
    },
    {
        id: 'elementPicker',
        title: 'Send a page element to the agent',
        body: 'In a browser tab, click the "Pick element" button, then click an element of the page. The agent gets its HTML, its styles, a selector, and a screenshot. Add a note such as "Make this button smaller."'
    },
    {
        id: 'ports',
        title: 'Open the port of a dev server',
        body: 'A worktree with a running server shows its port in the sidebar. Click the port to open it in your browser. ⇧⌘-click opens it in ShipWarden.'
    },
    {
        id: 'scripts',
        title: 'Run the scripts of a repository',
        body: 'The ▷ button in the tab strip lists the scripts of the repository. Click "Add script…" to add your own commands.'
    },
    {
        id: 'repoSettings',
        title: 'Set up each repository',
        body: 'Click the settings button of a repository in the sidebar. Give it a color, a default agent, and a setup script that runs in each new worktree.'
    },
    {
        id: 'notifications',
        title: 'Choose your notifications',
        body: 'Each event has its own switch and sound: an agent needs input, an agent finished, CI finished, new Dashboard items, and automations.',
        action: { kind: 'settings', section: 'notifications', label: 'Open Notifications' }
    },
    {
        id: 'usage',
        title: 'See the usage of your plan',
        body: 'The status bar shows how much of your Claude or Codex plan you used. Move the pointer over it to see the limits and when they reset.'
    },
    {
        id: 'recentSessions',
        title: 'Resume a session that you closed',
        body: 'The Agents view lists the Claude Code sessions of the last 3 days under "Recent sessions". Click "Resume" to continue one, also without a pin. An unpinned session stays under "Recently unpinned" for 3 days.',
        action: { kind: 'view', view: 'agents', label: 'Open Agents' }
    },
    {
        id: 'transcriptSearch',
        title: 'Search all your agent sessions',
        body: 'Type in "Search transcripts" in the Agents view to find the Claude Code sessions that mention a file or a word, for example "auth.ts". Filter by repository, model, and date.',
        action: { kind: 'view', view: 'agents', label: 'Open Agents' }
    },
    {
        id: 'idleReason',
        title: 'See why an agent is idle',
        body: 'In the Agents view, move the pointer over the state of an agent. The tooltip tells why it does not work, for example "Waiting for a permission prompt" or "Waiting for CI".',
        action: { kind: 'view', view: 'agents', label: 'Open Agents' }
    },
    {
        id: 'rebase',
        title: 'Rebase a worktree in ShipWarden',
        body: 'Right-click a worktree and select "Rebase onto Default Branch…". When a commit has a conflict, the Changes tab shows the files with Continue, Skip, Abort, and "Send to agent".'
    },
    {
        id: 'phone',
        title: 'See your agents on your phone',
        body: 'Pair the ShipWarden iPhone app in Settings › Mobile. Then you can see your agents when you are away from your Mac.',
        action: { kind: 'settings', section: 'mobile', label: 'Open Settings › Mobile' }
    }
];

/** The content of a tip in a view. */
export type InlineTip = Omit<Tip, 'id'>;

/** The tips in the views. Each one is about a feature of its view. */
export const INLINE_TIPS = {
    dashboard: {
        title: 'Keep the Dashboard short',
        body: 'Click ✓ on a comment to mark it as seen. The filter button hides comments like it with a rule. The eye button hides all comments from an author, for example a bot.',
        action: { kind: 'settings', section: 'dashboard', label: 'Hiding rules' }
    },
    review: {
        title: 'Hand a pull request to an agent',
        body: 'On the pull request list of a repository, press A to start an agent review, or C to make a worktree from the pull request.'
    },
    tasks: {
        title: 'Start a task in a worktree',
        body: 'Open a task and click "Start in worktree". ShipWarden creates a worktree for the task and starts an agent on it.'
    },
    agents: {
        title: 'Find the agents that wait for you',
        body: '"Needs input" means that the agent waits for you. Click the agent to open its tab and answer it.'
    },
    automations: {
        title: 'Start from a template',
        body: 'Click "New automation" and choose a template, for example "Fix failed CI". Choose "Ask first" to approve each run before it starts.'
    }
} satisfies Record<string, InlineTip>;

export type InlineTipId = keyof typeof INLINE_TIPS;

/** The time from the close of a tip notice to the next tip notice, while the app stays open. */
export const TIP_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** The number of tips that the notice remembers. A tip does not show again within 10 notices. */
export const RECENT_TIP_COUNT = 9;

/** Returns true when the tips are on. A missing onboarding state counts as on. */
export function tipsOn(onboarding: OnboardingSettings | undefined): boolean {
    return !onboarding?.tipsOff;
}

/**
 * Returns true when the corner notice can show a tip. It shows one time at each start of the app (`appStart`). While the
 * app stays open, it shows again 12 hours after the user closed the last tip. It does not show to a new user before the
 * welcome page is done, or when the tips are off.
 */
export function shouldShowTipNotice(onboarding: OnboardingSettings | undefined, appStart: boolean, now: number): boolean {
    if (!onboarding || onboarding.welcome === 'new' || !tipsOn(onboarding)) return false;
    if (appStart) return true;
    return onboarding.tipClosedAt !== undefined && now - onboarding.tipClosedAt >= TIP_INTERVAL_MS;
}

/** Returns true when an inline tip shows: the tips are on and the user did not close it. */
export function inlineTipShows(onboarding: OnboardingSettings | undefined, id: InlineTipId): boolean {
    return tipsOn(onboarding) && !onboarding?.tipsClosed?.includes(id);
}

/** Returns the list of closed inline tips with one more tip. */
export function closeInlineTip(closed: readonly string[] | undefined, id: InlineTipId): string[] {
    return closed?.includes(id) ? [...closed] : [...(closed ?? []), id];
}

/**
 * Returns the index of a random tip that is not in `recent`. `random` gives a number from 0 to 1 (not 1), as
 * `Math.random` does.
 */
export function pickTip(recent: readonly string[] | undefined, random: () => number = Math.random, tips: readonly Tip[] = NOTICE_TIPS): number {
    const skip = new Set(recent?.slice(-RECENT_TIP_COUNT));
    const candidates = tips.map((_, index) => index).filter(index => !skip.has(tips[index].id));
    const pool = candidates.length > 0 ? candidates : tips.map((_, index) => index);
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

/** Returns the recent tips with one more tip. It keeps the newest `RECENT_TIP_COUNT` IDs. */
export function rememberTip(recent: readonly string[] | undefined, id: string): string[] {
    return [...(recent ?? []).filter(item => item !== id), id].slice(-RECENT_TIP_COUNT);
}
