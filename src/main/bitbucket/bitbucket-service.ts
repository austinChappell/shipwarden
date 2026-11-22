import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    bitbucketCreatePullRequestUrl,
    bitbucketRepoApi,
    bitbucketRepoOf,
    bitbucketRepoRef,
    cleanBitbucketLog,
    decodeBitbucketId,
    parseBitbucketRemote,
    strategyForMethod,
    type BitbucketRepoRef
} from '@shared/bitbucket';
import type { DashboardPullRequests, MyPullRequestItem } from '@shared/dashboard';
import type {
    BranchStatus,
    BranchSummary,
    CheckRun,
    CommitFiles,
    FileVersions,
    GitHubRepoInfo,
    GitHubUser,
    IssueReference,
    JobProgress,
    MergedPullRequest,
    MergeMethod,
    NewPullRequest,
    PendingComment,
    PullRequest,
    PullRequestCandidates,
    PullRequestChange,
    PullRequestFile,
    PullRequestFilter,
    PullRequestSummary,
    RepoRef,
    RepoTarget,
    ReviewEvent,
    Workflow
} from '@shared/github';
import type { WorkflowRun } from '@shared/pipelines';
import { matchesSearch, type RepoPullRequests } from '@shared/review-queue';
import type { SourceHost } from '../source-host';
import { type BitbucketClient, BitbucketError } from './bitbucket-client';
import {
    BITBUCKET_PIPELINE_WORKFLOW_ID,
    branchSummaries,
    commitStatusToCheckRun,
    isPipelinesStatus,
    loginOf,
    mapFiles,
    mapPullRequest,
    mergedBranches,
    myPullRequestItemOf,
    NumericIds,
    openPullRequestOf,
    pipelinesByCommit,
    pipelineToRun,
    pullRequestSummaryOf,
    repoOfPullRequest,
    stepProgressOf,
    stepToCheck,
    userOf,
    viewerIsReviewer,
    type BbBranch,
    type BbComment,
    type BbCommit,
    type BbCommitStatus,
    type BbDiffStat,
    type BbPipeline,
    type BbPipelineTarget,
    type BbPullRequest,
    type BbRepository,
    type BbStep,
    type BbUser
} from './bitbucket-mapping';

/** The diff view does not load file versions that are larger than this limit. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The partial response that adds the reviewers and the participants to the items of a list of pull requests.
 * The list API leaves them out by default. See https://developer.atlassian.com/cloud/bitbucket/rest/intro/#partial-response
 */
const LIST_FIELDS = `fields=${encodeURIComponent('+values.participants,+values.reviewers')}`;

/** The largest number of workspaces that the Review view and the Dashboard read without a scope. */
const MAX_WORKSPACES = 10;

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

/** A repository with its API path and its data from Bitbucket. */
interface ResolvedRepo {
    ref: BitbucketRepoRef;
    /** The API path of the repository, for example "/repositories/acme/api". */
    api: string;
    repository: BbRepository;
}

/** One page of a list of the Bitbucket API. */
interface Page<T> {
    values?: T[];
    next?: string;
}

/** The path of a repository for the cache keys, in lowercase. */
function keyOf(ref: BitbucketRepoRef): string {
    return `${ref.workspace}/${ref.repo}`.toLowerCase();
}

