import { useSyncExternalStore } from 'react';
import type { PullRequest, RepoRef } from '@shared/github';
import { reviewCheckoutKey } from '@shared/review-checkout';
import { confirmDialog } from '../components/ConfirmDialog';
import { errorText } from '../util';

/** The state of the local copy of a pull request. */
export type CheckoutState =
    | { status: 'idle' }
    | { status: 'working'; cloning: boolean }
    | { status: 'ready'; root: string; sha: string }
    | { status: 'error'; error: string };

const IDLE: CheckoutState = { status: 'idle' };

/**
 * Makes the local copies of pull requests for the Review view, and keeps their state.
 * The language servers and the file explorer need the files of the pull request on disk.
 */
class ReviewCheckoutStore {
    private readonly states = new Map<string, CheckoutState>();
    private readonly running = new Map<string, Promise<string | undefined>>();
    private readonly listeners = new Set<() => void>();

    get(repo: RepoRef, number: number): CheckoutState {
        return this.states.get(reviewCheckoutKey(repo, number)) ?? IDLE;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    /**
     * Returns the folder of the copy at the head commit of the pull request. Makes or updates the copy when necessary.
     * Without a clone of the repository, it asks the user first. Returns undefined when the user does not agree or the
     * copy fails. The state has the error.
     */
    ensure(repo: RepoRef, pr: PullRequest): Promise<string | undefined> {
        const key = reviewCheckoutKey(repo, pr.number);
        const state = this.states.get(key);
        if (state?.status === 'ready' && state.sha === pr.headRefOid) return Promise.resolve(state.root);
        const current = this.running.get(key);
        if (current) return current;
        const promise = this.make(key, repo, pr).finally(() => this.running.delete(key));
        this.running.set(key, promise);
        return promise;
    }

    private async make(key: string, repo: RepoRef, pr: PullRequest): Promise<string | undefined> {
        const api = window.shipwarden.review;
        try {
            const status = await api.checkoutStatus(repo, pr.number);
            if (status.needsClone) {
                const agreed = await confirmDialog({
                    title: `Clone ${repo.owner}/${repo.name}?`,
                    message: `No project has a clone of this repository. Go to definition and the file explorer need the files on disk.\n\nShipWarden clones the repository to ~/.shipwarden/review. Git downloads the file contents only for the commits that you open.`,
                    confirmLabel: 'Clone'
                });
                if (!agreed) {
                    this.set(key, IDLE);
                    return undefined;
                }
            }
            this.set(key, { status: 'working', cloning: status.needsClone });
            const checkout = await api.checkout(repo, pr.number, pr.headRefOid, status.needsClone);
            this.set(key, { status: 'ready', root: checkout.root, sha: checkout.sha });
            return checkout.root;
        } catch (error) {
            this.set(key, { status: 'error', error: errorText(error) });
            return undefined;
        }
    }

    private set(key: string, state: CheckoutState): void {
        this.states.set(key, state);
        this.listeners.forEach(listener => listener());
    }
}

export const reviewCheckouts = new ReviewCheckoutStore();

/** The state of the local copy of a pull request. */
export function useReviewCheckout(repo: RepoRef, number: number | undefined): CheckoutState {
    return useSyncExternalStore(reviewCheckouts.subscribe, () => (number === undefined ? IDLE : reviewCheckouts.get(repo, number)));
}
