import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { parseRepoId, repoId, type GitHubRepoInfo } from '@shared/github';
import { reviewQueue, type QueueItem, type RepoPullRequests } from '@shared/review-queue';
import { cacheKey, cached, remember } from '../data-cache';
import { dashboardStore } from '../dashboard-store';
import { errorText } from '../util';

/** The store loads all repositories again at this interval. */
const REFRESH_MS = 3 * 60 * 1000;
/** A repository loads again when a view asks for it and its data is older than this. */
const STALE_MS = 30 * 1000;
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

const repoOfKey = (path: string) => cacheKey('github.repoOf', path);

function lower(id: string): string {
    return id.toLowerCase();
}

/**
 * Loads the open pull requests of the repositories that matter to the user: the repositories of the projects,
 * and the repositories with a review request or a pull request of the user (from the Dashboard).
 * The store loads at app start, so that the Review view shows its data immediately.
 */
class ReviewOverviewStore {
    private state: ReviewOverviewState = { catalogLoading: false, projectRepos: [], repos: {} };
    private reviewKey: string | null | undefined;
    private paths: string[] = [];
    private readonly listeners = new Set<() => void>();
    private readonly requests = new Map<string, number>();
    private readonly waiting: string[] = [];
    private running = 0;
    private catalogRequest = 0;
    private nextRequest = 0;

    constructor() {
        dashboardStore.subscribe(() => this.trackDashboard());
    }

    get = (): ReviewOverviewState => this.state;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    /** Sets the providers and the local repositories. A change loads the data again. */
    setScope(reviewKey: string | null | undefined, paths: string[]): void {
        const keyChanged = reviewKey !== this.reviewKey;
        const pathsChanged = paths.join('\n') !== this.paths.join('\n');
        this.reviewKey = reviewKey;
        this.paths = paths;
        if (keyChanged) {
            this.waiting.length = 0;
            this.requests.clear();
            this.set({ catalog: undefined, catalogError: undefined, repos: {} });
        }
        if (!reviewKey) return;
        if (keyChanged) void this.loadCatalog();
        if (keyChanged || pathsChanged) void this.resolveProjects();
    }

    /** Loads all repositories again. */
    refreshAll(): void {
        if (!this.reviewKey) return;
        void this.loadCatalog();
        Object.keys(this.state.repos).forEach(key => this.queue(key));
    }

    /** Loads a repository when it is not loaded, or when its data is older than `maxAge`. */
    ensure(id: string, maxAge = STALE_MS): void {
        if (!this.reviewKey) return;
        const entry = this.state.repos[lower(id)];
        if (!entry) {
            this.setRepo(id, { loading: false });
        }
        const current = this.state.repos[lower(id)];
        if (current.loading) return;
        if (!current.loadedAt || Date.now() - current.loadedAt > maxAge) this.queue(lower(id));
    }

    /** Loads a repository now, also when its data is new. */
    refresh(id: string): Promise<void> {
        if (!this.state.repos[lower(id)]) this.setRepo(id, { loading: false });
        return this.load(lower(id));
    }

    private async loadCatalog(): Promise<void> {
        const id = ++this.catalogRequest;
        const key = this.reviewKey;
        const cacheId = cacheKey('review.repos', key);
        if (!this.state.catalog) this.set({ catalog: cached(cacheId) });
        this.set({ catalogLoading: true });
        try {
            const catalog = await window.shipwarden.github.repositories();
            if (id === this.catalogRequest) this.set({ catalog: remember(cacheId, catalog), catalogError: undefined });
        } catch (error) {
            if (id === this.catalogRequest) this.set({ catalogError: errorText(error) });
        } finally {
            if (id === this.catalogRequest) this.set({ catalogLoading: false });
        }
    }

