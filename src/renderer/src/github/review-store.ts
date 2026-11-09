import { useSyncExternalStore } from 'react';
import { targetKey, type FileVersions, type PendingComment, type PullRequestFile, type RepoTarget } from '@shared/github';

interface ReviewState {
    pending: PendingComment[];
    files?: PullRequestFile[];
}

const EMPTY: ReviewState = { pending: [] };

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
