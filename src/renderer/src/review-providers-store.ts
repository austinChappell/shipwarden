import { useEffect, useSyncExternalStore } from 'react';
import type { ReviewProviderInfo } from '@shared/review-providers';

/** Keeps the list of code review providers for the whole page. It loads again when the main process changes the list. */
class ReviewProvidersStore {
    private providers: ReviewProviderInfo[] | undefined;
    private error: string | undefined;
    private loading: Promise<void> | undefined;
    private readonly listeners = new Set<() => void>();
    private unsubscribe: (() => void) | undefined;

    get = (): ReviewProviderInfo[] | undefined => this.providers;

    getError = (): string | undefined => this.error;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        this.unsubscribe ??= window.shipwarden.reviewProviders.onChanged(() => void this.reload());
        return () => this.listeners.delete(listener);
    };

    load(): Promise<void> {
        this.loading ??= this.reload();
        return this.loading;
    }

    async reload(): Promise<void> {
        try {
            this.providers = await window.shipwarden.reviewProviders.list();
            this.error = undefined;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }
        this.listeners.forEach(listener => listener());
    }
}

export const reviewProvidersStore = new ReviewProvidersStore();

/** Returns the code review providers. Undefined until the first load. */
export function useReviewProviders(): ReviewProviderInfo[] | undefined {
    useEffect(() => {
        void reviewProvidersStore.load();
    }, []);
    return useSyncExternalStore(reviewProvidersStore.subscribe, reviewProvidersStore.get);
}

/**
 * Returns a key for the GitHub providers that are on and their scopes. The key changes when the repositories
 * of the Review view can change. Undefined: the list did not load yet. Null: no GitHub provider is on.
 */
export function githubScopeKey(providers: ReviewProviderInfo[] | undefined): string | null | undefined {
    if (!providers) return undefined;
    const github = providers.filter(provider => provider.enabled && provider.kind === 'github');
    if (github.length === 0) return null;
    return JSON.stringify(github.map(provider => [provider.id, provider.scope ?? null, provider.cliAccount ?? null, provider.tokenSaved]));
}
