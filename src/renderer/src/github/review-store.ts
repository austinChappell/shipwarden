import { useSyncExternalStore } from 'react';
import { targetKey, type FileVersions, type PendingComment, type PullRequest, type PullRequestFile, type RepoRef, type RepoTarget } from '@shared/github';
import { parseAgentReview, reviewBody, reviewPrompt } from '@shared/agent-review';
import { errorText } from '../util';

/** The state of an agent review of a pull request. */
export type AgentReviewState =
    | { status: 'running'; id: string }
    | { status: 'done'; agent: string; comments: number; notes: number }
    | { status: 'error'; error: string };

interface ReviewState {
    pending: PendingComment[];
    files?: PullRequestFile[];
    /** The text of the review that the user writes. It stays when the user changes tabs. */
    body: string;
    agentReview?: AgentReviewState;
}

const EMPTY: ReviewState = { pending: [], body: '' };

function key(target: RepoTarget, number: number): string {
    return `${targetKey(target)}#${number}`;
}

/**
 * Keeps the review state of each pull request that the user has open:
 * the comments that wait for the next review, the changed files and the loaded file versions.
 */
class ReviewStore {
    private readonly states = new Map<string, ReviewState>();
    private readonly versions = new Map<string, Promise<FileVersions>>();
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

    setBody(target: RepoTarget, number: number, body: string): void {
        this.update(target, number, state => ({ ...state, body }));
    }

    /**
     * Asks the agent of the repository to review the pull request. The agent posts nothing.
     * Its line comments become pending comments of the user, and its summary goes into the review text.
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
            const review = parseAgentReview(result.answer, files);
            const text = reviewBody(review);
            this.update(repo, pr.number, state => ({
                ...state,
                pending: [...state.pending, ...review.comments],
                body: [state.body.trim(), text].filter(Boolean).join('\n\n'),
                agentReview: { status: 'done', agent: result.agent, comments: review.comments.length, notes: review.unplaced.length }
            }));
        } catch (error) {
            if (!this.isRun(repo, pr.number, id)) return;
            this.update(repo, pr.number, state => ({ ...state, agentReview: { status: 'error', error: errorText(error) } }));
        }
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

    async loadFiles(target: RepoTarget, number: number, force = false): Promise<PullRequestFile[]> {
        const current = this.get(target, number).files;
        if (current && !force) {
            return current;
        }
        const files = await window.shipwarden.github.files(target, number);
        this.update(target, number, state => ({ ...state, files }));
        return files;
    }

    /**
     * Marks a file as viewed or not viewed on GitHub. The list changes at once, and goes back when the request fails.
     * `pullRequestId` is the node ID of the pull request.
     */
    async setViewed(target: RepoTarget, number: number, pullRequestId: string, path: string, viewed: boolean): Promise<void> {
        const change = (value: boolean) => this.update(target, number, state => ({
            ...state,
            files: state.files?.map(file => (file.path === path ? { ...file, viewed: value } : file))
        }));
        change(viewed);
        try {
            await window.shipwarden.github.setFileViewed(target, pullRequestId, path, viewed);
        } catch (error) {
            change(!viewed);
            throw error;
        }
    }

    /** Returns the base and head text of a file. The result stays in memory for the same commits. */
    fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
        const id = `${targetKey(target)}\0${file.path}\0${baseSha}\0${headSha}`;
        let promise = this.versions.get(id);
        if (!promise) {
            promise = window.shipwarden.github.fileVersions(target, file, baseSha, headSha);
            promise.catch(() => this.versions.delete(id));
            this.versions.set(id, promise);
        }
        return promise;
    }

    private update(target: RepoTarget, number: number, change: (state: ReviewState) => ReviewState): void {
        this.states.set(key(target, number), change(this.get(target, number)));
        this.listeners.forEach(listener => listener());
    }
}

export const reviewStore = new ReviewStore();

/** Returns the review state of a pull request and renders again when it changes. */
export function useReviewState(target: RepoTarget | undefined, number: number | undefined): ReviewState {
    return useSyncExternalStore(reviewStore.subscribe, () => (target && number ? reviewStore.get(target, number) : EMPTY));
}