/** A BBQL text value in double quotes. */
function quoted(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The path of a file in a URL. Each part is encoded, and the "/" between the parts stays. */
function encodePath(filePath: string): string {
    return filePath.split('/').map(encodeURIComponent).join('/');
}

/** Returns the target of a pipeline for a new run with the same target. Only the fields of the trigger API stay. */
export function rerunTarget(target: BbPipelineTarget | null | undefined): Record<string, unknown> {
    if (!target?.type) throw new BitbucketError('The pipeline has no target. ShipWarden cannot run it again.', 0);
    const keep: Record<string, unknown> = { type: target.type };
    if (target.selector?.type) keep.selector = { type: target.selector.type, ...(target.selector.pattern ? { pattern: target.selector.pattern } : {}) };
    if (target.commit?.hash) keep.commit = { type: 'commit', hash: target.commit.hash };
    if (target.type === 'pipeline_pullrequest_target') {
        if (target.source) keep.source = target.source;
        if (target.destination) keep.destination = target.destination;
        if (target.destination_commit?.hash) keep.destination_commit = { hash: target.destination_commit.hash };
        if (target.pullrequest?.id) keep.pullrequest = { id: target.pullrequest.id };
    } else if (target.ref_name) {
        keep.ref_type = target.ref_type ?? 'branch';
        keep.ref_name = target.ref_name;
    }
    return keep;
}

/**
 * Reads and changes pull requests and pipelines of Bitbucket Cloud.
 * A target is a worktree path with a remote on bitbucket.org, or a Bitbucket reference from the Review view or the
 * Pipelines view (see `bitbucketRepoOf`).
 */
export class BitbucketService implements SourceHost {
    readonly kind = 'bitbucket' as const;

    private readonly remotes = new Map<string, BitbucketRepoRef | null>();
    private readonly repositoriesCache = new Map<string, Promise<BbRepository>>();
    private readonly branchCache = new Map<string, Promise<BbBranch | undefined>>();
    private viewerPromise: Promise<BbUser> | undefined;
    /** The UUIDs of the users by login (nickname), for the reviewer changes. */
    private readonly userUuids = new Map<string, string>();
    /**
     * The files that the user marked as viewed, by pull request. Bitbucket has no public API for this state,
     * so it stays in memory until the app quits.
     */
    private readonly viewed = new Map<string, Set<string>>();
    /** The numbers of the UI for the UUIDs of the pipelines and the steps. */
    private readonly ids = new NumericIds();

    constructor(
        private readonly client: BitbucketClient,
        private readonly readRemote: (root: string) => Promise<string> = root => git(root, ['remote', 'get-url', 'origin'])
    ) {}

    /** Returns the Bitbucket repository of a worktree from its "origin" remote. Returns null for other remotes. */
    async repoFor(root: string): Promise<BitbucketRepoRef | null> {
        if (!this.remotes.has(root)) {
            const url = await this.readRemote(root).catch(() => '');
            this.remotes.set(root, parseBitbucketRemote(url) ?? null);
        }
        return this.remotes.get(root)!;
    }

    /** True when the target is a worktree with a remote on bitbucket.org, or a Bitbucket reference. */
    async owns(target: RepoTarget): Promise<boolean> {
        if (typeof target !== 'string') return !!bitbucketRepoOf(target);
        return (await this.repoFor(target)) !== null;
    }

    private async refOf(target: RepoTarget): Promise<BitbucketRepoRef> {
        if (typeof target === 'string') {
            const ref = await this.repoFor(target);
            if (!ref) throw new BitbucketError('The "origin" remote of this worktree is not a repository on bitbucket.org.', 0);
            return ref;
        }
        const ref = bitbucketRepoOf(target);
        if (!ref) throw new BitbucketError(`"${target.owner}/${target.name}" is not a Bitbucket repository.`, 0);
        return ref;
    }

    private async resolve(target: RepoTarget): Promise<ResolvedRepo> {
        const ref = await this.refOf(target);
        const api = bitbucketRepoApi(ref);
        const key = keyOf(ref);
        let repository = this.repositoriesCache.get(key);
        if (!repository) {
            repository = this.client.request<BbRepository>('GET', api);
            this.repositoriesCache.set(key, repository);
            repository.catch(() => this.repositoriesCache.delete(key));
        }
        return { ref, api, repository: await repository };
    }

    /** Returns the user of the token. An access token has a bot user. */
    private viewer(): Promise<BbUser> {
        if (!this.viewerPromise) {
            const viewer = this.client.request<BbUser>('GET', '/user');
            this.viewerPromise = viewer;
            viewer.catch(() => {
                if (this.viewerPromise === viewer) this.viewerPromise = undefined;
            });
        }
        return this.viewerPromise;
    }

    private prApi(repo: ResolvedRepo, id: number): string {
        return `${repo.api}/pullrequests/${id}`;
    }

    private prKey(ref: BitbucketRepoRef, id: number): string {
        return `${keyOf(ref)}#${id}`;
    }

    /** Keeps the UUID of each user by login, so a reviewer change can find the UUID without a request. */
    private rememberUsers(users: readonly (BbUser | null | undefined)[]): void {
        for (const user of users) {
            if (user?.uuid) this.userUuids.set(loginOf(user).toLowerCase(), user.uuid);
        }
    }

    /**
     * Reads one page of pull requests with the reviewers and the participants. A server that refuses the partial
     * response gives the list without them.
     */
    private async pullRequestPage(repo: ResolvedRepo, query: string): Promise<BbPullRequest[]> {
        const base = `${repo.api}/pullrequests?${query}`;
        try {
            return (await this.client.request<Page<BbPullRequest>>('GET', `${base}&${LIST_FIELDS}`))?.values ?? [];
        } catch (error) {
            if (!(error instanceof BitbucketError) || error.status !== 400) throw error;
            return (await this.client.request<Page<BbPullRequest>>('GET', base))?.values ?? [];
        }
    }

    /** The open pull requests of a repository, the newest change first. */
    private openPullRequests(repo: ResolvedRepo): Promise<BbPullRequest[]> {
        return this.pullRequestPage(repo, 'state=OPEN&sort=-updated_on&pagelen=50');
    }

    /** The newest pipelines of the repository, for the CI state of the lists. A repository without Pipelines gives an empty map. */
    private recentPipelines(repo: ResolvedRepo): Promise<Map<string, BbPipeline>> {
        return this.client.request<Page<BbPipeline>>('GET', `${repo.api}/pipelines/?sort=-created_on&pagelen=50`).then(
            page => pipelinesByCommit(page?.values ?? []),
            () => new Map<string, BbPipeline>()
        );
    }

    /** The workspaces of the scope, else the workspaces of the user (at most 10). */
    private async workspaces(scope: string[] | undefined): Promise<string[]> {
        if (scope && scope.length > 0) return scope;
        const items = await this.client.all<{ slug?: string; workspace?: { slug?: string } }>('/user/workspaces?pagelen=100', 1);
        const slugs = items.map(item => item.workspace?.slug ?? item.slug).filter((slug): slug is string => !!slug);
        return [...new Set(slugs)].slice(0, MAX_WORKSPACES);
    }

    /**
     * Returns the repositories of the user in the workspaces of the scope, for the Review view and the Pipelines view.
     * Without a scope, it reads the workspaces of the user. The newest change comes first.
     */
    async repositories(scope: string[] | undefined): Promise<GitHubRepoInfo[]> {
        const workspaces = await this.workspaces(scope);
        const lists = await Promise.all(
            workspaces.map(workspace =>
                this.client.all<BbRepository>(`/repositories/${encodeURIComponent(workspace)}?role=member&sort=-updated_on&pagelen=100`, 3)
            )
        );
        return lists.flat().flatMap((repository): GitHubRepoInfo[] => {
            const [workspace, slug, ...rest] = repository.full_name.split('/');
            if (!workspace || !slug || rest.length > 0) return [];
            return [
                { ...bitbucketRepoRef({ workspace, repo: repository.slug ?? slug }), ...(repository.updated_on ? { pushedAt: repository.updated_on } : {}) }
            ];
        });
    }

    /** Returns the open pull requests of a repository, for the review queue of the Review view. */
    async repoPullRequests(target: RepoRef): Promise<RepoPullRequests> {
        const repo = await this.resolve(target);
        const [prs, pipelines, viewer] = await Promise.all([this.openPullRequests(repo), this.recentPipelines(repo), this.viewer().catch(() => undefined)]);
        this.rememberUsers(prs.flatMap(pr => [pr.author, ...(pr.reviewers ?? [])]));
        const pullRequests = prs.map(pr => openPullRequestOf(repo.ref, pr, pipelines, viewer));
        return { viewer: viewer ? loginOf(viewer) : '', openCount: pullRequests.length, pullRequests };
    }

    /**
     * Returns the pull requests of a repository for a filter of the Review view, the newest first.
     * Bitbucket has no assignees, so "assigned" gives no pull requests. The search looks at the title, the author, the
     * branch, and the number.
     */
    async pullRequests(target: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]> {
        if (filter === 'assigned') return [];
        const repo = await this.resolve(target);
        const needsViewer = filter === 'review' || filter === 'mine';
        const viewer = needsViewer ? await this.viewer() : await this.viewer().catch(() => undefined);
        const states = filter === 'closed' ? ['DECLINED', 'SUPERSEDED'] : filter === 'merged' ? ['MERGED'] : ['OPEN'];
        const conditions = [`(${states.map(state => `state=${quoted(state)}`).join(' OR ')})`];
        if (filter === 'review' && viewer?.uuid) conditions.push(`reviewers.uuid=${quoted(viewer.uuid)}`);
        if (filter === 'mine' && viewer?.uuid) conditions.push(`author.uuid=${quoted(viewer.uuid)}`);
        const stateParams = states.map(state => `state=${state}`).join('&');
        const [prs, pipelines] = await Promise.all([
            this.pullRequestPage(repo, `${stateParams}&q=${encodeURIComponent(conditions.join(' AND '))}&sort=-updated_on&pagelen=50`),
            states[0] === 'OPEN' ? this.recentPipelines(repo) : Promise.resolve(new Map<string, BbPipeline>())
        ]);
        const text = query?.trim();
        return prs
            .filter(pr => filter !== 'review' || viewerIsReviewer(pr, viewer))
            .filter(
                pr => !text || matchesSearch({ number: pr.id, title: pr.title, author: loginOf(pr.author), headRefName: pr.source.branch?.name ?? '' }, text)
            )
            .map(pr => pullRequestSummaryOf(pr, pipelines, viewer))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    /**
     * Returns the pull requests for the Dashboard: the open pull requests of the viewer that need an action, from each
     * workspace. Bitbucket has no list of the review requests of a user across repositories, so the Dashboard shows no
     * Bitbucket review requests. The Review view shows them for each repository.
     */
    async dashboardPullRequests(scope: string[] | undefined): Promise<DashboardPullRequests> {
        const viewer = await this.viewer();
        const user = viewer.uuid ?? viewer.account_id;
        if (!user) return { reviewRequests: [], myPullRequests: [] };
        const workspaces = await this.workspaces(scope);
        const lists = await Promise.all(
            workspaces.map(workspace =>
                this.client
                    .request<Page<BbPullRequest>>(
                        'GET',
                        `/workspaces/${encodeURIComponent(workspace)}/pullrequests/${encodeURIComponent(user)}?state=OPEN&pagelen=50&${LIST_FIELDS}`
                    )
                    .then(
                        page => page?.values ?? [],
                        () => [] as BbPullRequest[]
                    )
            )
        );
        const myPullRequests: MyPullRequestItem[] = [];
        for (const pr of lists.flat()) {
            const repo = repoOfPullRequest(pr);
            const item = repo ? myPullRequestItemOf(repo, pr) : undefined;
            if (item) myPullRequests.push(item);
        }
        return { reviewRequests: [], myPullRequests };
    }

    async branchStatus(root: string): Promise<BranchStatus | null> {
        const ref = await this.repoFor(root);
        if (!ref) return null;
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const localSha = await git(root, ['rev-parse', 'HEAD']);
        let pullRequest: PullRequest | null = null;
        if (branch !== 'HEAD') {
            const list = await this.pullRequestPage(
                repo,
                `state=OPEN&state=MERGED&state=DECLINED&q=${encodeURIComponent(`source.branch.name=${quoted(branch)}`)}&sort=-created_on&pagelen=10`
            );
            const pick = list.find(pr => pr.state === 'OPEN') ?? list[0];
            if (pick) pullRequest = await this.pullRequest(root, pick.id);
        }
        return {
            repo: bitbucketRepoRef(ref),
            branch,
            sha: pullRequest?.state === 'OPEN' && pullRequest.headRefOid ? pullRequest.headRefOid : localSha,
            pullRequest,
            host: 'bitbucket',
            createUrl: bitbucketCreatePullRequestUrl(ref, branch)
        };
    }

    async mergedBranches(root: string): Promise<Record<string, MergedPullRequest>> {
        if (!(await this.repoFor(root))) return {};
        const repo = await this.resolve(root);
        const page = await this.client.request<Page<BbPullRequest>>('GET', `${repo.api}/pullrequests?state=MERGED&sort=-updated_on&pagelen=50`);
        return mergedBranches(page?.values ?? []);
    }

    async branchSummaries(root: string): Promise<Record<string, BranchSummary>> {
        if (!(await this.repoFor(root))) return {};
        const repo = await this.resolve(root);
        const [prs, pipelines, viewer] = await Promise.all([this.openPullRequests(repo), this.recentPipelines(repo), this.viewer().catch(() => undefined)]);
        return branchSummaries(prs, pipelines, viewer);
    }

    async createPullRequest(root: string, request: NewPullRequest): Promise<number> {
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branch === 'HEAD') throw new BitbucketError('The worktree has no branch (detached HEAD).', 0);
        const created = await this.client.request<BbPullRequest>('POST', `${repo.api}/pullrequests`, {
            title: request.title,
            description: request.body,
            source: { branch: { name: branch } },
            destination: { branch: { name: request.base || repo.repository.mainbranch?.name || 'main' } },
            draft: request.draft
        });
        return created.id;
    }

    /** The branch with its merge strategies. A failure gives undefined, so all strategies show. */
    private branch(repo: ResolvedRepo, name: string): Promise<BbBranch | undefined> {
        const key = `${keyOf(repo.ref)}@${name}`;
        let branch = this.branchCache.get(key);
        if (!branch) {
            branch = this.client.request<BbBranch>('GET', `${repo.api}/refs/branches/${encodeURIComponent(name)}`).catch(() => {
                this.branchCache.delete(key);
                return undefined;
            });
            this.branchCache.set(key, branch);
        }
        return branch;
    }

    async pullRequest(target: RepoTarget, number: number): Promise<PullRequest> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        const [pr, comments, commits, diffstat, statuses, viewer] = await Promise.all([
            this.client.request<BbPullRequest>('GET', base),
            this.client.all<BbComment>(`${base}/comments?pagelen=100`, 10),
            this.client.all<BbCommit>(`${base}/commits`, 2),
            this.client.all<BbDiffStat>(`${base}/diffstat?pagelen=100`, 10).catch(() => undefined),
            this.client.request<Page<BbCommitStatus>>('GET', `${base}/statuses?pagelen=100`).catch(() => undefined),
            this.viewer().catch(() => undefined)
        ]);
        this.rememberUsers([pr.author, ...(pr.reviewers ?? []), ...(pr.participants ?? []).map(item => item.user), ...comments.map(item => item.user)]);
        const branch = pr.destination.branch?.name ? await this.branch(repo, pr.destination.branch.name) : undefined;
        return mapPullRequest({ repo: repo.ref, pr, comments, commits, diffstat, branch, checkCount: statuses?.values?.length ?? 0, viewer });
    }

    async pullRequestFiles(target: RepoTarget, number: number): Promise<PullRequestFile[]> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        const [diffstat, diff] = await Promise.all([this.client.all<BbDiffStat>(`${base}/diffstat?pagelen=100`, 30), this.client.text(`${base}/diff`)]);
        const viewed = this.viewed.get(this.prKey(repo.ref, number)) ?? new Set<string>();
        return mapFiles(diffstat, diff).map(file => ({ ...file, viewed: viewed.has(file.path) }));
    }

    async setFileViewed(pullRequestId: string, filePath: string, viewed: boolean): Promise<void> {
        const decoded = decodeBitbucketId(pullRequestId);
        if (!decoded) throw new BitbucketError('The pull request ID is not a Bitbucket ID.', 0);
        const key = this.prKey(decoded.repo, decoded.id);
        const set = this.viewed.get(key) ?? new Set<string>();
        if (viewed) set.add(filePath);
        else set.delete(filePath);
        this.viewed.set(key, set);
    }

    async commitFiles(target: RepoTarget, sha: string): Promise<CommitFiles> {
        const repo = await this.resolve(target);
        const spec = encodeURIComponent(sha);
        const [commit, diffstat, diff] = await Promise.all([
            this.client.request<BbCommit>('GET', `${repo.api}/commit/${spec}`),
            this.client.all<BbDiffStat>(`${repo.api}/diffstat/${spec}?pagelen=100`, 30),
            this.client.text(`${repo.api}/diff/${spec}`)
        ]);
        return { parentSha: commit.parents?.[0]?.hash ?? null, files: mapFiles(diffstat, diff) };
    }

    async fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
        const repo = await this.resolve(target);
        const read = async (filePath: string, sha: string): Promise<string | undefined> => {
            try {
                const text = await this.client.text(`${repo.api}/src/${encodeURIComponent(sha)}/${encodePath(filePath)}`);
                if (text.length > MAX_FILE_BYTES || text.slice(0, 8000).includes('\0')) return undefined;
                return text;
            } catch (error) {
                if (error instanceof BitbucketError && error.status === 404) return '';
                throw error;
            }
        };
        const [baseText, headText] = await Promise.all([
            file.status === 'added' || !baseSha ? Promise.resolve('') : read(file.previousPath ?? file.path, baseSha),
            file.status === 'removed' ? Promise.resolve('') : read(file.path, headSha)
        ]);
        if (baseText === undefined || headText === undefined) return { base: '', head: '', unavailable: true };
        return { base: baseText, head: headText };
    }

    /**
     * Sends a review: each pending comment becomes an inline comment, the body becomes a comment, and the event
     * approves, removes the approval, or requests changes.
     */
    async submitReview(target: RepoTarget, number: number, _headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        for (const comment of comments) {
            const right = comment.side === 'RIGHT';
            const inline: Record<string, unknown> = { path: comment.path, [right ? 'to' : 'from']: comment.line };
            if (comment.startLine !== undefined && comment.startLine !== comment.line) inline[right ? 'start_to' : 'start_from'] = comment.startLine;
            await this.client.request('POST', `${base}/comments`, { content: { raw: comment.body }, inline });
        }
        if (body.trim()) {
            await this.client.request('POST', `${base}/comments`, { content: { raw: body } });
        }
        if (event === 'APPROVE') await this.client.request('POST', `${base}/approve`);
        else if (event === 'UNAPPROVE') await this.client.request('DELETE', `${base}/approve`);
        else if (event === 'REQUEST_CHANGES') await this.client.request('POST', `${base}/request-changes`);
    }

    /** Adds a reply to a thread. `commentId` is the `databaseId` of the comments of the thread: the ID of its first comment. */
    async replyToComment(target: RepoTarget, number: number, commentId: number, body: string): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${this.prApi(repo, number)}/comments`, { content: { raw: body }, parent: { id: commentId } });
    }

    /** Resolves a thread, or opens it again. */
    async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
        const decoded = decodeBitbucketId(threadId);
        if (!decoded?.commentId) throw new BitbucketError('The thread ID is not a Bitbucket thread ID.', 0);
        await this.client.request(
            resolved ? 'POST' : 'DELETE',
            `${bitbucketRepoApi(decoded.repo)}/pullrequests/${decoded.id}/comments/${decoded.commentId}/resolve`
        );
    }

    /** Bitbucket has no reactions on comments, so `reactionKinds` is empty. */
    async setReaction(): Promise<void> {
        throw new BitbucketError('Bitbucket has no reactions on comments.', 0);
    }

    /**
     * Merges the pull request with the strategy of the branch that has the method. Bitbucket has no check of the head
     * commit, so ShipWarden compares the head commit first and refuses the merge after a new push.
     */
    async merge(target: RepoTarget, number: number, headSha: string, method: MergeMethod): Promise<void> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        const pr = await this.client.request<BbPullRequest>('GET', base);
        const current = pr.source.commit?.hash ?? '';
        if (headSha && current && !headSha.startsWith(current) && !current.startsWith(headSha)) {
            throw new BitbucketError('The branch has new commits. Load the pull request again and check the changes before you merge.', 409);
        }
        const branch = pr.destination.branch?.name ? await this.branch(repo, pr.destination.branch.name) : undefined;
        await this.client.request('POST', `${base}/merge`, {
            type: 'pullrequest',
            merge_strategy: strategyForMethod(method, branch?.merge_strategies, branch?.default_merge_strategy),
            close_source_branch: pr.close_source_branch ?? false
        });
    }

    /** Returns the UUID of a user by login. The user must be in a pull request or in the list of candidates. */
    private async userUuid(target: RepoTarget, login: string): Promise<string> {
        let uuid = this.userUuids.get(login.toLowerCase());
        if (!uuid) {
            await this.pullRequestCandidates(target).catch(() => undefined);
            uuid = this.userUuids.get(login.toLowerCase());
        }
        if (!uuid) throw new BitbucketError(`ShipWarden cannot find the Bitbucket user "${login}".`, 404);
        return uuid;
    }

    /**
     * Updates a pull request. The update always sends the title and the reviewers, because Bitbucket can remove the
     * reviewers of an update without them.
     */
    private async update(repo: ResolvedRepo, number: number, change: (pr: BbPullRequest) => Record<string, unknown>): Promise<void> {
        const base = this.prApi(repo, number);
        const pr = await this.client.request<BbPullRequest>('GET', base);
        await this.client.request('PUT', base, {
            title: pr.title,
            reviewers: (pr.reviewers ?? []).filter(user => user.uuid).map(user => ({ uuid: user.uuid })),
            ...change(pr)
        });
    }

    async changePullRequest(target: RepoTarget, number: number, change: PullRequestChange): Promise<void> {
        const repo = await this.resolve(target);
        switch (change.kind) {
            case 'details': {
                if (change.title !== undefined || change.body !== undefined) {
                    await this.update(repo, number, () => ({
                        ...(change.title !== undefined ? { title: change.title } : {}),
                        ...(change.body !== undefined ? { description: change.body } : {})
                    }));
                }
                if (change.state === 'closed') await this.client.request('POST', `${this.prApi(repo, number)}/decline`);
                if (change.state === 'open') throw new BitbucketError('The Bitbucket API cannot open a declined pull request again.', 0);
                return;
            }
            case 'base':
                await this.update(repo, number, () => ({ destination: { branch: { name: change.base } } }));
                return;
            case 'draft':
                await this.update(repo, number, () => ({ draft: change.draft }));
                return;
            case 'autoMerge':
                throw new BitbucketError('Bitbucket Cloud has no API for auto-merge.', 0);
            case 'assignee':
                throw new BitbucketError('Bitbucket pull requests have no assignees.', 0);
            case 'label':
                throw new BitbucketError('Bitbucket pull requests have no labels.', 0);
            case 'reviewer': {
                if (change.reviewer.kind === 'team') throw new BitbucketError('Bitbucket has no team reviewers.', 0);
                const uuid = await this.userUuid(target, change.reviewer.login);
                await this.update(repo, number, pr => {
                    const current = (pr.reviewers ?? []).map(user => user.uuid).filter((item): item is string => !!item);
                    const next = change.add ? [...new Set([...current, uuid])] : current.filter(item => item !== uuid);
                    return { reviewers: next.map(item => ({ uuid: item })) };
                });
                return;
            }
        }
    }

    /**
     * The members of the workspace, for the reviewer picker. A token without access to the members gives the default
     * reviewers of the repository. Bitbucket has no labels.
     */
    async pullRequestCandidates(target: RepoTarget): Promise<PullRequestCandidates> {
        const repo = await this.resolve(target);
        let users: BbUser[];
        try {
            users = (await this.client.all<{ user: BbUser }>(`/workspaces/${encodeURIComponent(repo.ref.workspace)}/members?pagelen=100`, 3)).map(
                item => item.user
            );
        } catch {
            users = (await this.client.all<{ user: BbUser }>(`${repo.api}/effective-default-reviewers?pagelen=100`, 1).catch(() => [])).map(item => item.user);
        }
        this.rememberUsers(users);
        return { users: candidateUsers(users), labels: [] };
    }

    /** Bitbucket issues are a separate, optional tracker. The comment box shows no "#" list for Bitbucket. */
    async issueReferences(): Promise<IssueReference[]> {
        return [];
    }

    async issueReference(): Promise<IssueReference | null> {
        return null;
    }

    /** Returns the pipeline and the step of a job ID of the UI. */
    private stepOf(jobId: number): { pipeline: string; step: string } {
        const key = this.ids.keyOf(jobId);
        const match = key ? /^step:(\{[^}]+\}):(\{[^}]+\})$/.exec(key) : null;
        if (!match) throw new BitbucketError('ShipWarden does not know this step. Load the checks again.', 0);
        return { pipeline: match[1], step: match[2] };
    }

    /** Returns the pipeline UUID of a run ID of the UI. */
    private pipelineOf(runId: number): string {
        const key = this.ids.keyOf(runId);
        if (!key?.startsWith('pipeline:')) throw new BitbucketError('ShipWarden does not know this pipeline. Load the pipelines again.', 0);
        return key.slice('pipeline:'.length);
    }

    /** The steps of a pipeline as checks. */
    private async pipelineSteps(repo: ResolvedRepo, pipeline: BbPipeline): Promise<CheckRun[]> {
        const steps = await this.client.all<BbStep>(`${repo.api}/pipelines/${encodeURIComponent(pipeline.uuid)}/steps/?pagelen=100`, 2);
        return steps.map(step => stepToCheck(repo.ref, pipeline, step, this.ids));
    }

    /**
     * The checks of a commit: the steps of its newest pipeline, and the commit statuses of other CI services.
     * The statuses of Bitbucket Pipelines stay out when the steps show. Without a pipeline, all statuses show.
     */
    async checks(target: RepoTarget, sha: string): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        const [statuses, pipelines] = await Promise.all([
            this.client.all<BbCommitStatus>(`${repo.api}/commit/${encodeURIComponent(sha)}/statuses?pagelen=100`, 2),
            this.client.request<Page<BbPipeline>>('GET', `${repo.api}/pipelines/?sort=-created_on&pagelen=30`).then(
                page => page?.values ?? [],
                () => [] as BbPipeline[]
            )
        ]);
        const pipeline = pipelines
            .filter(item => {
                const hash = item.target?.commit?.hash ?? '';
                return !!hash && (hash.startsWith(sha) || sha.startsWith(hash));
            })
            .sort((a, b) => b.build_number - a.build_number)[0];
        const steps = pipeline ? await this.pipelineSteps(repo, pipeline) : [];
        const others = statuses.filter(status => steps.length === 0 || !isPipelinesStatus(status)).map(status => commitStatusToCheckRun(status, this.ids));
        return [...steps, ...others];
    }

    async jobProgress(target: RepoTarget, jobId: number): Promise<JobProgress> {
        const repo = await this.resolve(target);
        const { pipeline, step } = this.stepOf(jobId);
        return stepProgressOf(
            await this.client.request<BbStep>('GET', `${repo.api}/pipelines/${encodeURIComponent(pipeline)}/steps/${encodeURIComponent(step)}`)
        );
    }

    /** The log of a step, without the color codes. A step that did not start has no log yet. */
    async jobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        const { pipeline, step } = this.stepOf(jobId);
        try {
            return cleanBitbucketLog(await this.client.text(`${repo.api}/pipelines/${encodeURIComponent(pipeline)}/steps/${encodeURIComponent(step)}/log`));
        } catch (error) {
            if (error instanceof BitbucketError && error.status === 404) return '';
            throw error;
        }
    }

    async saveJobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        const folder = path.join(os.homedir(), '.shipwarden', 'ci-logs');
        await fs.mkdir(folder, { recursive: true });
        const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, '_');
        const file = path.join(folder, `${safe(repo.ref.workspace)}-${safe(repo.ref.repo)}-step-${jobId}.log`);
        await fs.writeFile(file, await this.jobLog(target, jobId));
        return file;
    }

    /** Starts a new pipeline with the target of a pipeline. Bitbucket has no API that runs one step again. */
    private async runAgain(repo: ResolvedRepo, pipelineUuid: string): Promise<void> {
        const pipeline = await this.client.request<BbPipeline>('GET', `${repo.api}/pipelines/${encodeURIComponent(pipelineUuid)}`);
        await this.client.request('POST', `${repo.api}/pipelines/`, { target: rerunTarget(pipeline.target) });
    }

    /** Runs the pipeline of the step again. The Bitbucket API cannot run one step again. */
    async rerunJob(target: RepoTarget, jobId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.runAgain(repo, this.stepOf(jobId).pipeline);
    }

    /** Runs the pipeline again. The Bitbucket API cannot run only the failed steps again. */
    async rerunFailedJobs(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.runAgain(repo, this.pipelineOf(runId));
    }

    /** A Bitbucket repository has one pipeline definition (bitbucket-pipelines.yml). It can start by hand on a branch. */
    async workflows(target: RepoTarget, _ref: string): Promise<Workflow[]> {
        await this.resolve(target);
        return [{ id: BITBUCKET_PIPELINE_WORKFLOW_ID, name: 'Pipeline', path: 'bitbucket-pipelines.yml', dispatchable: true, inputs: [] }];
    }

    /** Starts a new pipeline on a branch. The inputs become variables of the pipeline. */
    async dispatchWorkflow(target: RepoTarget, _workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void> {
        const repo = await this.resolve(target);
        const variables = Object.entries(inputs ?? {}).map(([key, value]) => ({ key, value }));
        await this.client.request('POST', `${repo.api}/pipelines/`, {
            target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: ref },
            ...(variables.length > 0 ? { variables } : {})
        });
    }

    async workflowRuns(target: RepoTarget, _workflowId?: number): Promise<WorkflowRun[]> {
        const repo = await this.resolve(target);
        const page = await this.client.request<Page<BbPipeline>>('GET', `${repo.api}/pipelines/?sort=-created_on&pagelen=40`);
        const pipelines = page?.values ?? [];
        return pipelines.map(pipeline => pipelineToRun(repo.ref, pipeline, this.ids));
    }

    async runJobs(target: RepoTarget, runId: number): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        const pipeline = await this.client.request<BbPipeline>('GET', `${repo.api}/pipelines/${encodeURIComponent(this.pipelineOf(runId))}`);
        return this.pipelineSteps(repo, pipeline);
    }

    async cancelRun(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${repo.api}/pipelines/${encodeURIComponent(this.pipelineOf(runId))}/stopPipeline`);
    }

    /** Runs a pipeline again: a new pipeline with the same target. */
    async rerunRun(target: RepoTarget, runId: number): Promise<void> {
        await this.rerunFailedJobs(target, runId);
    }

    async branches(target: RepoTarget): Promise<string[]> {
        const repo = await this.resolve(target);
        const data = await this.client.all<{ name: string }>(`${repo.api}/refs/branches?pagelen=100&sort=-target.date`, 3);
        const main = repo.repository.mainbranch?.name || 'main';
        return [main, ...data.map(item => item.name).filter(name => name !== main)];
    }
}

/** The users of the pickers. */
export function candidateUsers(users: readonly BbUser[]): GitHubUser[] {
    return users.map(userOf).filter((user): user is GitHubUser => !!user);
}
