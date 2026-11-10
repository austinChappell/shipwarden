import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { azureRepoOf, azureRepoRef, parseAzureRemote } from '@shared/azure-devops';
import type { DashboardPullRequests, PullRequestCommentItem } from '@shared/dashboard';
import {
    parseGitHubRemote,
    repoId,
    type BranchStatus,
    type BranchSummary,
    type GitHubOwner,
    type GitHubRepoInfo,
    type PullRequestFilter,
    type PullRequestSummary,
    type RepoRef,
    type RepoTarget
} from '@shared/github';
import type { RepoPullRequests } from '@shared/review-queue';
import {
    normalizeScope,
    pickProvider,
    providerKindName,
    type ReviewProviderChange,
    type ReviewProviderInfo,
    type ReviewProviderKind,
    type ReviewTokenSource,
    type StoredReviewProvider
} from '@shared/review-providers';
import type { SettingDefinition } from '@shared/tasks';
import { AzureDevOpsClient } from './azure/azure-client';
import { AzureDevOpsService } from './azure/azure-service';
import { GitHubClient } from './github/github-client';
import { GitHubService } from './github/github-service';
import { GitHubHost, type SourceHost } from './source-host';
import { JsonStore } from './tasks/json-store';
import { PluginSettings } from './tasks/plugin-settings';

/** Returns the URL of the "origin" remote of a worktree. */
function originUrl(root: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['remote', 'get-url', 'origin'], { cwd: root, timeout: 10000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
    });
}

/** The token of a provider is a secret setting with this key. The key is the same as the key of the old Azure DevOps token. */
const TOKEN_KEY = 'pat';
/** The secret ID of the Azure DevOps token of older versions. */
const LEGACY_AZURE_ID = 'azure-devops';
const TOKEN_DEFINITIONS: SettingDefinition[] = [{ key: TOKEN_KEY, label: 'Personal access token', type: 'secret' }];

interface GitHubRuntime {
    kind: 'github';
    client: GitHubClient;
    service: GitHubService;
    host: SourceHost;
}

interface AzureRuntime {
    kind: 'azure';
    client: AzureDevOpsClient;
    host: AzureDevOpsService;
}

type Runtime = GitHubRuntime | AzureRuntime;

export interface ReviewProvidersOptions {
    /** The file with the list of providers. */
    file: string;
    /** The file with the encrypted tokens of the providers. */
    secretsFile: string;
    /** Resolves when the trusted certificates apply (Settings › Network). */
    ready: Promise<void>;
    /** The GitHub owners of an older version (`AppSettings.reviewOwners`), for the migration at the first start. */
    legacyReviewOwners(): Promise<string[] | 'all' | undefined>;
    /** Tells the page that the list of providers changed. */
    onChanged(): void;
    /** Reads the "origin" remote of a worktree. Tests replace it. */
    readRemote?(root: string): Promise<string>;
    /**
     * Returns the repositories of the projects. Their Azure Repos remotes tell which Azure DevOps organizations to read
     * when a provider has all organizations.
     */
    projectRepos?(): Promise<string[]>;
}

/**
 * Keeps the code review providers (GitHub and Azure DevOps accounts) and selects the provider of each call.
 * Each provider has its own client and token. A worktree goes to a provider of the kind of its "origin" remote.
 * When there are more providers of that kind, the organization of the remote selects one (see `pickProvider`).
 */
export class ReviewProviders {
    private readonly store: JsonStore<{ providers?: StoredReviewProvider[] }>;
    private readonly secrets: PluginSettings;
    private readonly runtimes = new Map<string, Runtime>();
    private readonly remotes = new Map<string, Promise<string>>();
    /** The GitHub CLI account of each GitHub provider, for the token of its client. */
    private readonly accounts = new Map<string, string | undefined>();
    private seeding: Promise<StoredReviewProvider[]> | undefined;

    constructor(private readonly options: ReviewProvidersOptions) {
        this.store = new JsonStore(options.file, () => ({}));
        this.secrets = new PluginSettings(options.secretsFile);
    }

