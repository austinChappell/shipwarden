import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    targetKey,
    type CommitFiles,
    type FileVersions,
    type PendingComment,
    type PullRequest,
    type PullRequestFile,
    type RepoRef,
    type RepoTarget
} from '@shared/github';
import { parseAgentReview, reviewBody, reviewPrompt, type ParsedReview } from '@shared/agent-review';
import { keyRoots, queryClient } from '../query-client';
import { errorText } from '../util';

/** The state of an agent review of a pull request. */
export type AgentReviewState =
    | { status: 'running'; id: string }
    | { status: 'done'; agent: string; comments: number; notes: number }
    | { status: 'error'; error: string };

interface ReviewState {
    pending: PendingComment[];
    /** The text of the review that the user writes. It stays when the user changes tabs. */
    body: string;
    /** The review text just after the last agent review added its summary. Submit compares it with `body`. */
    agentBody?: string;
    agentReview?: AgentReviewState;
}

const EMPTY: ReviewState = { pending: [], body: '' };

/** The query keys of the pull requests in the Review view, and of their files. */
export const reviewKeys = {
    /** One pull request. `invalidatePullRequestData` reaches it. */
    pullRequest: (target: RepoTarget, number: number) => [...keyRoots.pullRequest, targetKey(target), number] as const,
    /** The changed files of a pull request. */
    files: (target: RepoTarget, number: number) => [...keyRoots.pullRequestFiles, targetKey(target), number] as const,
    /** The changed files of one commit. */
    commitFiles: (target: RepoTarget, sha: string) => [...keyRoots.pullRequestFiles, targetKey(target), 'commit', sha] as const,
    /** The base and head text of a file. The text of a commit does not change. */
    fileVersions: (target: RepoTarget, path: string, baseSha: string, headSha: string) =>
        [...keyRoots.pullRequestFiles, targetKey(target), 'versions', path, baseSha, headSha] as const
};

/** The query of one pull request. The query cache keeps it, so a pull request that opens again shows at once. */
export function pullRequestQuery(repo: RepoRef, number: number) {
    return { queryKey: reviewKeys.pullRequest(repo, number), queryFn: () => window.shipwarden.github.pullRequest(repo, number) };
}

/** Sets the viewed flag of one file in a file list. */
export function withViewed(files: PullRequestFile[], path: string, viewed: boolean): PullRequestFile[] {
    return files.map(file => (file.path === path ? { ...file, viewed } : file));
}

function key(target: RepoTarget, number: number): string {
    return `${targetKey(target)}#${number}`;
}

/**
 * Keeps the review state of each pull request that the user has open: the comments that wait for the next review,
 * the review text and the agent review. The query cache keeps the changed files and the loaded file versions.
 */
class ReviewStore {
    private readonly states = new Map<string, ReviewState>();
    private readonly listeners = new Set<() => void>();

