import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    azureCreatePullRequestUrl,
    azureOrgUrl,
    azureProjectApi,
    azureRepoOf,
    azureRepoRef,
    decodeAzureId,
    fromRefName,
    parseAzureRemote,
    toRefName,
    voteForEvent,
    type AzureRepoRef
} from '@shared/azure-devops';
import type { DashboardPullRequests, MyPullRequestItem, ReviewRequestItem } from '@shared/dashboard';
import {
    type CommitFiles,
    cleanActionsLog,
    type BranchStatus,
    type BranchSummary,
    type CheckRun,
    type FileVersions,
    type GitHubRepoInfo,
    type GitHubUser,
    type JobProgress,
    type MergeMethod,
    type NewPullRequest,
    type PendingComment,
    type PullRequest,
    type IssueReference,
    type PullRequestCandidates,
    type PullRequestChange,
    type PullRequestFile,
    type PullRequestFilter,
    type PullRequestSummary,
    type ReactionContent,
    type RepoRef,
    type RepoTarget,
    type ReviewEvent,
    type Workflow
} from '@shared/github';
import type { WorkflowRun } from '@shared/pipelines';
import { matchesSearch, type RepoPullRequests } from '@shared/review-queue';
import type { SourceHost } from '../source-host';
import { type AzureDevOpsClient, AzureError } from './azure-client';
import {
    branchSummaries,
    buildsForCommit,
    buildToCheck,
    buildToRun,
    gitStatusToCheckRun,
    mapChanges,
    mapPullRequest,
    mergeStrategyOf,
    myPullRequestItemOf,
    openPullRequestOf,
    orderedRecords,
    pullRequestSummaryOf,
    repoOfPullRequest,
    reviewRequestItemOf,
    viewerIsRequested,
    timelineToProgress,
    userOf,
    loginOf,
    type AzBuild,
    type AzBuildDefinition,
    type AzChangeEntry,
    type AzCommitChange,
    type AzCommit,
    type AzGitStatus,
    type AzIdentity,
    type AzIteration,
    type AzList,
    type AzPullRequest,
    type AzRepository,
    type AzThread,
    type AzTimelineRecord,
    type AzViewer
} from './azure-mapping';

/** The diff view does not load file versions that are larger than this limit. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The empty identity. Azure DevOps turns off auto-complete when `autoCompleteSetBy` has this ID. */
const NO_IDENTITY = '00000000-0000-0000-0000-000000000000';

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`The command "git ${args.join(' ')}" failed: ${(stderr || error.message).trim()}`));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

/** The host of the profile and account APIs. They are not in an organization. */
const VSSPS_URL = 'https://app.vssps.visualstudio.com/_apis';

/** The number of project requests at the same time, for the lists that need a request for each project. */
const PARALLEL = 4;

/** Calls `work` for each item, with at most `limit` calls at the same time. The results keep the order of the items. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Calls `work` for each organization. A failure in one organization does not stop the others.
 * When all organizations fail, the function throws the first error.
 */
async function eachOrganization<R>(organizations: readonly string[], work: (organization: string) => Promise<R>): Promise<R[]> {
    const results = await Promise.allSettled(organizations.map(work));
    const done = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed && done.length === 0) {
        throw failed.reason instanceof Error ? failed.reason : new AzureError(String(failed.reason), 0);
    }
    return done;
}

/** True when the pull request matches the search text of the pull request list: the title, the author, the branch or the number. */
function matchesQuery(pr: AzPullRequest, query: string | undefined): boolean {
    const text = query?.trim();
    if (!text) return true;
    return matchesSearch({ number: pr.pullRequestId, title: pr.title, author: loginOf(pr.createdBy), headRefName: fromRefName(pr.sourceRefName) }, text);
}

/** A repository with its ID and default branch from Azure DevOps. */
interface ResolvedRepo {
    ref: AzureRepoRef;
    id: string;
    defaultBranch: string;
    /** The base URL of the git API of the repository. */
    api: string;
}

/**
 * Reads and changes pull requests and pipelines of Azure Repos (Azure DevOps Services).
 * A target is a worktree path with an Azure Repos remote, or an Azure reference from the Review view or the
 * Pipelines view (see `azureRepoOf`).
 */
export class AzureDevOpsService implements SourceHost {
    readonly kind = 'azure' as const;