    /**
     * Returns all providers. A new user has no providers and adds them in Settings › Code review.
     * At the first start, a user of an older version gets the providers that they set up there (see `migrate`).
     */
    async providers(): Promise<StoredReviewProvider[]> {
        const current = (await this.store.get()).providers;
        if (current) return current;
        this.seeding ??= (async () => {
            const seed = await this.migrate();
            const saved = await this.store.update(value => (value.providers ? value : { ...value, providers: seed }));
            return saved.providers!;
        })();
        return this.seeding;
    }

    /**
     * Returns the providers that an older version had set up. Older versions had one GitHub provider and one Azure DevOps
     * provider. A GitHub provider comes back when the user chose organizations. An Azure DevOps provider comes back when
     * the user saved a token. It has the old ID, so it keeps that token.
     */
    private async migrate(): Promise<StoredReviewProvider[]> {
        const providers: StoredReviewProvider[] = [];
        const owners = await this.options.legacyReviewOwners();
        if (owners) {
            providers.push({ id: 'github', kind: 'github', name: 'GitHub', enabled: true, ...(Array.isArray(owners) ? { scope: owners } : {}) });
        }
        if (await this.savedToken(LEGACY_AZURE_ID)) {
            providers.push({ id: LEGACY_AZURE_ID, kind: 'azure', name: 'Azure DevOps', enabled: true });
        }
        return providers;
    }

    async list(): Promise<ReviewProviderInfo[]> {
        const providers = await this.providers();
        return Promise.all(providers.map(async provider => ({ ...provider, tokenSaved: !!(await this.savedToken(provider.id)) })));
    }

    async add(kind: ReviewProviderKind, name: string): Promise<ReviewProviderInfo> {
        if (kind !== 'github' && kind !== 'azure') {
            throw new Error(`The provider kind "${String(kind)}" is not known.`);
        }
        const provider: StoredReviewProvider = { id: randomUUID(), kind, name: name.trim() || providerKindName(kind), enabled: true };
        await this.providers();
        await this.store.update(value => ({ ...value, providers: [...(value.providers ?? []), provider] }));
        this.options.onChanged();
        return { ...provider, tokenSaved: false };
    }

    async update(id: string, change: ReviewProviderChange): Promise<void> {
        await this.providers();
        let authChanged = false;
        await this.store.update(value => ({
            ...value,
            providers: (value.providers ?? []).map(provider => {
                if (provider.id !== id) return provider;
                const next = { ...provider };
                if (typeof change.name === 'string' && change.name.trim()) next.name = change.name.trim();
                if (typeof change.enabled === 'boolean') next.enabled = change.enabled;
                if (change.scope === null) delete next.scope;
                else if (change.scope !== undefined) next.scope = normalizeScope(change.scope);
                if (change.cliAccount !== undefined) {
                    const account = typeof change.cliAccount === 'string' ? change.cliAccount.trim() : '';
                    if (account) next.cliAccount = account;
                    else delete next.cliAccount;
                    if (next.cliAccount !== provider.cliAccount) {
                        authChanged = true;
                        this.accounts.set(id, next.cliAccount);
                    }
                }
                return next;
            })
        }));
        if (authChanged) this.resetAuth(id);
        this.options.onChanged();
    }

    async remove(id: string): Promise<void> {
        await this.providers();
        await this.store.update(value => ({ ...value, providers: (value.providers ?? []).filter(provider => provider.id !== id) }));
        await this.secrets.clear(id, TOKEN_KEY);
        this.runtimes.delete(id);
        this.accounts.delete(id);
        this.options.onChanged();
    }

    async saveToken(id: string, token: string): Promise<void> {
        if (typeof token !== 'string' || !token.trim()) {
            throw new Error('The token is empty.');
        }
        await this.provider(id);
        await this.secrets.save(id, TOKEN_DEFINITIONS, { [TOKEN_KEY]: token.trim() });
        this.resetAuth(id);
        this.options.onChanged();
    }