    get(target: RepoTarget, number: number): ReviewState {
        return this.states.get(key(target, number)) ?? EMPTY;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    addPending(target: RepoTarget, number: number, comment: PendingComment): void {
        this.update(target, number, state => ({ ...state, pending: [...state.pending, comment] }));
    }

    removePending(target: RepoTarget, number: number, comment: PendingComment): void {
        this.update(target, number, state => ({ ...state, pending: state.pending.filter(item => item !== comment) }));
    }

    /** Changes the text of a pending comment. */
    updatePending(target: RepoTarget, number: number, comment: PendingComment, body: string): void {
        this.update(target, number, state => ({ ...state, pending: state.pending.map(item => (item === comment ? { ...item, body } : item)) }));
    }

    /** Accepts a comment from an agent review. The comment then goes out with the review. */
    acceptPending(target: RepoTarget, number: number, comment: PendingComment): void {
        this.update(target, number, state => ({
            ...state,
            pending: state.pending.map(item => (item === comment ? { ...item, needsDecision: undefined } : item))
        }));
    }

    /** Sets the review text. An empty text also clears `agentBody`, because no agent text is left. */
    setBody(target: RepoTarget, number: number, body: string): void {
        this.update(target, number, state => ({ ...state, body, agentBody: body ? state.agentBody : undefined }));
    }

    /**
     * Asks the agent of the repository to review the pull request. The agent posts nothing.
     * Its line comments become pending comments of the user, and its summary goes into the review text.
     * The user must accept or remove each line comment before the review can go out.
     */
    async runAgentReview(repo: RepoRef, pr: PullRequest): Promise<void> {
        if (this.get(repo, pr.number).agentReview?.status === 'running') return;
        const id = crypto.randomUUID();
        this.update(repo, pr.number, state => ({ ...state, agentReview: { status: 'running', id } }));
        try {
            const files = await this.loadFiles(repo, pr.number);
            const result = await window.shipwarden.ask.run({ id, repo, headRefOid: pr.headRefOid, prompt: reviewPrompt({ pr, repo, files }) });
            // The user can cancel the run, or start a new run, while this run works.
            if (!this.isRun(repo, pr.number, id)) return;
            this.applyAgentReview(repo, pr.number, parseAgentReview(result.answer, files), result.agent);
        } catch (error) {
            if (!this.isRun(repo, pr.number, id)) return;
            this.update(repo, pr.number, state => ({ ...state, agentReview: { status: 'error', error: errorText(error) } }));
        }
    }

    /**
     * Adds the result of an agent review to the review of the user: the line comments become pending comments, and the
     * summary goes at the end of the review text. A group review uses it for each pull request of the group.
     */
    applyAgentReview(target: RepoTarget, number: number, review: ParsedReview, agent: string): void {
        const text = reviewBody(review);
        this.update(target, number, state => {
            const body = [state.body.trim(), text].filter(Boolean).join('\n\n');
            return {
                ...state,
                pending: [...state.pending, ...review.comments],
                body,
                agentBody: text ? body : state.agentBody,
                agentReview: { status: 'done', agent, comments: review.comments.length, notes: review.unplaced.length }
            };
        });
    }

    /** Stops the agent review of a pull request. */
    cancelAgentReview(repo: RepoRef, number: number): void {
        const current = this.get(repo, number).agentReview;
        if (current?.status !== 'running') return;
        this.update(repo, number, state => ({ ...state, agentReview: undefined }));
        void window.shipwarden.ask.cancel(current.id);
    }

    /** Hides the result of the last agent review. */
    dismissAgentReview(repo: RepoRef, number: number): void {
        this.update(repo, number, state => ({ ...state, agentReview: undefined }));
    }

    private isRun(repo: RepoRef, number: number, id: string): boolean {
        const current = this.get(repo, number).agentReview;
        return current?.status === 'running' && current.id === id;
    }

    clearPending(target: RepoTarget, number: number): void {
        this.update(target, number, state => ({ ...state, pending: [] }));
    }

    /**
     * Returns the changed files of a pull request. Cached files return immediately. Stale files then load again in
     * the background. `force` loads the files now.
     */
    async loadFiles(target: RepoTarget, number: number, force = false): Promise<PullRequestFile[]> {
        const options = { queryKey: reviewKeys.files(target, number), queryFn: () => window.shipwarden.github.files(target, number) };
        return force ? queryClient.fetchQuery({ ...options, staleTime: 0 }) : queryClient.ensureQueryData({ ...options, revalidateIfStale: true });
    }

    /**
     * Marks a file as viewed or not viewed on GitHub. The list changes at once, and goes back when the request fails.
     * `pullRequestId` is the node ID of the pull request.
     */
    async setViewed(target: RepoTarget, number: number, pullRequestId: string, path: string, viewed: boolean): Promise<void> {
        const change = (value: boolean) =>
            queryClient.setQueryData<PullRequestFile[]>(reviewKeys.files(target, number), files => files && withViewed(files, path, value));
        change(viewed);
        try {
            await window.shipwarden.github.setFileViewed(target, pullRequestId, path, viewed);
        } catch (error) {
            change(!viewed);
            throw error;
        }
    }

    /** Returns the base and head text of a file. The result stays in the cache for the same commits. */
    fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
        const queryKey = reviewKeys.fileVersions(target, file.path, baseSha, headSha);
        // The text of a commit does not change. Thus a stale mark (after a change of the pull request) does not load it again.
        const cachedVersions = queryClient.getQueryData<FileVersions>(queryKey);
        if (cachedVersions) return Promise.resolve(cachedVersions);
        return queryClient.fetchQuery({
            queryKey,
            queryFn: () => window.shipwarden.github.fileVersions(target, file, baseSha, headSha),
            staleTime: Number.POSITIVE_INFINITY
        });
    }

    private update(target: RepoTarget, number: number, change: (state: ReviewState) => ReviewState): void {
        this.states.set(key(target, number), change(this.get(target, number)));
        this.listeners.forEach(listener => listener());
    }
}

export const reviewStore = new ReviewStore();

/**
 * Returns the review state of a pull request with its cached files, and renders again when they change.
 * The hook does not load the files. `reviewStore.loadFiles` loads them.
 */
export function useReviewState(target: RepoTarget | undefined, number: number | undefined): ReviewState & { files?: PullRequestFile[] } {
    const state = useSyncExternalStore(reviewStore.subscribe, () => (target && number ? reviewStore.get(target, number) : EMPTY));
    const files = useQuery({
        queryKey: reviewKeys.files(target ?? '', number ?? 0),
        queryFn: () => window.shipwarden.github.files(target as RepoTarget, number as number),
        enabled: false
    });
    return { ...state, files: target && number ? files.data : undefined };
}

/** Loads the changed files of one commit. A commit does not change, so the result stays in the cache and does not load again. */
export function useCommitFiles(target: RepoTarget, sha: string) {
    return useQuery<CommitFiles>({
        queryKey: reviewKeys.commitFiles(target, sha),
        queryFn: () => window.shipwarden.github.commitFiles(target, sha),
        staleTime: Number.POSITIVE_INFINITY
    });
}
