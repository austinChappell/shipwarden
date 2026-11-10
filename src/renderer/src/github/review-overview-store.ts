import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { notifyManager, useQueries, useQuery, type Query } from '@tanstack/react-query';
import { repoId, parseRepoId, type GitHubRepoInfo, type PullRequest, type RepoRef } from '@shared/github';
import { reviewQueue, type QueueItem, type RepoPullRequests } from '@shared/review-queue';
import { applyMergedToDashboard, dashboardPullRequestsQuery, type PullRequestRef } from '../dashboard-store';
import { keyRoots, queryClient } from '../query-client';
import { optionalErrorText } from '../util';
import { reviewKeys } from './review-store';

/** The number of repository requests at the same time. More can trigger the secondary rate limit of GitHub. */
const PARALLEL = 3;

export interface RepoEntry {
    /** The ID of the repository (see `repoId`), for example "owner/name". */
    id: string;
    data?: RepoPullRequests;
    error?: string;
    loading: boolean;
    loadedAt?: number;
}

export interface ReviewOverviewState {
    /** All repositories of the providers. Undefined until the first load. */
    catalog?: GitHubRepoInfo[];
    catalogError?: string;
    catalogLoading: boolean;
    /** The IDs of the repositories of the local repositories, in sidebar order. */
    projectRepos: string[];
    /** The loaded repositories, by the lower-case ID. */
    repos: Record<string, RepoEntry>;
}

function lower(id: string): string {
    return id.toLowerCase();
}

/**
 * The query keys of the Review overview. The keys of a repository use the lower-case ID, because the sources of the IDs
 * do not always agree on the case. The repository data depends on the providers (`reviewKey`).
 */
export const overviewKeys = {
    catalog: (reviewKey: string | null) => [...keyRoots.repositories, reviewKey] as const,
    repoOf: (path: string) => [...keyRoots.repoOf, path] as const,
    /** The start of the keys of the open pull requests of a repository, for all providers. */
    openOf: (id: string) => [...keyRoots.repoPullRequests, lower(id), 'open'] as const,
    open: (id: string, reviewKey: string | null) => [...keyRoots.repoPullRequests, lower(id), 'open', reviewKey] as const,
    /** The start of the keys of the merged pull requests of a repository, for all search texts. */
    mergedOf: (id: string) => [...keyRoots.repoPullRequests, lower(id), 'merged'] as const,
    merged: (id: string, query: string) => [...keyRoots.repoPullRequests, lower(id), 'merged', query] as const
};

/** Returns a function that runs tasks with not more than `parallel` tasks at the same time. The other tasks wait in order. */
export function createLimiter(parallel: number): <T>(task: () => Promise<T>) => Promise<T> {
    let running = 0;
    const waiting: (() => void)[] = [];
    const next = () => {
        if (running >= parallel) return;
        const start = waiting.shift();
        if (start) start();
    };
    return <T>(task: () => Promise<T>) =>
        new Promise<T>((resolve, reject) => {
            waiting.push(() => {
                running++;
                task()
                    .then(resolve, reject)
                    .finally(() => {
                        running--;
                        next();
                    });
            });
            next();
        });
}

const limit = createLimiter(PARALLEL);

function catalogQuery(reviewKey: string | null) {
    return { queryKey: overviewKeys.catalog(reviewKey), queryFn: () => window.shipwarden.github.repositories() };
}

/** Finds the GitHub or Azure Repos repository of a local repository, from its "origin" remote. Null: no such remote. */
function repoOfQuery(path: string) {
    return {
        queryKey: overviewKeys.repoOf(path),
        queryFn: (): Promise<RepoRef | null> => window.shipwarden.github.repoOf(path).catch(() => null)
    };
}

/** The open pull requests of a repository. Not more than PARALLEL of these requests run at the same time. */
function openQuery(id: string, reviewKey: string | null) {
    return {
        queryKey: overviewKeys.open(id, reviewKey),
        queryFn: () => limit(() => window.shipwarden.github.repoPullRequests(parseRepoId(id))),
        meta: { repoId: id }
    };
}