    async clearToken(id: string): Promise<void> {
        await this.secrets.clear(id, TOKEN_KEY);
        this.resetAuth(id);
        this.options.onChanged();
    }

    /** Returns where the next request of the provider gets its token. Undefined when no token is available. */
    async tokenSource(id: string): Promise<ReviewTokenSource | undefined> {
        const runtime = await this.runtime(await this.provider(id));
        if (runtime.kind === 'github') return runtime.client.tokenSource();
        const source = await runtime.client.tokenSource();
        return source === 'az' ? 'cli' : source;
    }

    /**
     * Sends a request with the token of the provider. Returns the name of the user of the token.
     * Azure DevOps needs an organization. Without one, the first organization of the scope is used.
     */
    async test(id: string, organization?: string): Promise<string> {
        const provider = await this.provider(id);
        const runtime = await this.runtime(provider);
        if (runtime.kind === 'github') {
            return (await runtime.client.rest<{ login: string }>('GET', '/user')).login;
        }
        const name = (organization ?? '').trim() || provider.scope?.[0];
        if (!name) {
            throw new Error('Type the name of an organization.');
        }
        const data = await runtime.client.request<{ authenticatedUser?: { providerDisplayName?: string } }>(
            'GET',
            `https://dev.azure.com/${encodeURIComponent(name)}/_apis/connectionData`
        );
        return data.authenticatedUser?.providerDisplayName ?? 'unknown user';
    }

    /** Returns the user and the organizations of a GitHub provider, for its scope. */
    async githubOwners(id: string): Promise<GitHubOwner[]> {
        const runtime = await this.runtime(await this.provider(id));
        if (runtime.kind !== 'github') {
            throw new Error('Only a GitHub provider has a list of organizations.');
        }
        return runtime.service.owners();
    }

    /** Selects the provider of a target: a worktree path, or a repository of the Review view or the Pipelines view. */
    async for(target: RepoTarget): Promise<SourceHost> {
        const { kind, organization } = await this.routeOf(target);
        const provider = pickProvider(await this.providers(), kind, organization);
        if (!provider) {
            throw new Error(`No ${providerKindName(kind)} provider is on. Add one in Settings › Code review.`);
        }
        return (await this.runtime(provider)).host;
    }

    /** Returns the branch status from the provider of the worktree. Returns null when no provider is on for its remote. */
    async branchStatus(root: string): Promise<BranchStatus | null> {
        const host = await this.optionalHost(root);
        return host ? host.branchStatus(root) : null;
    }

    async branchSummaries(root: string): Promise<Record<string, BranchSummary>> {
        const host = await this.optionalHost(root);
        return host ? host.branchSummaries(root) : {};
    }

    /** Returns the GitHub repository of a worktree from its "origin" remote. Returns null for other remotes. */
    async githubRepoFor(root: string): Promise<RepoRef | null> {
        return parseGitHubRemote(await this.remoteOf(root)) ?? null;
    }

    /** Returns the GitHub or Azure Repos repository of a worktree from its "origin" remote. Returns null for other remotes. */
    async repoFor(root: string): Promise<RepoRef | null> {
        const url = await this.remoteOf(root);
        const azure = parseAzureRemote(url);
        return azure ? azureRepoRef(azure) : (parseGitHubRemote(url) ?? null);
    }

    /** Returns the open pull requests of a repository of the Review view, from the provider of its host. */
    async repoPullRequests(repo: RepoRef): Promise<RepoPullRequests> {
        const runtime = await this.runtimeFor(repo);
        return runtime.kind === 'github' ? runtime.service.repoPullRequests(repo) : runtime.host.repoPullRequests(repo);
    }

    /** Returns the pull requests of a repository of the Review view for a filter, from the provider of its host. */
    async pullRequests(repo: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]> {
        const runtime = await this.runtimeFor(repo);
        return runtime.kind === 'github' ? runtime.service.pullRequests(repo, filter, query) : runtime.host.pullRequests(repo, filter, query);
    }