    private readonly remotes = new Map<string, AzureRepoRef | null>();
    private readonly resolved = new Map<string, Promise<ResolvedRepo>>();
    private readonly viewers = new Map<string, Promise<AzViewer>>();
    private organizationList: Promise<string[]> | undefined;
    /** The users of the default team of each project, for the reviewer picker. */
    private readonly members = new Map<string, AzIdentity[]>();
    /**
     * The files that the user marked as viewed, by pull request. Azure DevOps has no public API for this state,
     * so it stays in memory until the app quits.
     */
    private readonly viewed = new Map<string, Set<string>>();

    constructor(
        private readonly client: AzureDevOpsClient,
        private readonly readRemote: (root: string) => Promise<string> = root => git(root, ['remote', 'get-url', 'origin'])
    ) {}

    /** Returns the Azure repository of a worktree from its "origin" remote. Returns null for other remotes. */
    async repoFor(root: string): Promise<AzureRepoRef | null> {
        if (!this.remotes.has(root)) {
            const url = await this.readRemote(root).catch(() => '');
            this.remotes.set(root, parseAzureRemote(url) ?? null);
        }
        return this.remotes.get(root)!;
    }

    /** True when the target is a worktree with an Azure Repos remote, or an Azure reference. */
    async owns(target: RepoTarget): Promise<boolean> {
        if (typeof target !== 'string') return !!azureRepoOf(target);
        return (await this.repoFor(target)) !== null;
    }

    private async resolve(target: RepoTarget): Promise<ResolvedRepo> {
        let ref: AzureRepoRef | null | undefined;
        if (typeof target === 'string') {
            ref = await this.repoFor(target);
            if (!ref) {
                throw new AzureError('The "origin" remote of this worktree is not an Azure Repos repository.', 0);
            }
        } else {
            ref = azureRepoOf(target);
            if (!ref) {
                throw new AzureError(`"${target.owner}/${target.name}" is not an Azure Repos repository.`, 0);
            }
        }
        const key = `${ref.organization}/${ref.project}/${ref.repository}`;
        let repo = this.resolved.get(key);
        if (!repo) {
            repo = (async () => {
                const data = await this.client.request<AzRepository>('GET', `${azureProjectApi(ref)}/git/repositories/${encodeURIComponent(ref.repository)}`);
                return {
                    ref,
                    id: data.id,
                    defaultBranch: fromRefName(data.defaultBranch) || 'main',
                    api: `${azureProjectApi(ref)}/git/repositories/${data.id}`
                };
            })();
            this.resolved.set(key, repo);
            repo.catch(() => this.resolved.delete(key));
        }
        return repo;
    }

    /** Returns the ID of the user of the token in the organization. */
    private async viewerId(ref: Pick<AzureRepoRef, 'organization'>): Promise<string> {
        return (await this.viewer(ref.organization)).id;
    }

    /** Returns the user of the token in the organization. The login is the account name, as in the reviewer lists. */
    private viewer(organization: string): Promise<AzViewer> {
        let viewer = this.viewers.get(organization);
        if (!viewer) {
            viewer = this.client
                .request<{ authenticatedUser: { id: string; providerDisplayName?: string; properties?: { Account?: { $value?: string } } } }>(
                    'GET',
                    `${azureOrgUrl({ organization })}/_apis/connectionData`
                )
                .then(data => ({
                    id: data.authenticatedUser.id,
                    login: data.authenticatedUser.properties?.Account?.$value || data.authenticatedUser.providerDisplayName || 'unknown'
                }));
            this.viewers.set(organization, viewer);
            viewer.catch(() => this.viewers.delete(organization));
        }
        return viewer;
    }

    /**
     * Returns the organizations of the user of the token, from the account API. A personal access token needs
     * the "All accessible organizations" setting for this API.
     */
    private organizations(): Promise<string[]> {
        if (!this.organizationList) {
            const list = (async () => {
                const profile = await this.client.request<{ id: string }>('GET', `${VSSPS_URL}/profile/profiles/me?api-version=7.1-preview.3`);
                const accounts = await this.client.request<AzList<{ accountName: string }>>(
                    'GET',
                    `${VSSPS_URL}/accounts?memberId=${encodeURIComponent(profile.id)}&api-version=7.1-preview.1`
                );
                return accounts.value.map(account => account.accountName).filter(Boolean);
            })();
            this.organizationList = list;
            list.catch(() => {
                this.organizationList = undefined;
            });
        }
        return this.organizationList;
    }

    /**
     * Returns the organizations to read: the scope of the provider. Without a scope, the organizations of the account
     * and of the project remotes (`known`). Throws an error when no organization is known.
     */
    private async organizationsFor(scope: string[] | undefined, known: readonly string[]): Promise<string[]> {
        if (scope) return scope;
        const fromAccount = await this.organizations().catch((): string[] => []);
        const unique = new Map([...fromAccount, ...known].map(name => [name.toLowerCase(), name]));
        if (unique.size === 0) {
            throw new AzureError(
                'ShipWarden cannot find your Azure DevOps organizations. Type them in the provider in Settings › Code review, or use a token for all accessible organizations.',
                0
            );
        }
        return [...unique.values()];
    }

