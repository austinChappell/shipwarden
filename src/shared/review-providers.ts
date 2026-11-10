/** The kinds of code review provider. Each kind has its own API and its own remote URL format. */
export type ReviewProviderKind = 'github' | 'azure';

export const REVIEW_PROVIDER_KINDS: { kind: ReviewProviderKind; name: string }[] = [
    { kind: 'github', name: 'GitHub' },
    { kind: 'azure', name: 'Azure DevOps' }
];

export function providerKindName(kind: ReviewProviderKind): string {
    return REVIEW_PROVIDER_KINDS.find(item => item.kind === kind)?.name ?? kind;
}

/** One code review provider, as the main process keeps it. The token is not in this object. */
export interface StoredReviewProvider {
    id: string;
    kind: ReviewProviderKind;
    name: string;
    enabled: boolean;
    /** The organizations of the provider. Undefined means all organizations. */
    scope?: string[];
    /** GitHub only: the account of the GitHub CLI to get the token from. Undefined means the active account. */
    cliAccount?: string;
}

/** One code review provider, for Settings › Code review. The page never gets the token. */
export interface ReviewProviderInfo extends StoredReviewProvider {
    /** True when a personal access token is saved for this provider. */
    tokenSaved: boolean;
}

/** A change to a provider. Null removes the value. */
export interface ReviewProviderChange {
    name?: string;
    enabled?: boolean;
    scope?: string[] | null;
    cliAccount?: string | null;
}

/** Where the token of the next request of a provider comes from. */
export type ReviewTokenSource = 'saved' | 'env' | 'cli';

/**
 * Selects the provider for an organization. The order is:
 * 1. The first enabled provider of the kind whose scope has the organization.
 * 2. The first enabled provider of the kind with all organizations.
 * 3. The first enabled provider of the kind.
 * The match ignores case. Returns undefined when no provider of the kind is enabled.
 */
export function pickProvider<T extends StoredReviewProvider>(providers: T[], kind: ReviewProviderKind, organization: string | undefined): T | undefined {
    const candidates = providers.filter(provider => provider.enabled && provider.kind === kind);
    const wanted = organization?.toLowerCase();
    return (
        (wanted ? candidates.find(provider => provider.scope?.some(item => item.toLowerCase() === wanted)) : undefined) ??
        candidates.find(provider => !provider.scope) ??
        candidates[0]
    );
}

/** A short text for the scope of a provider, for example "All organizations" or "2 organizations". */
export function providerScopeSummary(scope: string[] | undefined): string {
    if (!scope) return 'All organizations';
    return `${scope.length} organization${scope.length === 1 ? '' : 's'}`;
}

/** Removes empty and repeated names from a scope. The match ignores case. */
export function normalizeScope(scope: unknown): string[] | undefined {
    if (!Array.isArray(scope)) return undefined;
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of scope) {
        if (typeof item !== 'string') continue;
        const name = item.trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        result.push(name);
    }
    return result;
}
