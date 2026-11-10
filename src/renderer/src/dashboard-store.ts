import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    DASHBOARD_WINDOW_DAYS,
    gitHubSeenKey,
    isHiddenComment,
    isMergedApproval,
    taskSeenKey,
    type CommentFilter,
    type DashboardPullRequests,
    type PullRequestCommentItem,
    type TaskCommentItem
} from '@shared/dashboard';
import { repoId, type RepoRef } from '@shared/github';
import { keyRoots, queryClient } from './query-client';
import { seenStore, useSeenVersion } from './seen-store';
import { errorText, optionalErrorText } from './util';

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
    /** A key for the providers and their scopes (see `reviewScopeKey`). Null: no provider is on. */
    reviewKey: string | null;
}

/**
 * The query keys of the Dashboard. The pull requests and the comments depend on the providers.
 * The keys do not contain the project, because all projects use the same providers and task managers.
 */
export const dashboardKeys = {
    pullRequests: (reviewKey: string | null) => [...keyRoots.dashboard, 'pullRequests', reviewKey] as const,
    comments: (reviewKey: string | null) => [...keyRoots.dashboard, 'comments', reviewKey] as const,
    tasks: [...keyRoots.dashboard, 'tasks'] as const
};

/** The query of the pull requests of the Dashboard. The Review view uses it too, to find the repositories of the user. */
export function dashboardPullRequestsQuery(reviewKey: string | null) {
    return {
        queryKey: dashboardKeys.pullRequests(reviewKey),
        queryFn: () => window.shipwarden.github.dashboardPullRequests()
    };
}

function commentsQuery(reviewKey: string | null) {
    return {
        queryKey: dashboardKeys.comments(reviewKey),
        queryFn: async (): Promise<PullRequestCommentItem[]> => {
            const [prComments] = await Promise.all([window.shipwarden.github.dashboardComments(), seenStore.load()]);
            // An approval of a merged pull request needs no action. Record it as seen.
            seenStore.mark(prComments.filter(isMergedApproval).map(item => gitHubSeenKey(item.id)));
            return prComments;
        }
    };
}

const tasksQuery = {
    queryKey: dashboardKeys.tasks,
    queryFn: () => loadTasks()
};