    /**
     * Returns the repositories of all providers that are on, each in its scope. The newest push comes first.
     * The repositories without a push time (Azure Repos gives none) come last, in the order of their names.
     */
    async repositories(): Promise<GitHubRepoInfo[]> {
        const lists = await this.eachProvider(
            (service, provider) => service.repositories(provider.scope),
            async (host, provider) => host.repositories(provider.scope, await this.projectOrganizations())
        );
        const unique = new Map<string, GitHubRepoInfo>();
        for (const repo of lists.flat()) {
            const key = repoId(repo).toLowerCase();
            if (!unique.has(key)) unique.set(key, repo);
        }
        return [...unique.values()].sort(
            (a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '') || repoId(a).toLowerCase().localeCompare(repoId(b).toLowerCase())
        );
    }

    async dashboardPullRequests(): Promise<DashboardPullRequests> {
        const results = await this.eachProvider(
            (service, provider) => service.dashboardPullRequests(provider.scope ?? 'all'),
            async (host, provider) => host.dashboardPullRequests(provider.scope, await this.projectOrganizations())
        );
        const byUrl = <T extends { url: string; updatedAt: string }>(items: T[]) =>
            [...new Map(items.map(item => [item.url, item])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return {
            reviewRequests: byUrl(results.flatMap(result => result.reviewRequests)),
            myPullRequests: byUrl(results.flatMap(result => result.myPullRequests))
        };
    }

    async dashboardComments(): Promise<PullRequestCommentItem[]> {
        const results = await this.eachGitHub((service, provider) => service.dashboardComments(provider.scope ?? 'all'));
        return [...new Map(results.flat().map(item => [item.id, item])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    /** Returns a GitHub token for public requests, for example the update check. Undefined when there is none. */
    /**
     * Gets a file from Azure DevOps with the token of the provider of the organization.
     * Throws an error when no Azure DevOps provider is on.
     */
    async azureFile(organization: string, url: string, accept?: string): Promise<Response> {
        const provider = pickProvider(await this.providers(), 'azure', organization);
        if (!provider) {
            throw new Error('No Azure DevOps provider is on. Add one in Settings › Code review.');
        }
        return ((await this.runtime(provider)) as AzureRuntime).client.file(url, accept);
    }

    async optionalGitHubToken(): Promise<string | undefined> {
        const provider = pickProvider(await this.providers(), 'github', undefined);
        if (!provider) return process.env.GITHUB_TOKEN || undefined;
        return ((await this.runtime(provider)) as GitHubRuntime).client.optionalToken();
    }

    /**
     * Calls `call` for each GitHub provider that is on, at the same time.
     * When a call fails, the error names the provider, so that the user knows which token to fix.
     */
    private eachGitHub<T>(call: (service: GitHubService, provider: StoredReviewProvider) => Promise<T>): Promise<T[]> {
        return this.eachProvider(call);
    }

    /**
     * Calls `github` for each GitHub provider and `azure` for each Azure DevOps provider that is on, at the same time.
     * Without `azure`, the Azure DevOps providers stay out.
     * When a call fails, the error names the provider, so that the user knows which token to fix.
     */
    private async eachProvider<T>(
        github: (service: GitHubService, provider: StoredReviewProvider) => Promise<T>,
        azure?: (host: AzureDevOpsService, provider: StoredReviewProvider) => Promise<T>
    ): Promise<T[]> {
        const providers = (await this.providers()).filter(provider => provider.enabled && (provider.kind === 'github' || (provider.kind === 'azure' && azure)));
        return Promise.all(
            providers.map(async provider => {
                const runtime = await this.runtime(provider);
                try {
                    return runtime.kind === 'github' ? await github(runtime.service, provider) : await azure!(runtime.host, provider);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(providers.length > 1 ? `${provider.name}: ${message}` : message);
                }
            })
        );
    }

    /** Returns the Azure DevOps organizations of the Azure Repos remotes of the project repositories. */
    private async projectOrganizations(): Promise<string[]> {
        const repos = (await this.options.projectRepos?.().catch((): string[] => [])) ?? [];
        const organizations = await Promise.all(repos.map(async root => parseAzureRemote(await this.remoteOf(root))?.organization));
        return [...new Set(organizations.filter((name): name is string => !!name))];
    }

    /** Returns the runtime of the provider of a repository of the Review view. */
    private async runtimeFor(repo: RepoRef): Promise<Runtime> {
        const { kind, organization } = await this.routeOf(repo);
        const provider = pickProvider(await this.providers(), kind, organization);
        if (!provider) {
            throw new Error(`No ${providerKindName(kind)} provider is on. Add one in Settings › Code review.`);
        }
        return this.runtime(provider);
    }

    private async optionalHost(root: string): Promise<SourceHost | undefined> {
        const { kind, organization } = await this.routeOf(root);
        const provider = pickProvider(await this.providers(), kind, organization);
        return provider ? (await this.runtime(provider)).host : undefined;
    }

    /**
     * Returns the kind and the organization of a target. A repository of the Review view goes to the provider of its host.
     * A worktree with a remote that is not on Azure Repos goes to GitHub, as in older versions.
     */
    private async routeOf(target: RepoTarget): Promise<{ kind: ReviewProviderKind; organization?: string }> {
        if (typeof target === 'object' && target) {
            if (target.host === 'azure') return { kind: 'azure', organization: azureRepoOf(target)?.organization };
            return { kind: 'github', organization: target.owner };
        }
        const url = await this.remoteOf(String(target));
        const azure = parseAzureRemote(url);
        if (azure) return { kind: 'azure', organization: azure.organization };
        return { kind: 'github', organization: parseGitHubRemote(url)?.owner };
    }

    private remoteOf(root: string): Promise<string> {
        let remote = this.remotes.get(root);
        if (!remote) {
            const read = this.options.readRemote ?? originUrl;
            remote = read(root).catch(() => '');
            this.remotes.set(root, remote);
        }
        return remote;
    }

    private async provider(id: string): Promise<StoredReviewProvider> {
        const provider = (await this.providers()).find(item => item.id === id);
        if (!provider) {
            throw new Error('The provider does not exist. It was possibly removed.');
        }
        return provider;
    }

    private async savedToken(id: string): Promise<string | undefined> {
        const value = (await this.secrets.values(id))[TOKEN_KEY];
        return typeof value === 'string' && value ? value : undefined;
    }

    private resetAuth(id: string): void {
        const runtime = this.runtimes.get(id);
        if (runtime) runtime.client.reset();
    }

    /** Returns the client and the service of a provider. They stay for the life of the provider, so their caches stay too. */
    private async runtime(provider: StoredReviewProvider): Promise<Runtime> {
        const existing = this.runtimes.get(provider.id);
        if (existing) return existing;
        const { id } = provider;
        const savedToken = () => this.savedToken(id);
        let runtime: Runtime;
        if (provider.kind === 'github') {
            // The client reads the account at each new token, so a change of the account applies after `reset`.
            this.accounts.set(id, provider.cliAccount);
            const client = new GitHubClient({ ready: this.options.ready, savedToken, cliAccount: () => this.accounts.get(id) });
            const service = new GitHubService(client);
            const repoOf = async (target: RepoTarget): Promise<RepoRef> => {
                if (typeof target === 'object' && target && typeof target.owner === 'string' && typeof target.name === 'string') {
                    return { owner: target.owner, name: target.name };
                }
                const repo = await service.repoFor(String(target));
                if (!repo) {
                    throw new Error('The "origin" remote of this worktree is not a GitHub repository.');
                }
                return repo;
            };
            runtime = { kind: 'github', client, service, host: new GitHubHost(service, repoOf) };
        } else {
            const client = new AzureDevOpsClient({ ready: this.options.ready, savedToken });
            runtime = { kind: 'azure', client, host: new AzureDevOpsService(client) };
        }
        this.runtimes.set(id, runtime);
        return runtime;
    }
}