/** Removes duplicate IDs. The case of an ID does not matter. The first spelling stays. */
export function uniqueRepoIds(ids: string[]): string[] {
    const result = new Map<string, string>();
    for (const id of ids) if (!result.has(lower(id))) result.set(lower(id), id);
    return [...result.values()];
}

/** The IDs of the repositories of the local repositories. */
function useProjectRepos(paths: string[], enabled: boolean): string[] {
    const results = useQueries({ queries: paths.map(path => ({ ...repoOfQuery(path), enabled })) });
    const joined = results.flatMap(result => (result.data ? [repoId(result.data)] : [])).join('\n');
    return useMemo(() => (joined ? uniqueRepoIds(joined.split('\n')) : []), [joined]);
}

/** The scope of the Review overview. The loader in App sets it. The views read it, so that they use the same query keys. */
interface Scope {
    reviewKey: string | null;
    paths: string[];
}

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

const NO_PATHS: string[] = [];

/**
 * Loads the open pull requests of the repositories that matter to the user: the repositories of the projects,
 * and the repositories with a review request or a pull request of the user (from the Dashboard).
 * The loader runs at app start, so that the Review view shows its data immediately. The queries stay in use here.
 * Thus the data loads again every few minutes (the default of the query client).
 */
export function useReviewOverviewLoader(ready: boolean, reviewKey: string | null | undefined, paths: string[]): void {
    const scope = ready && reviewKey !== undefined ? { reviewKey, paths } : undefined;
    const scopeId = JSON.stringify(scope);
    // biome-ignore lint/correctness/useExhaustiveDependencies: scopeId holds the content of scope.
    useEffect(() => setScope(scope), [scopeId]);
    const enabled = ready && !!reviewKey;
    const key = reviewKey ?? null;
    useQuery({ ...catalogQuery(key), enabled });
    const projectRepos = useProjectRepos(paths, enabled);
    // The Dashboard loader loads these pull requests. This query only reads them.
    const dashboard = useQuery({ ...dashboardPullRequestsQuery(key), enabled: ready && reviewKey !== undefined });
    const tracked = useMemo(() => {
        const items = dashboard.data ? [...dashboard.data.reviewRequests, ...dashboard.data.myPullRequests] : [];
        return uniqueRepoIds([...projectRepos, ...items.map(item => repoId(item.repo))]);
    }, [projectRepos, dashboard.data]);
    useQueries({ queries: tracked.map(id => ({ ...openQuery(id, key), enabled })) });
}

/** The cache changes when a query of open pull requests changes. The views then read the entries again. */
let repoCacheVersion = 0;
const repoCacheListeners = new Set<() => void>();
queryClient.getQueryCache().subscribe(event => {
    const queryKey = event.query.queryKey;
    if (event.type !== 'added' && event.type !== 'removed' && event.type !== 'updated') return;
    if (queryKey[0] !== keyRoots.repoPullRequests[0] || queryKey[1] !== keyRoots.repoPullRequests[1] || queryKey[3] !== 'open') return;
    // A query can enter the cache while a component renders. Thus the views get the change later, not in that render.
    notifyManager.schedule(() => {
        repoCacheVersion++;
        repoCacheListeners.forEach(listener => listener());
    });
});

function subscribeRepoCache(listener: () => void): () => void {
    repoCacheListeners.add(listener);
    return () => repoCacheListeners.delete(listener);
}

/** Makes the entry of a repository from the state of its query. */
function entryOf(id: string, query: Pick<Query, 'state'>): RepoEntry {
    const state = query.state as Query<RepoPullRequests>['state'];
    const loadedAt = Math.max(state.dataUpdatedAt, state.errorUpdatedAt);
    return {
        id,
        data: state.data,
        error: optionalErrorText(state.error),
        loading: state.fetchStatus === 'fetching',
        loadedAt: loadedAt || undefined
    };
}

/** The entries of all cached repositories of the providers, also of the repositories that the user opened before. */
function useRepoEntries(reviewKey: string | null | undefined): Record<string, RepoEntry> {
    const version = useSyncExternalStore(subscribeRepoCache, () => repoCacheVersion);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The version changes when the cached entries change.
    return useMemo(() => {
        const repos: Record<string, RepoEntry> = {};
        if (!reviewKey) return repos;
        for (const query of queryClient.getQueryCache().findAll({ queryKey: keyRoots.repoPullRequests })) {
            const [, , key, kind, scope] = query.queryKey;
            if (kind !== 'open' || scope !== reviewKey || typeof key !== 'string' || !key) continue;
            repos[key] = entryOf((query.meta?.repoId as string | undefined) ?? key, query);
        }
        return repos;
    }, [version, reviewKey]);
}