    /** Returns the names of the projects of an organization. */
    private async projects(organization: string): Promise<string[]> {
        const data = await this.client.request<AzList<{ name: string; state?: string }>>('GET', `${azureOrgUrl({ organization })}/_apis/projects?$top=1000`);
        return data.value.filter(project => !project.state || project.state === 'wellFormed').map(project => project.name);
    }

    /**
     * Returns the repositories of the organizations, for the Review view and the Pipelines view.
     * `known` has the organizations of the project remotes. They count when the scope has all organizations.
     */
    async repositories(scope: string[] | undefined, known: readonly string[] = []): Promise<GitHubRepoInfo[]> {
        const organizations = await this.organizationsFor(scope, known);
        const lists = await eachOrganization(organizations, async organization => {
            const data = await this.client.request<AzList<AzRepository>>('GET', `${azureOrgUrl({ organization })}/_apis/git/repositories`);
            return data.value.flatMap((repo): GitHubRepoInfo[] =>
                repo.project?.name && !repo.isDisabled ? [azureRepoRef({ organization, project: repo.project.name, repository: repo.name })] : []
            );
        });
        return lists.flat();
    }

    /** Returns the active pull requests of a repository, for the review queue of the Review view. */
    async repoPullRequests(target: RepoRef): Promise<RepoPullRequests> {
        const repo = await this.resolve(target);
        const [prs, builds, viewer] = await Promise.all([
            this.client.request<AzList<AzPullRequest>>('GET', `${repo.api}/pullrequests?searchCriteria.status=active&$top=100`),
            this.recentBuilds(repo, 200).catch(() => [] as AzBuild[]),
            this.viewer(repo.ref.organization).catch(() => undefined)
        ]);
        const pullRequests = prs.value.map(pr => openPullRequestOf(repo.ref, pr, builds, viewer?.id));
        return { viewer: viewer?.login ?? '', openCount: pullRequests.length, pullRequests };
    }

