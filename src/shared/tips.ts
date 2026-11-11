import type { OnboardingSettings } from './onboarding';

/** A view that a tip can open. */
export type TipView = 'dashboard' | 'agents' | 'tasks' | 'review' | 'pipelines' | 'notes' | 'automations';

/** The button of a tip: it opens a view, a settings section, the New worktree dialog or the keyboard shortcuts. */
export type TipAction =
    | { kind: 'view'; view: TipView; label: string }
    | { kind: 'settings'; section: string; label: string }
    | { kind: 'newWorktree'; label: string }
    | { kind: 'shortcuts'; label: string };

export interface Tip {
    id: string;
    title: string;
    body: string;
    action?: TipAction;
}

/** The tips of the corner notice. The notice shows one tip at random (see `pickTip`). */
export const NOTICE_TIPS: readonly Tip[] = [
    {
        id: 'automations',
        title: 'Let automations do the routine work',
        body: 'An automation is a rule of the form "when this occurs, do that". For example, when CI fails, it sends the log to the agent of the worktree. Start from a template.',
        action: { kind: 'view', view: 'automations', label: 'Open Automations' }
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
        body: 'Open a pull request in Review and click the folder button in its header. On the pull request list of a repository, press C.',
        action: { kind: 'view', view: 'review', label: 'Open Review' }
    },
    {
        id: 'agentReview',
        title: 'Let an agent review a pull request first',
        body: 'On the review card, click "Run agent review first". You accept or remove each comment of the agent. Nothing goes to GitHub until you submit the review.',
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
        body: 'Select lines in the editor and press ⇧⌘A to ask the agent about them. In a diff, press ⇧⌘M to comment on the lines, ask the agent or send a note to it.'
    },
    {
        id: 'reviewKeys',
        title: 'Review with the keyboard',
        body: 'On the pull request list of a repository, J and K move and Enter opens. C makes a worktree from the pull request. A starts an agent review.',
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
        body: '⌥⌘1 to ⌥⌘7 open Dashboard, Agents, Tasks, Review, Pipelines, Notes and Automations. ⌘[ and ⌘] go back and forward.',
        action: { kind: 'shortcuts', label: 'Keyboard shortcuts' }
    },
    {
        id: 'quit',
        title: 'Agents continue to run after ⌘Q',
        body: '⌘Q closes the window, and your agents continue their work. Press ⇧⌥⌘Q to quit and stop all agents.'
    },
    {
        id: 'worktreeMenu',
        title: 'Rename, hide or snooze a worktree',
        body: 'Right-click a worktree in the sidebar. Snooze hides it for an hour, until tomorrow or until next week. Then it shows again.'
    },
    {
        id: 'browserTab',
        title: 'Open a browser next to the agent',
        body: 'The + button of the tab strip opens an agent, a shell or a browser tab. Split the browser next to the agent to see your app while the agent works.'
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
        body: 'Each event has its own switch and sound: an agent needs input, an agent finished, CI finished, new Dashboard items and automations.',
        action: { kind: 'settings', section: 'notifications', label: 'Open Notifications' }
    },
    {
        id: 'usage',
        title: 'See the usage of your plan',
        body: 'The status bar shows how much of your Claude or Codex plan you used. Move the pointer over it to see the limits and when they reset.'
    },
    {
        id: 'phone',
        title: 'See your agents on your phone',
        body: 'Pair the ShipWarden iPhone app in Settings › Mobile. Then you can see your agents when you are away from your Mac.',
        action: { kind: 'settings', section: 'mobile', label: 'Open Mobile' }
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
        body: 'Click New and choose a template, for example "Fix failed CI". Choose "Ask first" to approve each run before it starts.'
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
