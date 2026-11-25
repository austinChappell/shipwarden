import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { azureRepoOf, azureRepoRef, parseAzureRemote } from '@shared/azure-devops';
import { bitbucketRepoOf, bitbucketRepoRef, parseBitbucketRemote } from '@shared/bitbucket';
import type { DashboardPullRequests, PipelineApprovalItem, PipelineApprovalTarget, PullRequestCommentItem } from '@shared/dashboard';
import { giteaHostOf, giteaRepoOf, giteaRepoRef, normalizeGiteaUrl, parseGiteaRemote, parseServerVersion, remoteServerGuess } from '@shared/gitea';
import { gitlabHostOf, gitlabRepoOf, gitlabRepoRef, normalizeGitLabUrl, parseGitLabRemote, topGroupOf } from '@shared/gitlab';
import {
    parseGitHubRemote,
    repoId,
    type BranchStatus,
    type BranchSummary,
    type MergedPullRequest,
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
import { BitbucketClient } from './bitbucket/bitbucket-client';
import { BitbucketService } from './bitbucket/bitbucket-service';
import { GiteaClient } from './gitea/gitea-client';
import { GiteaService } from './gitea/gitea-service';
import { GitHubClient } from './github/github-client';
import { GitHubService } from './github/github-service';
import { GitLabClient } from './gitlab/gitlab-client';
import { GitLabService } from './gitlab/gitlab-service';
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

interface GitLabRuntime {
    kind: 'gitlab';
    client: GitLabClient;
    host: GitLabService;
}

interface BitbucketRuntime {
    kind: 'bitbucket';
    client: BitbucketClient;
    host: BitbucketService;
}

interface GiteaRuntime {
    kind: 'gitea';
    client: GiteaClient;
    host: GiteaService;
}

type Runtime = GitHubRuntime | AzureRuntime | GitLabRuntime | BitbucketRuntime | GiteaRuntime;

/**
 * The kind of a target, its organization (a GitLab group, a Bitbucket workspace, or a Gitea owner), and the host of a
 * GitLab, Gitea, or Forgejo server.
 */
interface Route {
    kind: ReviewProviderKind;
    organization?: string;
    /** GitLab, Gitea, and Forgejo only: the host of the server, for example "gitlab.com" or "codeberg.org". */
    server?: string;
}

/** The host of the server of a GitLab, Gitea, or Forgejo provider. */
function serverOf(provider: StoredReviewProvider): string | undefined {
    return provider.kind === 'gitea' ? giteaHostOf(provider.baseUrl) : gitlabHostOf(provider.baseUrl);
}

/** The time that ShipWarden waits for the answer of a possible Gitea or Forgejo server. */
const PROBE_TIMEOUT_MS = 3000;

/** True when the server answers "/api/v1/version" with a version, as Gitea and Forgejo do. The request has no token. */
async function probeGitea(baseUrl: string): Promise<boolean> {
    try {
        const response = await fetch(`${baseUrl}/api/v1/version`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!response.ok) return false;
        const data = (await response.json()) as { version?: unknown };
        return typeof data?.version === 'string' && data.version !== '';
    } catch {
        return false;
    }
}

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
    /** True when a base URL is a Gitea or Forgejo server. Tests replace it. The default asks "/api/v1/version". */
    probeGitea?(baseUrl: string): Promise<boolean>;
}

