import { useEffect, useSyncExternalStore } from 'react';
import { DASHBOARD_WINDOW_DAYS, gitHubSeenKey, isHiddenComment, taskSeenKey, type CommentFilter, type DashboardPullRequests, type PullRequestCommentItem, type TaskCommentItem } from '@shared/dashboard';
import { seenStore, useSeenVersion } from './seen-store';
import { errorText } from './util';

/** The Dashboard loads again at this interval. ClickUp allows 100 requests per minute, so the interval is long. */
const REFRESH_MS = 5 * 60 * 1000;

export interface TaskActivity {
    connectionId: string;
    name: string;
    comments?: TaskCommentItem[];
    error?: string;
}

export interface DashboardState {
    pullRequests?: DashboardPullRequests;
    pullRequestsError?: string;
    prComments?: PullRequestCommentItem[];
    prCommentsError?: string;
    tasks: TaskActivity[];
    loading: boolean;
    updatedAt?: number;
}

/** The items of a refresh that the earlier refreshes did not have. */
export interface DashboardNews {
    reviewRequests: DashboardPullRequests['reviewRequests'];
    myPullRequests: DashboardPullRequests['myPullRequests'];
    prComments: PullRequestCommentItem[];
    taskComments: { connectionId: string; comment: TaskCommentItem }[];
}

interface Scope {
    /** A key for the GitHub providers and their scopes (see `githubScopeKey`). */
    githubKey: string | null | undefined;
    projectId: string | undefined;
}

/** Loads the items of the Dashboard for the whole app, so that the sidebar can show the count in all views. */
class DashboardStore {
    private state: DashboardState = { tasks: [], loading: false };
    private scope: Scope = { githubKey: undefined, projectId: undefined };
    private request = 0;
    private readonly listeners = new Set<() => void>();
    private readonly newsListeners = new Set<(news: DashboardNews) => void>();
    /** The keys of all items of the earlier refreshes. Undefined until the first complete refresh. */
    private known: Set<string> | undefined;

    /** Calls the listener with the new items after each complete refresh. The first refresh has no news. */
    onNews(listener: (news: DashboardNews) => void): () => void {
        this.newsListeners.add(listener);
        return () => this.newsListeners.delete(listener);
    }

    get = (): DashboardState => this.state;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    setScope(scope: Scope): void {
        const same = JSON.stringify(scope) === JSON.stringify(this.scope);
        this.scope = scope;
        // Another project or other organizations: their items are not news.
        if (!same) this.known = undefined;
        if (!same || !this.state.updatedAt) {
            void this.refresh();
        }
    }

    async refresh(): Promise<void> {
        const id = ++this.request;
        const { projectId } = this.scope;
        this.set({ loading: true });
        await seenStore.load();
        const since = new Date(Date.now() - DASHBOARD_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

        // Each part shows when it arrives. The pull requests are fast, the comments are slow.
        const current = () => id === this.request;
        const github = window.shipwarden.github;
        await Promise.all([
            github.dashboardPullRequests().then(
                pullRequests => current() && this.set({ pullRequests, pullRequestsError: undefined }),
                error => current() && this.set({ pullRequestsError: errorText(error) })
            ),
            github.dashboardComments().then(
                prComments => current() && this.set({ prComments, prCommentsError: undefined }),
                error => current() && this.set({ prCommentsError: errorText(error) })
            ),
            this.loadTasks(projectId, since).then(tasks => current() && this.set({ tasks }))
        ]);
        if (current()) {
            this.set({ loading: false, updatedAt: Date.now() });
            this.findNews();
        }
    }

    /** Asks each task manager with the "activity" capability for new comments. */
    private async loadTasks(projectId: string | undefined, since: string): Promise<TaskActivity[]> {
        if (!projectId) {
            return [];
        }
        const api = window.shipwarden.tasks;
        const connections = await api.enabledConnections().catch(() => []);
        const results = await Promise.all(connections.map(async (connection): Promise<TaskActivity | undefined> => {
            try {
                const source = await api.source(connection.id, projectId);
                if (!source.capabilities.activity) {
                    return undefined;
                }
                const result = await api.request(connection.id, projectId, 'activity/list', { since }) as { comments: TaskCommentItem[] };
                return { connectionId: connection.id, name: connection.name, comments: result.comments };
            } catch (error) {
                return { connectionId: connection.id, name: connection.name, error: errorText(error) };
            }
        }));
        return results.filter((item): item is TaskActivity => !!item);
    }

    /** Finds the items that no earlier refresh had. An item with a changed reason (a new CI failure) is new too. */
    private findNews(): void {
        const { pullRequests, prComments, tasks } = this.state;
        if (!pullRequests || !prComments) return;
        const items = {
            reviewRequests: pullRequests.reviewRequests.map(item => ({ key: `r:${item.url}`, item })),
            myPullRequests: pullRequests.myPullRequests.map(item => ({ key: `m:${item.url}:${item.reasons.join(',')}`, item })),
            prComments: prComments.map(item => ({ key: `c:${item.id}`, item })),
            taskComments: tasks.flatMap(source => (source.comments ?? []).map(comment => ({ key: `t:${source.connectionId}:${comment.id}`, item: { connectionId: source.connectionId, comment } })))
        };
        const keys = [...items.reviewRequests, ...items.myPullRequests, ...items.prComments, ...items.taskComments].map(entry => entry.key);
        const known = this.known;
        this.known = new Set([...(known ?? []), ...keys]);
        if (!known) return;
        const fresh = <T,>(list: { key: string; item: T }[]) => list.filter(entry => !known.has(entry.key)).map(entry => entry.item);
        const news: DashboardNews = {
            reviewRequests: fresh(items.reviewRequests),
            myPullRequests: fresh(items.myPullRequests),
            prComments: fresh(items.prComments),
            taskComments: fresh(items.taskComments)
        };
        if (news.reviewRequests.length + news.myPullRequests.length + news.prComments.length + news.taskComments.length > 0) {
            this.newsListeners.forEach(listener => listener(news));
        }
    }

    private set(change: Partial<DashboardState>): void {
        this.state = { ...this.state, ...change };
        this.listeners.forEach(listener => listener());
    }
}

export const dashboardStore = new DashboardStore();

/** Loads the Dashboard when the scope changes, and again every few minutes. */
export function useDashboardLoader(ready: boolean, githubKey: string | null | undefined, projectId: string | undefined): void {
    useEffect(() => {
        if (ready && githubKey !== undefined) {
            dashboardStore.setScope({ githubKey, projectId });
        }
    }, [ready, githubKey, projectId]);
    useEffect(() => {
        if (!ready) return;
        const timer = setInterval(() => void dashboardStore.refresh(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [ready]);
}

export function useDashboard(): DashboardState {
    return useSyncExternalStore(dashboardStore.subscribe, dashboardStore.get);
}

/** The number of items that need the user: review requests, own pull requests to act on, and unseen comments. */
export function useDashboardCount(filter: CommentFilter): number {
    const state = useDashboard();
    useSeenVersion();
    const prComments = state.prComments?.filter(item => !isHiddenComment(item.author, item.text, filter) && !seenStore.has(gitHubSeenKey(item.id))).length ?? 0;
    const taskComments = state.tasks.reduce((sum, source) =>
        sum + (source.comments?.filter(item => !isHiddenComment(item.author, item.body, filter) && !seenStore.has(taskSeenKey(source.connectionId, item.id))).length ?? 0), 0);
    return (state.pullRequests?.reviewRequests.length ?? 0) + (state.pullRequests?.myPullRequests.length ?? 0) + prComments + taskComments;
}