export function useReviewOverview(): ReviewOverviewState {
    const scope = useScope();
    const reviewKey = scope?.reviewKey ?? null;
    const enabled = !!reviewKey;
    const catalog = useQuery({ ...catalogQuery(reviewKey), enabled });
    const projectRepos = useProjectRepos(scope?.paths ?? NO_PATHS, enabled);
    const repos = useRepoEntries(reviewKey);
    return {
        catalog: enabled ? catalog.data : undefined,
        catalogError: enabled ? optionalErrorText(catalog.error) : undefined,
        catalogLoading: catalog.isFetching,
        projectRepos,
        repos
    };
}

/** Loads one repository (see `repoId`) while the caller shows it, and returns its data. */
export function useRepoEntry(id: string | undefined): RepoEntry | undefined {
    const reviewKey = useScope()?.reviewKey ?? null;
    const query = useQuery({ ...openQuery(id ?? '', reviewKey), enabled: !!reviewKey && !!id });
    if (!id) return undefined;
    return {
        id,
        data: query.data,
        error: optionalErrorText(query.error),
        loading: query.isFetching,
        loadedAt: Math.max(query.dataUpdatedAt, query.errorUpdatedAt) || undefined
    };
}

/** Loads one repository again now, also when its data is new. */
export function refreshRepo(id: string): Promise<void> {
    return queryClient.refetchQueries({ queryKey: overviewKeys.openOf(id) });
}

/** Loads the list of repositories and all cached repositories again. */
export function refreshReviewOverview(): Promise<void> {
    const reviewKey = currentScope?.reviewKey;
    if (!reviewKey) return Promise.resolve();
    return Promise.all([
        queryClient.refetchQueries({ queryKey: overviewKeys.catalog(reviewKey) }),
        queryClient.refetchQueries({
            queryKey: keyRoots.repoPullRequests,
            predicate: query => query.queryKey[3] === 'open' && query.queryKey[4] === reviewKey
        })
    ]).then(() => undefined);
}

/** Returns the review queue: the pull requests to review in all loaded repositories, the oldest first. */
export function useReviewQueue(): QueueItem[] {
    const repos = useRepoEntries(useScope()?.reviewKey);
    return useMemo(() => {
        const loaded = new Map<string, RepoPullRequests>();
        for (const entry of Object.values(repos)) {
            if (entry.data) loaded.set(entry.id, entry.data);
        }
        return reviewQueue(loaded);
    }, [repos]);
}

/** Removes a pull request from the open pull requests of a repository. The open count goes down when the list had it. */
export function withoutOpenPullRequest(data: RepoPullRequests, number: number): RepoPullRequests {
    const pullRequests = data.pullRequests.filter(pr => pr.number !== number);
    if (pullRequests.length === data.pullRequests.length) return data;
    return { ...data, pullRequests, openCount: Math.max(0, data.openCount - 1) };
}

/** Sets the state MERGED on a pull request. */
export function asMerged(pr: PullRequest): PullRequest {
    return { ...pr, state: 'MERGED' };
}

/**
 * Updates the cached data after merges, with no request for the changed data: the Dashboard lists, the open pull
 * requests of the repositories and the cached pull requests. Only the merged lists of the repositories load again.
 */
export function applyMerged(merged: PullRequestRef[]): void {
    applyMergedToDashboard(merged);
    for (const { repo, number } of merged) {
        const id = repoId(repo);
        queryClient.setQueriesData<RepoPullRequests>({ queryKey: overviewKeys.openOf(id) }, data => data && withoutOpenPullRequest(data, number));
        queryClient.setQueryData<PullRequest>(reviewKeys.pullRequest(repo, number), pr => pr && asMerged(pr));
        void queryClient.invalidateQueries({ queryKey: overviewKeys.mergedOf(id) });
    }
}
