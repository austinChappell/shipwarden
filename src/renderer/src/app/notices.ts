import type { NotificationTarget } from '@shared/api';
import type { NotificationEvent } from '@shared/notifications';
import type { TerminalSession } from '@shared/terminal';

/** The content of a macOS notification, before the settings filter it. */
export interface Notice {
    event: NotificationEvent;
    title: string;
    body: string;
    target?: NotificationTarget;
}

/**
 * Returns the notification for an agent that needs input or that finished its turn.
 * The name is the task key of the worktree, else its branch, else the title of the session.
 */
export function agentNotice(
    session: Pick<TerminalSession, 'id' | 'title' | 'worktreePath'>,
    names: { taskKey?: string; branch?: string },
    state: 'waiting' | 'done',
    message?: string
): Notice {
    const name = (session.worktreePath && names.taskKey) || names.branch || session.title;
    return {
        event: state === 'waiting' ? 'agentWaiting' : 'agentDone',
        title: state === 'waiting' ? `${name} needs your input` : `${name} is done`,
        body: message ? message.slice(0, 180) : state === 'waiting' ? 'The agent waits for you.' : 'The agent finished its turn.',
        target: session.worktreePath ? { view: 'worktree', worktreePath: session.worktreePath, sessionId: session.id } : undefined
    };
}

/** The counts of new Dashboard items in one refresh. */
export interface DashboardCounts {
    reviewRequests: number;
    myPullRequests: number;
    comments: number;
    /** The title of the first new pull request, when there is one. */
    firstTitle?: string;
}

/** Returns the notification for new Dashboard items. Returns undefined when no item is new. */
export function dashboardNotice(counts: DashboardCounts): Notice | undefined {
    const { reviewRequests, myPullRequests, comments } = counts;
    const parts = [
        reviewRequests ? `${reviewRequests} review request${reviewRequests === 1 ? '' : 's'}` : '',
        myPullRequests ? `${myPullRequests} of your pull requests need${myPullRequests === 1 ? 's' : ''} you` : '',
        comments ? `${comments} new comment${comments === 1 ? '' : 's'}` : ''
    ].filter(Boolean);
    if (parts.length === 0) return undefined;
    return {
        event: 'dashboard',
        title: `Dashboard: ${parts.join(', ')}`,
        body: counts.firstTitle ?? 'Open the Dashboard to see them.',
        target: { view: 'dashboard' }
    };
}

/** Returns the notification for a pull request whose CI checks finished. */
export function ciNotice(branch: string, passed: boolean, number: number, repoName: string, worktreePath: string | undefined): Notice {
    return {
        event: 'ciFinished',
        title: `CI ${passed ? 'passed' : 'failed'}: ${branch}`,
        body: `Pull request #${number} in ${repoName}`,
        target: worktreePath ? { view: 'worktree', worktreePath } : undefined
    };
}