    /**
     * Returns the pull requests of a repository for a filter of the Review view, the newest first.
     * Azure DevOps has no assignees, so the "assigned" filter gives no pull requests.
     * The search looks at the title, the author, the branch and the number.
     */
    async pullRequests(target: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]> {
        if (filter === 'assigned') return [];
        const repo = await this.resolve(target);
        const needsViewer = filter === 'review' || filter === 'mine';
        const viewer = needsViewer ? await this.viewer(repo.ref.organization) : await this.viewer(repo.ref.organization).catch(() => undefined);
        const status = filter === 'closed' ? 'abandoned' : filter === 'merged' ? 'completed' : 'active';
        const person = filter === 'review' ? `&searchCriteria.reviewerId=${viewer?.id}` : filter === 'mine' ? `&searchCriteria.creatorId=${viewer?.id}` : '';
        const [prs, builds] = await Promise.all([
            this.client.request<AzList<AzPullRequest>>('GET', `${repo.api}/pullrequests?searchCriteria.status=${status}${person}&$top=100`),
            status === 'active' ? this.recentBuilds(repo, 200).catch(() => [] as AzBuild[]) : Promise.resolve([] as AzBuild[])
        ]);
        return prs.value
            .filter(pr => filter !== 'review' || viewerIsRequested(pr, viewer?.id))
            .filter(pr => matchesQuery(pr, query))
            .map(pr => pullRequestSummaryOf(repo.ref, pr, builds, viewer?.id))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    /**
     * Returns the pull requests for the Dashboard: the active pull requests that ask the viewer for a review, and the
     * active pull requests of the viewer that need an action. Azure DevOps lists pull requests by project, so this
     * sends requests for each project.
     */
    async dashboardPullRequests(scope: string[] | undefined, known: readonly string[] = []): Promise<DashboardPullRequests> {
        const organizations = await this.organizationsFor(scope, known);
        const results = await eachOrganization(organizations, async organization => {
            const [viewer, projects] = await Promise.all([this.viewer(organization), this.projects(organization)]);
            const reviewRequests: ReviewRequestItem[] = [];
            const myPullRequests: MyPullRequestItem[] = [];
            await mapLimit(projects, PARALLEL, async project => {
                const api = `${azureOrgUrl({ organization })}/${encodeURIComponent(project)}/_apis`;
                const list = (person: 'reviewerId' | 'creatorId') =>
                    this.client
                        .request<AzList<AzPullRequest>>(
                            'GET',
                            `${api}/git/pullrequests?searchCriteria.status=active&searchCriteria.${person}=${viewer.id}&$top=100`
                        )
                        .then(data => data.value);
                const [reviewing, mine] = await Promise.all([list('reviewerId'), list('creatorId')]);
                for (const pr of reviewing) {
                    const repo = repoOfPullRequest(organization, pr);
                    if (repo && pr.createdBy.id !== viewer.id && viewerIsRequested(pr, viewer.id)) reviewRequests.push(reviewRequestItemOf(repo, pr));
                }
                if (mine.length === 0) return;
                const builds = await this.client
                    .request<AzList<AzBuild>>('GET', `${api}/build/builds?reasonFilter=pullRequest&queryOrder=queueTimeDescending&$top=200`)
                    .then(
                        data => data.value,
                        () => [] as AzBuild[]
                    );
                for (const pr of mine) {
                    const repo = repoOfPullRequest(organization, pr);
                    const item = repo && myPullRequestItemOf(repo, pr, builds);
                    if (item) myPullRequests.push(item);
                }
            });
            return { reviewRequests, myPullRequests };
        });
        return {
            reviewRequests: results.flatMap(result => result.reviewRequests),
            myPullRequests: results.flatMap(result => result.myPullRequests)
        };
    }

    private prApi(repo: ResolvedRepo, number: number): string {
        return `${repo.api}/pullrequests/${number}`;
    }

    async branchStatus(root: string): Promise<BranchStatus | null> {
        const ref = await this.repoFor(root);
        if (!ref) return null;
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const localSha = await git(root, ['rev-parse', 'HEAD']);
        let pullRequest: PullRequest | null = null;
        if (branch !== 'HEAD') {
            const list = await this.client.request<AzList<AzPullRequest>>(
                'GET',
                `${repo.api}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(toRefName(branch))}&searchCriteria.status=all&$top=20`
            );
            const newest = [...list.value].sort((a, b) => b.creationDate.localeCompare(a.creationDate));
            const pick = newest.find(pr => pr.status === 'active') ?? newest[0];
            if (pick) pullRequest = await this.pullRequest(root, pick.pullRequestId);
        }
        return {
            repo: azureRepoRef(ref),
            branch,
            sha: pullRequest?.state === 'OPEN' && pullRequest.headRefOid ? pullRequest.headRefOid : localSha,
            pullRequest,
            host: 'azure',
            createUrl: azureCreatePullRequestUrl(ref, branch)
        };
    }

    async branchSummaries(root: string): Promise<Record<string, BranchSummary>> {
        if (!(await this.repoFor(root))) return {};
        const repo = await this.resolve(root);
        const [prs, builds, viewerId] = await Promise.all([
            this.client.request<AzList<AzPullRequest>>('GET', `${repo.api}/pullrequests?searchCriteria.status=active&$top=100`),
            this.recentBuilds(repo, 200).catch(() => [] as AzBuild[]),
            this.viewerId(repo.ref).catch(() => undefined)
        ]);
        return branchSummaries(repo.ref, prs.value, builds, viewerId);
    }

    async createPullRequest(root: string, request: NewPullRequest): Promise<number> {
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branch === 'HEAD') {
            throw new AzureError('The worktree has no branch (detached HEAD).', 0);
        }
        const created = await this.client.request<AzPullRequest>('POST', `${repo.api}/pullrequests`, {
            sourceRefName: toRefName(branch),
            targetRefName: toRefName(request.base || repo.defaultBranch),
            title: request.title,
            description: request.body,
            isDraft: request.draft
        });
        return created.pullRequestId;
    }