/** Asks each task manager with the "activity" capability for new comments. */
async function loadTasks(): Promise<TaskActivity[]> {
    const since = new Date(Date.now() - DASHBOARD_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const api = window.shipwarden.tasks;
    const connections = await api.enabledConnections().catch(() => []);
    const results = await Promise.all(
        connections.map(async (connection): Promise<TaskActivity | undefined> => {
            try {
                const source = await api.source(connection.id);
                if (!source.capabilities.activity) {
                    return undefined;
                }
                const result = (await api.request(connection.id, 'activity/list', { since })) as { comments: TaskCommentItem[] };
                return { connectionId: connection.id, name: connection.name, comments: result.comments };
            } catch (error) {
                return { connectionId: connection.id, name: connection.name, error: errorText(error) };
            }
        })
    );
    return results.filter((item): item is TaskActivity => !!item);
}

/**
 * The scope of the Dashboard. The loader in App sets it. The views read it, so that they use the same query keys.
 * Undefined until the settings load.
 */
let currentScope: Scope | undefined;
const scopeListeners = new Set<() => void>();

function setScope(scope: Scope | undefined): void {
    if (JSON.stringify(scope) === JSON.stringify(currentScope)) return;
    currentScope = scope;
    scopeListeners.forEach(listener => listener());
}

function useScope(): Scope | undefined {
    return useSyncExternalStore(
        listener => {
            scopeListeners.add(listener);
            return () => scopeListeners.delete(listener);
        },
        () => currentScope
    );
}

/** Reads the Dashboard data of a scope from the query cache. Each part shows when it arrives. The pull requests are fast, the comments are slow. */
function useDashboardData(scope: Scope | undefined): DashboardState {
    const enabled = scope !== undefined;
    const reviewKey = scope?.reviewKey ?? null;
    const pullRequests = useQuery({ ...dashboardPullRequestsQuery(reviewKey), enabled });
    const comments = useQuery({ ...commentsQuery(reviewKey), enabled });
    const tasks = useQuery({ ...tasksQuery, enabled });
    const queries = [pullRequests, comments, tasks];
    // The Dashboard is up to date when each part has a result: data or an error.
    const settled = queries.every(query => query.status !== 'pending');
    const updatedAt = settled ? Math.max(...queries.map(query => Math.max(query.dataUpdatedAt, query.errorUpdatedAt))) : undefined;
    return {
        pullRequests: pullRequests.data,
        pullRequestsError: optionalErrorText(pullRequests.error),
        prComments: comments.data,
        prCommentsError: optionalErrorText(comments.error),
        tasks: tasks.data ?? [],
        loading: queries.some(query => query.isFetching),
        updatedAt: updatedAt || undefined
    };
}

/** The keys of the items of the Dashboard. An item with a changed reason (a new CI failure) gets a new key. */
function newsItems(pullRequests: DashboardPullRequests, prComments: PullRequestCommentItem[], tasks: TaskActivity[]) {
    return {
        reviewRequests: pullRequests.reviewRequests.map(item => ({ key: `r:${item.url}`, item })),
        myPullRequests: pullRequests.myPullRequests.map(item => ({ key: `m:${item.url}:${item.reasons.join(',')}`, item })),
        prComments: prComments.filter(item => !isMergedApproval(item)).map(item => ({ key: `c:${item.id}`, item })),
        taskComments: tasks.flatMap(source =>
            (source.comments ?? []).map(comment => ({
                key: `t:${source.connectionId}:${comment.id}`,
                item: { connectionId: source.connectionId, comment }
            }))
        )
    };
}

/**
 * Finds the items that no earlier refresh had. Returns the keys of all items, and the news.
 * Without earlier keys (the first refresh), there is no news.
 */
export function findDashboardNews(
    known: Set<string> | undefined,
    pullRequests: DashboardPullRequests,
    prComments: PullRequestCommentItem[],
    tasks: TaskActivity[]
): { known: Set<string>; news?: DashboardNews } {
    const items = newsItems(pullRequests, prComments, tasks);
    const keys = [...items.reviewRequests, ...items.myPullRequests, ...items.prComments, ...items.taskComments].map(entry => entry.key);
    const all = new Set([...(known ?? []), ...keys]);
    if (!known) return { known: all };
    const fresh = <T>(list: { key: string; item: T }[]) => list.filter(entry => !known.has(entry.key)).map(entry => entry.item);
    const news: DashboardNews = {
        reviewRequests: fresh(items.reviewRequests),
        myPullRequests: fresh(items.myPullRequests),
        prComments: fresh(items.prComments),
        taskComments: fresh(items.taskComments)
    };
    const count = news.reviewRequests.length + news.myPullRequests.length + news.prComments.length + news.taskComments.length;
    return { known: all, news: count > 0 ? news : undefined };
}

const newsListeners = new Set<(news: DashboardNews) => void>();

/** Calls the listener with the new items after each complete refresh. The first refresh has no news. */
export function onDashboardNews(listener: (news: DashboardNews) => void): () => void {
    newsListeners.add(listener);
    return () => newsListeners.delete(listener);
}

/**
 * Loads the Dashboard for the whole app, so that the sidebar can show the count in all views.
 * The queries stay in use here. Thus the data loads again every few minutes (the default of the query client).
 * After each complete refresh, the loader tells the news listeners about the new items.
 */
export function useDashboardLoader(ready: boolean, reviewKey: string | null | undefined): void {
    const scope = ready && reviewKey !== undefined ? { reviewKey } : undefined;
    const scopeId = JSON.stringify(scope);
    // biome-ignore lint/correctness/useExhaustiveDependencies: scopeId holds the content of scope.
    useEffect(() => setScope(scope), [scopeId]);
    const state = useDashboardData(scope);

    // The keys of all items of the earlier refreshes. Other organizations: their items are not news.
    const known = useRef<{ scopeId: string; keys?: Set<string> }>({ scopeId });
    if (known.current.scopeId !== scopeId) known.current = { scopeId };
    const { pullRequests, prComments, tasks, loading, updatedAt } = state;
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new update time or the end of a load is a new refresh. The data comes from the same render.
    useEffect(() => {
        if (loading || !updatedAt || !pullRequests || !prComments) return;
        const result = findDashboardNews(known.current.keys, pullRequests, prComments, tasks);
        known.current.keys = result.known;
        const news = result.news;
        if (news) newsListeners.forEach(listener => listener(news));
    }, [updatedAt, loading]);
}

/** Returns the Dashboard data of the current scope. The loader in App keeps it up to date. */
export function useDashboard(): DashboardState {
    return useDashboardData(useScope());
}

/** Loads all parts of the Dashboard again. */
export function refreshDashboard(): Promise<void> {
    return queryClient.refetchQueries({ queryKey: keyRoots.dashboard, type: 'active' });
}

/** The number of items that need the user: review requests, own pull requests to act on, and unseen comments. */
export function useDashboardCount(filter: CommentFilter): number {
    const state = useDashboard();
    useSeenVersion();
    const prComments = state.prComments?.filter(item => !isHiddenComment(item.author, item.text, filter) && !seenStore.has(gitHubSeenKey(item.id))).length ?? 0;
    const taskComments = state.tasks.reduce(
        (sum, source) =>
            sum +
            (source.comments?.filter(item => !isHiddenComment(item.author, item.body, filter) && !seenStore.has(taskSeenKey(source.connectionId, item.id)))
                .length ?? 0),
        0
    );
    return (state.pullRequests?.reviewRequests.length ?? 0) + (state.pullRequests?.myPullRequests.length ?? 0) + prComments + taskComments;
}

/** A pull request by its repository and number. */
export interface PullRequestRef {
    repo: RepoRef;
    number: number;
}

function sameRef(a: PullRequestRef, b: PullRequestRef): boolean {
    return a.number === b.number && repoId(a.repo).toLowerCase() === repoId(b.repo).toLowerCase();
}

/** Removes merged pull requests from the review requests and from the pull requests of the user. */
export function withoutMergedPullRequests(data: DashboardPullRequests, merged: PullRequestRef[]): DashboardPullRequests {
    const open = (item: PullRequestRef) => !merged.some(ref => sameRef(ref, item));
    return { reviewRequests: data.reviewRequests.filter(open), myPullRequests: data.myPullRequests.filter(open) };
}

/** Sets the state MERGED on the comments of merged pull requests. An approval of a merged pull request then needs no action. */
export function withMergedComments(items: PullRequestCommentItem[], merged: PullRequestRef[]): PullRequestCommentItem[] {
    return items.map(item => (merged.some(ref => sameRef(ref, item)) ? { ...item, prState: 'MERGED' } : item));
}

/** Updates the cached Dashboard data after merges. No request goes to the providers. */
export function applyMergedToDashboard(merged: PullRequestRef[]): void {
    if (merged.length === 0) return;
    queryClient.setQueriesData<DashboardPullRequests>(
        { queryKey: [...keyRoots.dashboard, 'pullRequests'] },
        data => data && withoutMergedPullRequests(data, merged)
    );
    queryClient.setQueriesData<PullRequestCommentItem[]>({ queryKey: [...keyRoots.dashboard, 'comments'] }, data => {
        if (!data) return data;
        const items = withMergedComments(data, merged);
        seenStore.mark(items.filter(isMergedApproval).map(item => gitHubSeenKey(item.id)));
        return items;
    });
}