    /** Finds the GitHub or Azure Repos repository of each local repository, from its "origin" remote. */
    private async resolveProjects(): Promise<void> {
        const paths = this.paths;
        const fromCache = paths.flatMap(path => cached<string | null>(repoOfKey(path)) ?? []);
        if (fromCache.length) this.setProjects(fromCache);
        const ids = await Promise.all(
            paths.map(async path => {
                const ref = await window.shipwarden.github.repoOf(path).catch(() => null);
                return remember(repoOfKey(path), ref && repoId(ref));
            })
        );
        if (paths !== this.paths) return;
        this.setProjects(ids.filter((id): id is string => !!id));
    }

    private setProjects(ids: string[]): void {
        const unique = [...new Map(ids.map(id => [lower(id), id])).values()];
        if (unique.join('\n') !== this.state.projectRepos.join('\n')) this.set({ projectRepos: unique });
        unique.forEach(id => this.ensure(id, REFRESH_MS));
    }

    /** Tracks the repositories with a review request or a pull request of the user. */
    private trackDashboard(): void {
        const pullRequests = dashboardStore.get().pullRequests;
        if (!pullRequests || !this.reviewKey) return;
        for (const item of [...pullRequests.reviewRequests, ...pullRequests.myPullRequests]) {
            this.ensure(repoId(item.repo), REFRESH_MS);
        }
    }

    private queue(key: string): void {
        if (this.waiting.includes(key) || this.state.repos[key]?.loading) return;
        this.waiting.push(key);
        this.pump();
    }

    private pump(): void {
        while (this.running < PARALLEL && this.waiting.length) {
            const key = this.waiting.shift()!;
            this.running++;
            void this.load(key).finally(() => {
                this.running--;
                this.pump();
            });
        }
    }

    private async load(key: string): Promise<void> {
        const entry = this.state.repos[key];
        if (!entry) return;
        const request = ++this.nextRequest;
        this.requests.set(key, request);
        this.setRepo(entry.id, { loading: true });
        try {
            const data = await window.shipwarden.github.repoPullRequests(parseRepoId(entry.id));
            if (this.requests.get(key) === request) this.setRepo(entry.id, { data, error: undefined, loading: false, loadedAt: Date.now() });
        } catch (error) {
            if (this.requests.get(key) === request) this.setRepo(entry.id, { error: errorText(error), loading: false, loadedAt: Date.now() });
        }
    }

    private setRepo(id: string, change: Partial<RepoEntry>): void {
        const key = lower(id);
        const current = this.state.repos[key] ?? { id, loading: false };
        this.set({ repos: { ...this.state.repos, [key]: { ...current, ...change } } });
    }

    private set(change: Partial<ReviewOverviewState>): void {
        this.state = { ...this.state, ...change };
        this.listeners.forEach(listener => listener());
    }
}

export const reviewOverviewStore = new ReviewOverviewStore();

/** Loads the Review data when the scope changes, and again every few minutes. */
export function useReviewOverviewLoader(ready: boolean, reviewKey: string | null | undefined, paths: string[]): void {
    useEffect(() => {
        if (ready && reviewKey !== undefined) reviewOverviewStore.setScope(reviewKey, paths);
    }, [ready, reviewKey, paths]);
    useEffect(() => {
        if (!ready) return;
        const timer = setInterval(() => reviewOverviewStore.refreshAll(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [ready]);
}

export function useReviewOverview(): ReviewOverviewState {
    return useSyncExternalStore(reviewOverviewStore.subscribe, reviewOverviewStore.get);
}

/** Returns the loaded data of one repository (see `repoId`). */
export function useRepoEntry(id: string | undefined): RepoEntry | undefined {
    const state = useReviewOverview();
    return id ? state.repos[lower(id)] : undefined;
}

/** Returns the review queue: the pull requests to review in all loaded repositories, the oldest first. */
export function useReviewQueue(): QueueItem[] {
    const { repos } = useReviewOverview();
    return useMemo(() => {
        const loaded = new Map<string, RepoPullRequests>();
        for (const entry of Object.values(repos)) {
            if (entry.data) loaded.set(entry.id, entry.data);
        }
        return reviewQueue(loaded);
    }, [repos]);
}