    async pullRequest(target: RepoTarget, number: number): Promise<PullRequest> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        const [pr, threads, commits, iterations, viewerId] = await Promise.all([
            this.client.request<AzPullRequest>('GET', base),
            this.client.request<AzList<AzThread>>('GET', `${base}/threads`),
            this.client.request<AzList<AzCommit>>('GET', `${base}/commits?$top=100`),
            this.client.request<AzList<AzIteration>>('GET', `${base}/iterations`),
            this.viewerId(repo.ref).catch(() => undefined)
        ]);
        const iteration = iterations.value[iterations.value.length - 1];
        const changes = iteration ? await this.changes(repo, number, iteration.id).catch(() => undefined) : undefined;
        return mapPullRequest({
            repo: repo.ref,
            pr,
            threads: threads.value,
            commits: commits.value,
            iteration,
            changedFiles: changes?.length,
            viewerId
        });
    }

    /** Returns the changes of an iteration against the base of the pull request. */
    private async changes(repo: ResolvedRepo, number: number, iterationId: number): Promise<PullRequestFile[]> {
        const entries: AzChangeEntry[] = [];
        let skip = 0;
        // Azure DevOps returns at most 2000 changes in one page.
        for (let page = 0; page < 5; page++) {
            const data = await this.client.request<{ changeEntries: AzChangeEntry[]; nextSkip?: number; nextTop?: number }>(
                'GET',
                `${this.prApi(repo, number)}/iterations/${iterationId}/changes?$compareTo=0&$top=2000&$skip=${skip}`
            );
            entries.push(...data.changeEntries);
            if (!data.nextSkip || !data.nextTop) break;
            skip = data.nextSkip;
        }
        return mapChanges(entries);
    }

    async pullRequestFiles(target: RepoTarget, number: number): Promise<PullRequestFile[]> {
        const repo = await this.resolve(target);
        const iterations = await this.client.request<AzList<AzIteration>>('GET', `${this.prApi(repo, number)}/iterations`);
        const last = iterations.value[iterations.value.length - 1];
        if (!last) return [];
        const viewed = this.viewed.get(this.viewedKey(repo.ref, number)) ?? new Set<string>();
        return (await this.changes(repo, number, last.id)).map(file => ({ ...file, viewed: viewed.has(file.path) }));
    }

    private viewedKey(ref: AzureRepoRef, number: number): string {
        return `${ref.organization}/${ref.project}/${ref.repository}#${number}`;
    }

    async setFileViewed(pullRequestId: string, filePath: string, viewed: boolean): Promise<void> {
        const decoded = decodeAzureId(pullRequestId);
        if (!decoded) throw new AzureError('The pull request ID is not an Azure DevOps ID.', 0);
        const key = this.viewedKey(decoded.repo, decoded.pullRequestId);
        const set = this.viewed.get(key) ?? new Set<string>();
        if (viewed) set.add(filePath);
        else set.delete(filePath);
        this.viewed.set(key, set);
    }

    /**
     * Returns the changed files of one commit and its first parent. Azure DevOps sends no patch and no line counts.
     * The diff view loads the two versions of each file.
     */
    async commitFiles(target: RepoTarget, sha: string): Promise<CommitFiles> {
        const repo = await this.resolve(target);
        const commitApi = `${repo.api}/commits/${encodeURIComponent(sha)}`;
        const commit = await this.client.request<{ parents?: string[] }>('GET', commitApi);
        const entries: AzChangeEntry[] = [];
        // Azure DevOps returns at most 2000 changes in one page.
        for (let page = 0; page < 5; page++) {
            const data = await this.client.request<{ changes?: AzCommitChange[] }>('GET', `${commitApi}/changes?top=2000&skip=${page * 2000}`);
            const changes = data.changes ?? [];
            entries.push(
                ...changes.map(change => ({
                    changeType: change.changeType,
                    originalPath: change.originalPath ?? change.sourceServerItem,
                    item: change.item && { path: change.item.path, isFolder: change.item.isFolder || change.item.gitObjectType === 'tree' }
                }))
            );
            if (changes.length < 2000) break;
        }
        return { parentSha: commit.parents?.[0] ?? null, files: mapChanges(entries) };
    }

    async fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
        const repo = await this.resolve(target);
        const read = async (filePath: string, sha: string): Promise<string | undefined> => {
            try {
                const text = await this.client.text(
                    `${repo.api}/items?path=${encodeURIComponent(`/${filePath}`)}&versionDescriptor.version=${encodeURIComponent(sha)}&versionDescriptor.versionType=commit&$format=octetStream&download=false`,
                    'application/octet-stream'
                );
                if (text.length > MAX_FILE_BYTES || text.slice(0, 8000).includes('\0')) return undefined;
                return text;
            } catch (error) {
                if (error instanceof AzureError && error.status === 404) return '';
                throw error;
            }
        };
        const [base, head] = await Promise.all([
            file.status === 'added' || !baseSha ? Promise.resolve('') : read(file.previousPath ?? file.path, baseSha),
            file.status === 'removed' ? Promise.resolve('') : read(file.path, headSha)
        ]);
        if (base === undefined || head === undefined) return { base: '', head: '', unavailable: true };
        return { base, head };
    }

    /**
     * Sends a review: each pending comment becomes a thread on its line, the body becomes a thread without a file,
     * and the event sets the vote of the user. A comment gives no vote.
     */
    async submitReview(target: RepoTarget, number: number, _headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        for (const comment of comments) {
            const start = { line: Math.min(comment.startLine ?? comment.line, comment.line), offset: 1 };
            const end = { line: comment.line, offset: 1 };
            const context =
                comment.side === 'LEFT'
                    ? { filePath: `/${comment.path}`, leftFileStart: start, leftFileEnd: end }
                    : { filePath: `/${comment.path}`, rightFileStart: start, rightFileEnd: end };
            await this.client.request('POST', `${base}/threads`, {
                comments: [{ parentCommentId: 0, content: comment.body, commentType: 'text' }],
                status: 'active',
                threadContext: context
            });
        }
        if (body.trim()) {
            await this.client.request('POST', `${base}/threads`, {
                comments: [{ parentCommentId: 0, content: body, commentType: 'text' }],
                status: 'active'
            });
        }
        const vote = voteForEvent(event);
        if (vote !== undefined) {
            const viewerId = await this.viewerId(repo.ref);
            await this.client.request('PUT', `${base}/reviewers/${viewerId}`, { vote });
        }
    }

    /** Adds a reply to a thread. `threadId` is the `databaseId` of the comments of the thread. */
    async replyToComment(target: RepoTarget, number: number, threadId: number, body: string): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${this.prApi(repo, number)}/threads/${threadId}/comments`, {
            content: body,
            parentCommentId: 1,
            commentType: 'text'
        });
    }

    /**
     * Likes a comment (`on`) or removes the like. Azure DevOps has only likes, so only the thumbs up is accepted.
     * `subjectId` is the `id` of a comment from `mapThreads`.
     */
    async setReaction(target: RepoTarget, number: number, subjectId: string, content: ReactionContent, on: boolean): Promise<void> {
        if (content !== 'THUMBS_UP') throw new AzureError('Azure DevOps accepts only a like (thumbs up) on a comment.', 0);
        const [threadPart, commentPart] = subjectId.split('#');
        const threadId = decodeAzureId(threadPart)?.threadId;
        const commentId = Number(commentPart);
        if (threadId === undefined || !Number.isInteger(commentId)) throw new AzureError('The ID is not an Azure DevOps comment ID.', 0);
        const repo = await this.resolve(target);
        await this.client.request(on ? 'POST' : 'DELETE', `${this.prApi(repo, number)}/threads/${threadId}/comments/${commentId}/likes`);
    }

    async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
        const decoded = decodeAzureId(threadId);
        if (!decoded?.threadId) throw new AzureError('The thread ID is not an Azure DevOps thread ID.', 0);
        const { repo: ref, pullRequestId } = decoded;
        const data = await this.client.request<AzRepository>('GET', `${azureProjectApi(ref)}/git/repositories/${encodeURIComponent(ref.repository)}`);
        await this.client.request('PATCH', `${azureProjectApi(ref)}/git/repositories/${data.id}/pullrequests/${pullRequestId}/threads/${decoded.threadId}`, {
            status: resolved ? 'fixed' : 'active'
        });
    }

    /** Completes the pull request. Azure DevOps refuses it when the source branch has a newer commit than `headSha`. */
    async merge(target: RepoTarget, number: number, headSha: string, method: MergeMethod): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('PATCH', this.prApi(repo, number), {
            status: 'completed',
            lastMergeSourceCommit: { commitId: headSha },
            completionOptions: { mergeStrategy: mergeStrategyOf(method) }
        });
    }

    async changePullRequest(target: RepoTarget, number: number, change: PullRequestChange): Promise<void> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        switch (change.kind) {
            case 'details': {
                const update: Record<string, unknown> = {};
                if (change.title !== undefined) update.title = change.title;
                if (change.body !== undefined) update.description = change.body;
                if (change.state) update.status = change.state === 'closed' ? 'abandoned' : 'active';
                await this.client.request('PATCH', base, update);
                return;
            }
            case 'draft':
                await this.client.request('PATCH', base, { isDraft: change.draft });
                return;
            case 'autoMerge':
                if (change.method) {
                    await this.client.request('PATCH', base, {
                        autoCompleteSetBy: { id: await this.viewerId(repo.ref) },
                        completionOptions: { mergeStrategy: mergeStrategyOf(change.method) }
                    });
                } else {
                    await this.client.request('PATCH', base, { autoCompleteSetBy: { id: NO_IDENTITY } });
                }
                return;
            case 'assignee':
                throw new AzureError('Azure DevOps pull requests have no assignees.', 0);
            case 'reviewer': {
                const id = await this.identityId(repo, number, change.reviewer.login);
                if (change.add) {
                    await this.client.request('PUT', `${base}/reviewers/${id}`, { vote: 0 });
                } else {
                    await this.client.request('DELETE', `${base}/reviewers/${id}`);
                }
                return;
            }
            case 'label':
                if (change.add) {
                    await this.client.request('POST', `${base}/labels`, { name: change.name });
                } else {
                    await this.client.request('DELETE', `${base}/labels/${encodeURIComponent(change.name)}`);
                }
                return;
        }
    }

    /** Finds the identity ID of a login: in the reviewers of the pull request, in the team members, else with the identity search. */
    private async identityId(repo: ResolvedRepo, number: number, login: string): Promise<string> {
        const pr = await this.client.request<AzPullRequest>('GET', this.prApi(repo, number));
        const known = [...(pr.reviewers ?? []), ...(this.members.get(this.membersKey(repo.ref)) ?? [])];
        const found = known.find(identity => loginOf(identity) === login);
        if (found) return found.id;
        const search = await this.client.request<AzList<{ id: string }>>(
            'GET',
            `https://vssps.dev.azure.com/${encodeURIComponent(repo.ref.organization)}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(login)}&queryMembership=None`
        );
        if (!search.value[0]) throw new AzureError(`Azure DevOps has no user "${login}".`, 404);
        return search.value[0].id;
    }

    private membersKey(ref: AzureRepoRef): string {
        return `${ref.organization}/${ref.project}`;
    }

    /** The members of the default team of the project, for the reviewer picker. Azure DevOps has no label list for a repository. */
    async pullRequestCandidates(target: RepoTarget): Promise<PullRequestCandidates> {
        const repo = await this.resolve(target);
        const project = await this.client.request<{ defaultTeam?: { id: string } }>(
            'GET',
            `${azureOrgUrl(repo.ref)}/_apis/projects/${encodeURIComponent(repo.ref.project)}`
        );
        if (!project.defaultTeam) return { users: [], labels: [] };
        const members = await this.client.request<AzList<{ identity: AzIdentity }>>(
            'GET',
            `${azureOrgUrl(repo.ref)}/_apis/projects/${encodeURIComponent(repo.ref.project)}/teams/${project.defaultTeam.id}/members?$top=200`
        );
        const identities = members.value.map(member => member.identity).filter(identity => !identity.isContainer);
        this.members.set(this.membersKey(repo.ref), identities);
        return { users: identities.map(userOf).filter((user): user is GitHubUser => !!user), labels: [] };
    }

    /** Azure DevOps uses a different syntax for references in comments. The comment box shows no "#" list for Azure DevOps. */
    async issueReferences(): Promise<IssueReference[]> {
        return [];
    }

    /** The newest builds of the repository, newest first. */
    private async recentBuilds(repo: ResolvedRepo, top: number, definitionId?: number): Promise<AzBuild[]> {
        const definition = definitionId ? `&definitions=${definitionId}` : '';
        const data = await this.client.request<AzList<AzBuild>>(
            'GET',
            `${azureProjectApi(repo.ref)}/build/builds?repositoryId=${repo.id}&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=${top}${definition}`
        );
        return data.value;
    }

    /** The newest build of each pipeline for the commit, and the statuses of other services on the commit. */
    async checks(target: RepoTarget, sha: string): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        const [builds, statuses] = await Promise.all([
            this.recentBuilds(repo, 100),
            this.client.request<AzList<AzGitStatus>>('GET', `${repo.api}/commits/${sha}/statuses?latestOnly=true`).then(
                data => data.value,
                () => [] as AzGitStatus[]
            )
        ]);
        return [...buildsForCommit(builds, sha).map(build => buildToCheck(repo.ref, build)), ...statuses.map(gitStatusToCheckRun)].sort((a, b) =>
            a.name.localeCompare(b.name)
        );
    }

    private build(repo: ResolvedRepo, buildId: number): Promise<AzBuild> {
        return this.client.request<AzBuild>('GET', `${azureProjectApi(repo.ref)}/build/builds/${buildId}`);
    }

    private async timeline(repo: ResolvedRepo, buildId: number): Promise<AzTimelineRecord[]> {
        const data = await this.client.request<{ records?: AzTimelineRecord[] } | undefined>(
            'GET',
            `${azureProjectApi(repo.ref)}/build/builds/${buildId}/timeline`
        );
        return data?.records ?? [];
    }

    /** The status of a build and its tasks. `jobId` is the build ID, because a build is one check in the UI. */
    async jobProgress(target: RepoTarget, jobId: number): Promise<JobProgress> {
        const repo = await this.resolve(target);
        const [build, records] = await Promise.all([this.build(repo, jobId), this.timeline(repo, jobId)]);
        return timelineToProgress(build, records);
    }

    /**
     * The log of a build: the log of each task, in the order of the timeline, with a header line for each task.
     * The Job records have only a short log, so the task logs give the full output.
     */
    async jobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        const logs = `${azureProjectApi(repo.ref)}/build/builds/${jobId}/logs`;
        const records = await this.timeline(repo, jobId);
        const jobNames = new Map(orderedRecords(records, 'Job').map(job => [job.id, job.name]));
        const tasks = orderedRecords(records, 'Task').filter(task => task.log);
        if (tasks.length > 0) {
            const parts = await Promise.all(
                tasks.map(async task => {
                    const job = task.parentId ? jobNames.get(task.parentId) : undefined;
                    const title = job && jobNames.size > 1 ? `${job} › ${task.name}` : task.name;
                    return `##[section]${title}\n${await this.client.text(`${logs}/${task.log!.id}`)}`;
                })
            );
            return cleanActionsLog(parts.join('\n'));
        }
        // A classic pipeline can have no job records with a log. Then all logs of the build go in the result.
        const list = await this.client.request<AzList<{ id: number }>>('GET', logs);
        const parts = await Promise.all(list.value.map(log => this.client.text(`${logs}/${log.id}`)));
        return cleanActionsLog(parts.join('\n'));
    }

    async saveJobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        const folder = path.join(os.homedir(), '.shipwarden', 'ci-logs');
        await fs.mkdir(folder, { recursive: true });
        const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, '_');
        const file = path.join(folder, `${safe(repo.ref.organization)}-${safe(repo.ref.repository)}-build-${jobId}.log`);
        await fs.writeFile(file, await this.jobLog(target, jobId));
        return file;
    }

    /** Runs the failed jobs of a build again (retry). */
    async rerunJob(target: RepoTarget, jobId: number): Promise<void> {
        await this.rerunFailedJobs(target, jobId);
    }

    async rerunFailedJobs(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('PATCH', `${azureProjectApi(repo.ref)}/build/builds/${runId}?retry=true`, {});
    }

    /** The pipelines (build definitions) of the repository. Each one can start by hand, except a disabled one. */
    async workflows(target: RepoTarget, _ref: string): Promise<Workflow[]> {
        const repo = await this.resolve(target);
        const data = await this.client.request<AzList<AzBuildDefinition>>(
            'GET',
            `${azureProjectApi(repo.ref)}/build/definitions?repositoryId=${repo.id}&repositoryType=TfsGit`
        );
        return data.value.map(definition => ({
            id: definition.id,
            name: definition.name,
            path: definition.path ?? '\\',
            dispatchable: definition.queueStatus !== 'disabled',
            inputs: []
        }));
    }

    /** Queues a build of a pipeline on a branch. The inputs go to the template parameters of a YAML pipeline. */
    async dispatchWorkflow(target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${azureProjectApi(repo.ref)}/build/builds`, {
            definition: { id: workflowId },
            sourceBranch: toRefName(ref),
            ...(inputs && Object.keys(inputs).length > 0 ? { templateParameters: inputs } : {})
        });
    }

    async workflowRuns(target: RepoTarget, workflowId?: number): Promise<WorkflowRun[]> {
        const repo = await this.resolve(target);
        return (await this.recentBuilds(repo, 40, workflowId)).map(build => buildToRun(repo.ref, build));
    }

    /** A build is one check in the UI, so the "jobs" of a run are the build itself. */
    async runJobs(target: RepoTarget, runId: number): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        return [buildToCheck(repo.ref, await this.build(repo, runId))];
    }

    async cancelRun(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('PATCH', `${azureProjectApi(repo.ref)}/build/builds/${runId}`, { status: 'cancelling' });
    }

    /** Queues a new build of the same pipeline, branch and commit. */
    async rerunRun(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        const build = await this.build(repo, runId);
        await this.client.request('POST', `${azureProjectApi(repo.ref)}/build/builds`, {
            definition: { id: build.definition.id },
            sourceBranch: build.sourceBranch,
            sourceVersion: build.sourceVersion
        });
    }

    async branches(target: RepoTarget): Promise<string[]> {
        const repo = await this.resolve(target);
        const data = await this.client.request<AzList<{ name: string }>>('GET', `${repo.api}/refs?filter=heads/&$top=300`);
        const names = data.value.map(item => fromRefName(item.name)).filter(name => name !== repo.defaultBranch);
        return [repo.defaultBranch, ...names];
    }
}
