import { useEffect, useRef } from 'react';
import type { NotificationTarget } from '@shared/api';
import { gitHubSeenKey, isHiddenComment, taskSeenKey, type CommentFilter } from '@shared/dashboard';
import type { BranchSummary } from '@shared/github';
import { ciChanges, inCiScope } from '@shared/notifications';
import type { AppSettings } from '@shared/settings';
import type { TaskLink } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { dashboardStore, type DashboardNews } from '../dashboard-store';
import { seenStore } from '../seen-store';
import { agentNotice, ciNotice, dashboardNotice, type Notice } from './notices';

const api = window.shipwarden;

interface Options {
    appSettings: AppSettings;
    summaries: Record<string, Record<string, BranchSummary>>;
    worktreesByRepo: Record<string, Worktree[]>;
    worktrees: Worktree[];
    sessions: TerminalSession[];
    links: Record<string, TaskLink>;
    commentFilter: CommentFilter;
    repoLabel: (repo: string) => string;
    /** True when the user sees the terminal of the session now. */
    isSessionVisible: (session: TerminalSession) => boolean;
    /** Shows the place of a notification after a click on it. */
    openTarget: (target: NotificationTarget | undefined) => void;
}

/**
 * Shows macOS notifications for agents, for finished CI checks and for new Dashboard items.
 * Returns the function for the agent notifications. An IPC listener calls it.
 */
export function useNotifications(options: Options) {
    const { appSettings, summaries } = options;

    /**
     * Shows a macOS notification for an event, when Settings › Notifications allows it.
     * The main process shows it, because only Electron can play a named macOS sound with it.
     */
    const notify = ({ event, title, body, target }: Notice) => {
        const settings = appSettings.notifications;
        if (!settings.enabled || !settings.events[event].enabled) return;
        if (!settings.whenFocused && document.hasFocus()) return;
        api.notifications.show({ title, body, sound: settings.events[event].sound, target });
    };

    /** Shows a notification when an agent needs input or finishes, unless the user looks at that agent now. */
    const notifyAgent = (id: string, state: 'waiting' | 'done', message?: string) => {
        const session = options.sessions.find(item => item.id === id);
        if (!session || options.isSessionVisible(session)) {
            return;
        }
        const worktree = options.worktrees.find(item => item.path === session.worktreePath);
        const taskKey = session.worktreePath ? options.links[session.worktreePath]?.key : undefined;
        notify(agentNotice(session, { taskKey, branch: worktree?.branch }, state, message));
    };

    const openTargetRef = useRef(options.openTarget);
    openTargetRef.current = options.openTarget;
    useEffect(() => api.notifications.onClick(target => openTargetRef.current(target)), []);

    // CI finished: the checks of a pull request went from waiting to a result. Settings › Notifications selects which pull requests.
    const previousSummaries = useRef<Record<string, Record<string, BranchSummary>>>({});
    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect must run only when the summaries change. It reads the other values from the same render.
    useEffect(() => {
        for (const [repo, list] of Object.entries(summaries)) {
            for (const change of ciChanges(previousSummaries.current[repo], list)) {
                if (!inCiScope(appSettings.notifications.ciScope, change.summary)) continue;
                const worktree = options.worktreesByRepo[repo]?.find(item => item.branch === change.branch);
                notify(ciNotice(change.branch, change.passed, change.summary.number, options.repoLabel(repo), worktree?.path));
            }
        }
        previousSummaries.current = summaries;
    }, [summaries]);

    // New Dashboard items: one notification for each refresh, without hidden authors and seen comments.
    const dashboardNews = (news: DashboardNews) => {
        const filter = options.commentFilter;
        const comments =
            news.prComments.filter(item => !isHiddenComment(item.author, item.text, filter) && !seenStore.has(gitHubSeenKey(item.id))).length +
            news.taskComments.filter(
                ({ connectionId, comment }) => !isHiddenComment(comment.author, comment.body, filter) && !seenStore.has(taskSeenKey(connectionId, comment.id))
            ).length;
        const notice = dashboardNotice({
            reviewRequests: news.reviewRequests.length,
            myPullRequests: news.myPullRequests.length,
            comments,
            firstTitle: news.reviewRequests[0]?.title ?? news.myPullRequests[0]?.title
        });
        if (notice) notify(notice);
    };
    const dashboardNewsRef = useRef(dashboardNews);
    dashboardNewsRef.current = dashboardNews;
    useEffect(() => dashboardStore.onNews(news => dashboardNewsRef.current(news)), []);

    return notifyAgent;
}
