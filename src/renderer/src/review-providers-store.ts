import { useEffect } from 'react';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import type { ReviewProviderChange, ReviewProviderInfo } from '@shared/review-providers';
import { keyRoots, queryClient } from './query-client';

/** The query keys of the code review providers. */
export const reviewProviderKeys = {
    /** The providers of Settings › Code review. */
    list: [...keyRoots.reviewProviders, 'list'] as const,
    /** Where the next request of a provider gets its token. */
    tokenSource: (id: string) => [...keyRoots.reviewProviders, 'tokenSource', id] as const,
    /** The user and the organizations of a GitHub provider. */
    githubOwners: (id: string) => [...keyRoots.reviewProviders, 'githubOwners', id] as const
};

/**
 * The query of the provider list. The main process sends a change event after each change of the list, so the
 * list stays fresh until that event.
 */
const listQuery = queryOptions({
    queryKey: reviewProviderKeys.list,
    queryFn: () => window.shipwarden.reviewProviders.list(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false
});

let listening = false;

/** Starts to listen for the change events of the main process. The page listens one time, for the whole session. */
function listenForChanges(): void {
    if (listening) return;
    listening = true;
    window.shipwarden.reviewProviders.onChanged(() => void queryClient.invalidateQueries({ queryKey: reviewProviderKeys.list }));
}

/** Gives access to the provider list outside React. The query cache keeps the list. */
export const reviewProvidersStore = {
    /** Returns the cached list. Undefined until the first load. */
    get: (): ReviewProviderInfo[] | undefined => queryClient.getQueryData(listQuery.queryKey),
    /** Loads the list, if the cache does not have it. */
    load: async (): Promise<void> => {
        listenForChanges();
        await queryClient.ensureQueryData(listQuery);
    },
    /** Loads the list again. */
    reload: (): Promise<void> => queryClient.refetchQueries({ queryKey: listQuery.queryKey })
};

/** Returns the code review providers. Undefined until the first load. */
export function useReviewProviders(): ReviewProviderInfo[] | undefined {
    useEffect(listenForChanges, []);
    return useQuery(listQuery).data;
}

/**
 * Returns a key for the providers that are on (GitHub and Azure DevOps) and their scopes. The key changes when the
 * repositories of the Review view can change. Undefined: the list did not load yet. Null: no provider is on.
 */
export function reviewScopeKey(providers: ReviewProviderInfo[] | undefined): string | null | undefined {
    if (!providers) return undefined;
    const enabled = providers.filter(provider => provider.enabled);
    if (enabled.length === 0) return null;
    return JSON.stringify(enabled.map(provider => [provider.id, provider.kind, provider.scope ?? null, provider.cliAccount ?? null, provider.tokenSaved]));
}

/** The provider with the change. Null removes the scope or the CLI account. */
export function applyProviderChange(provider: ReviewProviderInfo, change: ReviewProviderChange): ReviewProviderInfo {
    const next: ReviewProviderInfo = { ...provider };
    if (typeof change.name === 'string' && change.name.trim()) next.name = change.name.trim();
    if (typeof change.enabled === 'boolean') next.enabled = change.enabled;
    if (change.scope === null) delete next.scope;
    else if (change.scope !== undefined) next.scope = change.scope;
    if (change.cliAccount !== undefined) {
        const account = change.cliAccount?.trim();
        if (account) next.cliAccount = account;
        else delete next.cliAccount;
    }
    return next;
}

/**
 * True when the change can change the repositories, the pull requests and the pipelines that the user sees.
 * A new name changes none of them. A change of a provider that is off changes none of them, except when the change turns it on.
 */
export function changeAffectsRepos(provider: ReviewProviderInfo | undefined, change: ReviewProviderChange): boolean {
    if (change.enabled !== undefined && change.enabled !== provider?.enabled) return true;
    if (provider && !provider.enabled) return false;
    return change.scope !== undefined || change.cliAccount !== undefined;
}

/**
 * Marks the GitHub and Azure DevOps data and the Dashboard as stale. The data that shows now loads again. A request
 * that runs continues and does not start again. The GitHub repository of a local repository comes from git, so it stays.
 */
function invalidateRepoData(client: QueryClient): void {
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'github' && query.queryKey[1] !== keyRoots.repoOf[1] }, { cancelRefetch: false });
    void client.invalidateQueries({ queryKey: keyRoots.dashboard }, { cancelRefetch: false });
}

/** Marks the token state and the organizations of a provider as stale. */
function invalidateAuth(client: QueryClient, id: string): void {
    void client.invalidateQueries({ queryKey: reviewProviderKeys.tokenSource(id) });
    void client.invalidateQueries({ queryKey: reviewProviderKeys.githubOwners(id) });
}

/** Updates the cache after a new provider. A new provider is on and can use the CLI login, so the repository data is stale. */
export function providerAdded(client: QueryClient, created: ReviewProviderInfo): void {
    client.setQueryData<ReviewProviderInfo[]>(reviewProviderKeys.list, list => list && [...list, created]);
    invalidateRepoData(client);
}

/** Updates the cache after a change of a provider. `provider` is the state before the change. */
export function providerChanged(client: QueryClient, provider: ReviewProviderInfo, change: ReviewProviderChange): void {
    client.setQueryData<ReviewProviderInfo[]>(reviewProviderKeys.list, list =>
        list?.map(item => (item.id === provider.id ? applyProviderChange(item, change) : item))
    );
    if (change.cliAccount !== undefined) invalidateAuth(client, provider.id);
    if (changeAffectsRepos(provider, change)) invalidateRepoData(client);
}

/** Updates the cache after a save or a removal of the token of a provider. */
export function providerTokenChanged(client: QueryClient, provider: ReviewProviderInfo, tokenSaved: boolean): void {
    client.setQueryData<ReviewProviderInfo[]>(reviewProviderKeys.list, list => list?.map(item => (item.id === provider.id ? { ...item, tokenSaved } : item)));
    invalidateAuth(client, provider.id);
    if (provider.enabled) invalidateRepoData(client);
}

/** Updates the cache after the removal of a provider. */
export function providerRemoved(client: QueryClient, provider: ReviewProviderInfo): void {
    client.setQueryData<ReviewProviderInfo[]>(reviewProviderKeys.list, list => list?.filter(item => item.id !== provider.id));
    client.removeQueries({ queryKey: reviewProviderKeys.tokenSource(provider.id) });
    client.removeQueries({ queryKey: reviewProviderKeys.githubOwners(provider.id) });
    if (provider.enabled) invalidateRepoData(client);
}