/**
 * Keeps the code review providers (GitHub, Azure DevOps, GitLab, Bitbucket, and Gitea or Forgejo accounts) and selects
 * the provider of each call.
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
    /** The username of each Bitbucket provider, for the Basic auth of its client. */
    private readonly usernames = new Map<string, string | undefined>();
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
        if (kind !== 'github' && kind !== 'azure' && kind !== 'gitlab' && kind !== 'bitbucket' && kind !== 'gitea') {
            throw new Error(`The provider kind "${String(kind)}" is not known.`);
        }
        const provider: StoredReviewProvider = { id: randomUUID(), kind, name: name.trim() || providerKindName(kind), enabled: true };
        if (kind === 'gitea') {
            const baseUrl = await this.detectGiteaServer();
            if (baseUrl) provider.baseUrl = baseUrl;
        }
        await this.providers();
        await this.store.update(value => ({ ...value, providers: [...(value.providers ?? []), provider] }));
        this.options.onChanged();
        return { ...provider, tokenSaved: false };
    }

    async update(id: string, change: ReviewProviderChange): Promise<void> {
        await this.providers();
        let authChanged = false;
        let serverChanged = false;
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
                if (change.baseUrl !== undefined && provider.kind === 'gitea') {
                    const url = typeof change.baseUrl === 'string' ? normalizeGiteaUrl(change.baseUrl) : undefined;
                    if (typeof change.baseUrl === 'string' && change.baseUrl.trim() && !url) {
                        throw new Error(`"${change.baseUrl}" is not a valid URL.`);
                    }
                    if (url) next.baseUrl = url;
                    else delete next.baseUrl;
                    serverChanged = next.baseUrl !== provider.baseUrl;
                }
                if (change.baseUrl !== undefined && provider.kind === 'gitlab') {
                    const url = typeof change.baseUrl === 'string' ? normalizeGitLabUrl(change.baseUrl) : undefined;
                    if (typeof change.baseUrl === 'string' && change.baseUrl.trim() && !url) {
                        throw new Error(`"${change.baseUrl}" is not a valid URL.`);
                    }
                    if (url && url !== 'https://gitlab.com') next.baseUrl = url;
                    else delete next.baseUrl;
                    serverChanged = next.baseUrl !== provider.baseUrl;
                }
                if (change.username !== undefined && provider.kind === 'bitbucket') {
                    const username = typeof change.username === 'string' ? change.username.trim() : '';
                    if (username) next.username = username;
                    else delete next.username;
                    if (next.username !== provider.username) {
                        authChanged = true;
                        this.usernames.set(id, next.username);
                    }
                }
                return next;
            })
        }));
        if (authChanged) this.resetAuth(id);
        // The client and the service of a GitLab, Gitea, or Forgejo provider belong to one server. A new server gets a new runtime.
        if (serverChanged) this.runtimes.delete(id);
        this.options.onChanged();
    }

    async remove(id: string): Promise<void> {
        await this.providers();
        await this.store.update(value => ({ ...value, providers: (value.providers ?? []).filter(provider => provider.id !== id) }));
        await this.secrets.clear(id, TOKEN_KEY);
        this.runtimes.delete(id);
        this.accounts.delete(id);
        this.usernames.delete(id);
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
        if (runtime.kind !== 'azure') return runtime.client.tokenSource();
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
        if (runtime.kind === 'gitlab') {
            return (await runtime.client.request<{ username: string }>('GET', '/user')).username;
        }
        if (runtime.kind === 'bitbucket') {
            const user = await runtime.client.request<{ nickname?: string; display_name?: string }>('GET', '/user');
            return user.display_name || user.nickname || 'unknown user';
        }
        if (runtime.kind === 'gitea') {
            const [user, version] = await Promise.all([runtime.client.request<{ login: string }>('GET', '/user'), runtime.client.version().catch(() => '')]);
            const server = version ? parseServerVersion(version) : undefined;
            return server ? `${user.login} (${server.product} ${server.version})` : user.login;
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
        return (await this.runtimeFor(target)).host;
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

    /** Returns the newest merged pull request of each branch. Returns an empty map when no provider is on for the remote. */
    async mergedBranches(root: string): Promise<Record<string, MergedPullRequest>> {
        const host = await this.optionalHost(root);
        return host ? host.mergedBranches(root) : {};
    }

    /** Returns the GitHub repository of a worktree from its "origin" remote. Returns null for other remotes. */
    async githubRepoFor(root: string): Promise<RepoRef | null> {
        return parseGitHubRemote(await this.remoteOf(root)) ?? null;
    }

    /**
     * Returns the GitHub, Azure Repos, GitLab, Bitbucket, Gitea, or Forgejo repository of a worktree from its "origin"
     * remote. Returns null for other remotes.
     */
    async repoFor(root: string): Promise<RepoRef | null> {
        const url = await this.remoteOf(root);
        const azure = parseAzureRemote(url);
        if (azure) return azureRepoRef(azure);
        const bitbucket = parseBitbucketRemote(url);
        if (bitbucket) return bitbucketRepoRef(bitbucket);
        const gitlab = parseGitLabRemote(url, await this.gitlabServers());
        if (gitlab) return gitlabRepoRef(gitlab);
        const gitea = parseGiteaRemote(url, await this.giteaServers());
        return gitea ? giteaRepoRef(gitea) : (parseGitHubRemote(url) ?? null);
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
            async (host, provider) => host.repositories(provider.scope, await this.projectOrganizations()),
            (host, provider) => host.repositories(provider.scope),
            (host, provider) => host.repositories(provider.scope),
            (host, provider) => host.repositories(provider.scope)
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
            async (host, provider) => host.dashboardPullRequests(provider.scope, await this.projectOrganizations()),
            (host, provider) => host.dashboardPullRequests(provider.scope),
            (host, provider) => host.dashboardPullRequests(provider.scope),
            (host, provider) => host.dashboardPullRequests(provider.scope)
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

    /**
     * Returns the pipeline runs that wait for the approval of the user: in the GitHub repositories of the projects, and
     * in the Azure DevOps organizations of the providers. GitHub has no search for these runs, so the Dashboard reads only
     * the GitHub repositories of the projects. A repository or an organization that fails gives no items and no error.
     */
    async dashboardApprovals(): Promise<PipelineApprovalItem[]> {
        const [github, azure] = await Promise.all([
            this.githubApprovals(),
            this.eachProvider(
                async (): Promise<PipelineApprovalItem[]> => [],
                async (host, provider) => host.dashboardApprovals(provider.scope, await this.projectOrganizations()).catch(() => [])
            ).catch((): PipelineApprovalItem[][] => [])
        ]);
        const unique = new Map([...github, ...azure.flat()].map(item => [item.id, item]));
        return [...unique.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    /** Approves a pipeline run, with the provider of its repository or organization. */
    async approvePipeline(target: PipelineApprovalTarget): Promise<void> {
        if (target.kind === 'github') {
            const runtime = await this.runtimeFor(target.repo);
            if (runtime.kind !== 'github') throw new Error(`${target.repo.owner}/${target.repo.name} is not a GitHub repository.`);
            return runtime.service.approveDeployments(target.repo, target.runId, target.environmentIds);
        }
        const provider = pickProvider(await this.providers(), 'azure', target.organization);
        if (!provider) {
            throw new Error('No Azure DevOps provider is on. Add one in Settings › Code review.');
        }
        return ((await this.runtime(provider)) as AzureRuntime).host.approvePipeline(target.organization, target.project, target.approvalIds);
    }

    /** Returns the runs that wait for the approval of the user, in the GitHub repositories of the projects. */
    private async githubApprovals(): Promise<PipelineApprovalItem[]> {
        const roots = (await this.options.projectRepos?.().catch((): string[] => [])) ?? [];
        const repos = new Map<string, RepoRef>();
        await Promise.all(
            roots.map(async root => {
                const repo = await this.repoFor(root).catch(() => null);
                if (repo && !repo.host) repos.set(repoId(repo).toLowerCase(), repo);
            })
        );
        const lists = await Promise.all(
            [...repos.values()].map(async repo => {
                try {
                    const runtime = await this.runtimeFor(repo);
                    return runtime.kind === 'github' ? await runtime.service.pendingApprovals(repo) : [];
                } catch {
                    return [];
                }
            })
        );
        return lists.flat();
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

    /**
     * Returns the place of the GitHub token for the setup check, or undefined when there is no token. It does not call the
     * GitHub API. Without a GitHub provider, a client without a saved token uses the same order: GITHUB_TOKEN, then the
     * GitHub CLI.
     */
    async githubTokenSource(): Promise<ReviewTokenSource | undefined> {
        const provider = pickProvider(await this.providers(), 'github', undefined);
        if (!provider) return new GitHubClient({ ready: this.options.ready }).tokenSource();
        return ((await this.runtime(provider)) as GitHubRuntime).client.tokenSource();
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
     * Calls `github` for each GitHub provider, `azure` for each Azure DevOps provider, `gitlab` for each GitLab provider,
     * `bitbucket` for each Bitbucket provider, and `gitea` for each Gitea or Forgejo provider that is on, at the same
     * time. Without a callback for a kind, the providers of that kind stay out.
     * When a call fails, the error names the provider, so that the user knows which token to fix.
     */
    private async eachProvider<T>(
        github: (service: GitHubService, provider: StoredReviewProvider) => Promise<T>,
        azure?: (host: AzureDevOpsService, provider: StoredReviewProvider) => Promise<T>,
        gitlab?: (host: GitLabService, provider: StoredReviewProvider) => Promise<T>,
        bitbucket?: (host: BitbucketService, provider: StoredReviewProvider) => Promise<T>,
        gitea?: (host: GiteaService, provider: StoredReviewProvider) => Promise<T>
    ): Promise<T[]> {
        const providers = (await this.providers()).filter(
            provider =>
                provider.enabled &&
                (provider.kind === 'github' ||
                    (provider.kind === 'azure' && azure) ||
                    (provider.kind === 'gitlab' && gitlab) ||
                    (provider.kind === 'bitbucket' && bitbucket) ||
                    (provider.kind === 'gitea' && gitea))
        );
        return Promise.all(
            providers.map(async provider => {
                const runtime = await this.runtime(provider);
                try {
                    if (runtime.kind === 'github') return await github(runtime.service, provider);
                    if (runtime.kind === 'azure') return await azure!(runtime.host, provider);
                    if (runtime.kind === 'gitlab') return await gitlab!(runtime.host, provider);
                    if (runtime.kind === 'gitea') return await gitea!(runtime.host, provider);
                    return await bitbucket!(runtime.host, provider);
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

    /** Returns the runtime of the provider of a target. Throws an error when no provider of its kind is on. */
    private async runtimeFor(target: RepoTarget): Promise<Runtime> {
        const route = await this.routeOf(target);
        const provider = await this.pick(route);
        if (!provider) {
            const where = (route.kind === 'gitlab' || route.kind === 'gitea') && route.server ? ` for ${route.server}` : '';
            throw new Error(`No ${providerKindName(route.kind)} provider${where} is on. Add one in Settings › Code review.`);
        }
        return this.runtime(provider);
    }

    private async optionalHost(root: string): Promise<SourceHost | undefined> {
        const provider = await this.pick(await this.routeOf(root));
        return provider ? (await this.runtime(provider)).host : undefined;
    }

    /** Selects the provider of a route. A GitLab, Gitea, or Forgejo route takes only the providers of its server. */
    private async pick(route: Route): Promise<StoredReviewProvider | undefined> {
        const providers = await this.providers();
        const candidates =
            route.kind === 'gitlab' || route.kind === 'gitea'
                ? providers.filter(provider => provider.kind !== route.kind || serverOf(provider) === route.server)
                : providers;
        return pickProvider(candidates, route.kind, route.organization);
    }

    /** The base URLs of the GitLab servers of the providers. gitlab.com is always a server (see `parseGitLabRemote`). */
    private async gitlabServers(): Promise<string[]> {
        return (await this.providers()).flatMap(provider => (provider.kind === 'gitlab' && provider.baseUrl ? [provider.baseUrl] : []));
    }

    /** The base URLs of the Gitea and Forgejo servers of the providers. */
    private async giteaServers(): Promise<string[]> {
        return (await this.providers()).flatMap(provider => (provider.kind === 'gitea' && provider.baseUrl ? [provider.baseUrl] : []));
    }

    /**
     * Finds the server of a new Gitea or Forgejo provider from the "origin" remotes of the project repositories.
     * A remote that no provider knows (not GitHub, Azure Repos, Bitbucket, a GitLab server, or a Gitea server of a
     * provider) gives a possible server. The first possible server that answers as Gitea or Forgejo wins.
     * Returns undefined when no server answers.
     */
    private async detectGiteaServer(): Promise<string | undefined> {
        const roots = (await this.options.projectRepos?.().catch((): string[] => [])) ?? [];
        const [gitlabServers, giteaServers] = await Promise.all([this.gitlabServers(), this.giteaServers()]);
        const guesses = new Set<string>();
        for (const root of roots) {
            const url = await this.remoteOf(root);
            if (!url || parseGitHubRemote(url) || parseAzureRemote(url) || parseBitbucketRemote(url)) continue;
            if (parseGitLabRemote(url, gitlabServers) || parseGiteaRemote(url, giteaServers)) continue;
            const guess = remoteServerGuess(url);
            if (guess) guesses.add(guess);
        }
        if (guesses.size === 0) return undefined;
        await this.options.ready;
        const probe = this.options.probeGitea ?? probeGitea;
        const list = [...guesses].slice(0, 5);
        const answers = await Promise.all(list.map(url => probe(url).catch(() => false)));
        return list.find((_, index) => answers[index]);
    }

    /**
     * Returns the kind and the organization of a target. A repository of the Review view goes to the provider of its host.
     * A worktree with a remote that is not on Azure Repos, on Bitbucket, on a GitLab server, or on a Gitea or Forgejo
     * server goes to GitHub, as in older versions.
     */
    private async routeOf(target: RepoTarget): Promise<Route> {
        if (typeof target === 'object' && target) {
            if (target.host === 'azure') return { kind: 'azure', organization: azureRepoOf(target)?.organization };
            if (target.host === 'gitlab') {
                const gitlab = gitlabRepoOf(target);
                return { kind: 'gitlab', organization: gitlab && topGroupOf(gitlab.namespace), server: gitlab?.host };
            }
            if (target.host === 'bitbucket') return { kind: 'bitbucket', organization: bitbucketRepoOf(target)?.workspace };
            if (target.host === 'gitea') {
                const gitea = giteaRepoOf(target);
                return { kind: 'gitea', organization: gitea?.owner, server: gitea?.host };
            }
            return { kind: 'github', organization: target.owner };
        }
        const url = await this.remoteOf(String(target));
        const azure = parseAzureRemote(url);
        if (azure) return { kind: 'azure', organization: azure.organization };
        const bitbucket = parseBitbucketRemote(url);
        if (bitbucket) return { kind: 'bitbucket', organization: bitbucket.workspace };
        const gitlab = parseGitLabRemote(url, await this.gitlabServers());
        if (gitlab) return { kind: 'gitlab', organization: topGroupOf(gitlab.namespace), server: gitlab.host };
        const gitea = parseGiteaRemote(url, await this.giteaServers());
        if (gitea) return { kind: 'gitea', organization: gitea.owner, server: gitea.host };
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
        } else if (provider.kind === 'gitlab') {
            const baseUrl = provider.baseUrl;
            const client = new GitLabClient({ ready: this.options.ready, savedToken, baseUrl: () => baseUrl });
            runtime = { kind: 'gitlab', client, host: new GitLabService(client, root => this.remoteOf(root)) };
        } else if (provider.kind === 'gitea') {
            const baseUrl = provider.baseUrl;
            const client = new GiteaClient({ ready: this.options.ready, savedToken, baseUrl: () => baseUrl });
            runtime = { kind: 'gitea', client, host: new GiteaService(client, root => this.remoteOf(root)) };
        } else if (provider.kind === 'bitbucket') {
            // The client reads the username at each new token, so a change of the username applies after `reset`.
            this.usernames.set(id, provider.username);
            const client = new BitbucketClient({ ready: this.options.ready, savedToken, username: () => this.usernames.get(id) });
            runtime = { kind: 'bitbucket', client, host: new BitbucketService(client, root => this.remoteOf(root)) };
        } else {
            const client = new AzureDevOpsClient({ ready: this.options.ready, savedToken });
            runtime = { kind: 'azure', client, host: new AzureDevOpsService(client) };
        }
        this.runtimes.set(id, runtime);
        return runtime;
    }
}
