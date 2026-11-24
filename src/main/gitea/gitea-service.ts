import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DashboardPullRequests, MyPullRequestItem, ReviewRequestItem } from '@shared/dashboard';
import {
    cleanActionsLog,
    type BranchStatus,
    type BranchSummary,
    type CheckRun,
    type CommitFiles,
    type FileVersions,
    type GitHubRepoInfo,
    type GitHubUser,
    type IssueReference,
    type JobProgress,
    type MergedPullRequest,
    type MergeMethod,
    type NewPullRequest,
    type PendingComment,
    type PullRequest,
    type PullRequestCandidates,
    type PullRequestChange,
    type PullRequestFile,
    type PullRequestFilter,
    type PullRequestSummary,
    type RepoRef,
    type RepoTarget,
    type ReviewEvent,
    type Workflow
} from '@shared/github';
import {
    decodeGiteaId,
    giteaCreatePullRequestUrl,
    giteaDraftTitle,
    giteaRepoApi,
    giteaRepoOf,
    giteaRepoRef,
    giteaRepoWebUrl,
    parseGiteaRemote,
    parseServerVersion,
    type GiteaRepoRef
} from '@shared/gitea';
import type { WorkflowRun } from '@shared/pipelines';
import { matchesSearch, type RepoPullRequests } from '@shared/review-queue';
import { parseWorkflowFile } from '../github/workflow-file';
import type { UploadFile } from '../screenshots/screenshot-upload';
import type { SourceHost } from '../source-host';
import { type GiteaClient, GiteaError } from './gitea-client';
import {
    branchSummaries,
    isActionsStatus,
    isDraft,
    jobProgressOf,
    jobToCheck,
    labelOf,
    latestRuns,
    mapDiffFiles,
    mapPullRequest,
    mergedBranches,
    myPullRequestItemOf,
    NumericIds,
    openPullRequestOf,
    pullRequestSummaryOf,
    repoOfIssue,
    reviewRequestItemOf,
    runStatesBySha,
    runToWorkflowRun,
    statusToCheck,
    tasksToRuns,
    taskToCheck,
    userOf,
    viewerIsReviewer,
    workflowKey,
    type GtCombinedStatus,
    type GtCommit,
    type GtIssue,
    type GtIssueComment,
    type GtJob,
    type GtLabel,
    type GtPullRequest,
    type GtRepo,
    type GtReview,
    type GtReviewComment,
    type GtRun,
    type GtTask,
    type GtUser,
    type ThreadPlace
} from './gitea-mapping';

/** The diff view does not load file versions that are larger than this limit. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The most reviews whose line comments ShipWarden loads for one pull request. Each review is one request. */
const MAX_REVIEWS_WITH_COMMENTS = 30;

/** The most pull requests of the viewer that the Dashboard loads one by one, for their merge state. */
const MAX_DASHBOARD_PULLS = 20;

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

/**
 * The Actions API of a repository. "runs": the newer API with runs, jobs, and job logs. "tasks": the older API with
 * only a list of tasks. "none": no Actions API (an old server, or Actions is off for the repository).
 */
export type ActionsApi = 'runs' | 'tasks' | 'none';

/** A repository with its API path and its settings from the server. */
interface ResolvedRepo {
    ref: GiteaRepoRef;
    /** The API path of the repository, for example "/repos/acme/api". */
    api: string;
    info: GtRepo;
}

/** The path of a repository for the cache keys, in lowercase. */
function keyOf(ref: GiteaRepoRef): string {
    return `${ref.owner}/${ref.repo}`.toLowerCase();
}

/** True for an error that tells that the server has no such API: 404 (not found) or 405 (method not allowed). */
function isMissingApi(error: unknown): boolean {
    return error instanceof GiteaError && (error.status === 404 || error.status === 405);
}

/** Encodes each part of a file path for a URL. The "/" between the parts stays. */
function encodePath(filePath: string): string {
    return filePath.split('/').map(encodeURIComponent).join('/');
}

/**
 * Reads and changes the pull requests and the Actions runs of one Gitea or Forgejo server.
 * A target is a worktree path with a remote on the server, or a Gitea reference from the Review view or the
 * Pipelines view (see `giteaRepoOf`).
 */
export class GiteaService implements SourceHost {
    readonly kind = 'gitea' as const;

    private readonly remotes = new Map<string, GiteaRepoRef | null>();
    private readonly repos = new Map<string, Promise<GtRepo>>();
    private readonly labels = new Map<string, Promise<GtLabel[]>>();
    private readonly actions = new Map<string, Promise<ActionsApi>>();
    /** The repositories whose server refused a workflow dispatch, so their workflows cannot start by hand. */
    private readonly noDispatch = new Set<string>();
    /** The place of each thread by its first comment, for a reply without the replies API. */
    private readonly places = new Map<string, ThreadPlace>();
    /** The files that the user marked as viewed, by pull request. The API has no such state, so it stays in memory. */
    private readonly viewed = new Map<string, Set<string>>();
    /** The numeric IDs of the workflow files, for the Pipelines view. */
    private readonly ids = new NumericIds();
    private viewerPromise: Promise<GtUser> | undefined;

    constructor(
        private readonly client: GiteaClient,
        private readonly readRemote: (root: string) => Promise<string> = root => git(root, ['remote', 'get-url', 'origin'])
    ) {}

    /** Returns the repository of a worktree from its "origin" remote. Returns null for a remote on another server. */
    async repoFor(root: string): Promise<GiteaRepoRef | null> {
        if (!this.remotes.has(root)) {
            const base = this.client.baseUrl();
            const url = await this.readRemote(root).catch(() => '');
            const ref = base ? parseGiteaRemote(url, [base]) : undefined;
            this.remotes.set(root, ref && ref.host === this.client.host() ? ref : null);
        }
        return this.remotes.get(root)!;
    }

    /** True when the target is a worktree with a remote on this server, or a Gitea reference of this server. */
    async owns(target: RepoTarget): Promise<boolean> {
        if (typeof target !== 'string') return !!this.client.host() && giteaRepoOf(target)?.host === this.client.host();
        return (await this.repoFor(target)) !== null;
    }

    private async refOf(target: RepoTarget): Promise<GiteaRepoRef> {
        const host = this.client.host() ?? 'the server';
        if (typeof target === 'string') {
            const ref = await this.repoFor(target);
            if (!ref) throw new GiteaError(`The "origin" remote of this worktree is not a repository on ${host}.`, 0);
            return ref;
        }
        const ref = giteaRepoOf(target);
        if (!ref || ref.host !== this.client.host()) throw new GiteaError(`"${target.owner}/${target.name}" is not a repository on ${host}.`, 0);
        return ref;
    }

    private async resolve(target: RepoTarget): Promise<ResolvedRepo> {
        const ref = await this.refOf(target);
        const api = giteaRepoApi(ref);
        const key = keyOf(ref);
        let info = this.repos.get(key);
        if (!info) {
            info = this.client.request<GtRepo>('GET', api);
            this.repos.set(key, info);
            info.catch(() => this.repos.delete(key));
        }
        return { ref, api, info: await info };
    }

    /** Returns the user of the token. */
    private viewer(): Promise<GtUser> {
        if (!this.viewerPromise) {
            const viewer = this.client.request<GtUser>('GET', '/user');
            this.viewerPromise = viewer;
            viewer.catch(() => {
                if (this.viewerPromise === viewer) this.viewerPromise = undefined;
            });
        }
        return this.viewerPromise;
    }

    private prKey(ref: GiteaRepoRef, number: number): string {
        return `${keyOf(ref)}#${number}`;
    }

    /** The web page of a repository. The API gives it with the right protocol and folder. */
    private webUrl(repo: ResolvedRepo): string {
        return repo.info.html_url ?? giteaRepoWebUrl(repo.ref);
    }

    /**
     * Finds the Actions API of a repository: the newer runs API, else the older tasks API, else none.
     * The answer stays for the life of the service. An error that is not "not found" is not kept.
     */
    private actionsApi(repo: ResolvedRepo): Promise<ActionsApi> {
        const key = keyOf(repo.ref);
        let known = this.actions.get(key);
        if (!known) {
            known = (async (): Promise<ActionsApi> => {
                try {
                    await this.client.request('GET', `${repo.api}/actions/runs?limit=1`);
                    return 'runs';
                } catch (error) {
                    if (!isMissingApi(error)) throw error;
                }
                try {
                    await this.client.request('GET', `${repo.api}/actions/tasks?limit=1`);
                    return 'tasks';
                } catch (error) {
                    if (!isMissingApi(error)) throw error;
                }
                return 'none';
            })();
            this.actions.set(key, known);
            known.catch(() => this.actions.delete(key));
        }
        return known;
    }

    /** The newest runs of the repository. Empty without the runs API. */
    private async recentRuns(repo: ResolvedRepo, query = ''): Promise<GtRun[]> {
        if ((await this.actionsApi(repo)) !== 'runs') return [];
        const data = await this.client.request<{ workflow_runs?: GtRun[] | null }>('GET', `${repo.api}/actions/runs?limit=50${query}`);
        return data?.workflow_runs ?? [];
    }

    /** The CI state of each commit from the newest runs, for the lists. A failure gives no states. */
    private runStates(repo: ResolvedRepo): Promise<Map<string, string>> {
        return this.recentRuns(repo).then(runStatesBySha, () => new Map<string, string>());
    }

    /**
     * Returns the repositories of the user on the server, for the Review view and the Pipelines view. A scope reads the
     * repositories of each organization or user in it. The newest change comes first.
     */
    async repositories(scope: string[] | undefined): Promise<GitHubRepoInfo[]> {
        const host = this.client.host();
        if (!host) return [];
        const lists = scope
            ? await Promise.all(
                  scope.map(name =>
                      this.client.all<GtRepo>(`/orgs/${encodeURIComponent(name)}/repos`, 2).catch(error => {
                          if (!isMissingApi(error)) throw error;
                          return this.client.all<GtRepo>(`/users/${encodeURIComponent(name)}/repos`, 2);
                      })
                  )
              )
            : [await this.client.all<GtRepo>('/user/repos', 3)];
        return lists
            .flat()
            .filter(repo => !repo.archived && repo.owner?.login)
            .map(repo => ({ ...giteaRepoRef({ host, owner: repo.owner.login, repo: repo.name }), ...(repo.updated_at ? { pushedAt: repo.updated_at } : {}) }))
            .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
    }

    /** Returns the open pull requests of a repository, for the review queue of the Review view. */
    async repoPullRequests(target: RepoRef): Promise<RepoPullRequests> {
        const repo = await this.resolve(target);
        const [prs, states, viewer] = await Promise.all([
            this.client.all<GtPullRequest>(`${repo.api}/pulls?state=open&sort=recentupdate`, 2),
            this.runStates(repo),
            this.viewer().catch(() => undefined)
        ]);
        const pullRequests = prs.map(pr => openPullRequestOf(repo.ref, pr, states, viewer));
        return { viewer: viewer?.login ?? '', openCount: pullRequests.length, pullRequests };
    }

    /** Returns the pull requests of a repository for a filter of the Review view, the newest change first. */
    async pullRequests(target: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]> {
        const repo = await this.resolve(target);
        const needsViewer = filter === 'review' || filter === 'mine' || filter === 'assigned';
        const viewer = needsViewer ? await this.viewer() : await this.viewer().catch(() => undefined);
        const open = filter !== 'closed' && filter !== 'merged';
        const [prs, states] = await Promise.all([
            this.client.all<GtPullRequest>(`${repo.api}/pulls?state=${open ? 'open' : 'closed'}&sort=recentupdate`, 2),
            open ? this.runStates(repo) : Promise.resolve(new Map<string, string>())
        ]);
        const login = viewer?.login.toLowerCase();
        const text = query?.trim();
        return prs
            .filter(pr => filter !== 'merged' || pr.merged)
            .filter(pr => filter !== 'review' || viewerIsReviewer(pr, viewer))
            .filter(pr => filter !== 'mine' || pr.user.login.toLowerCase() === login)
            .filter(pr => filter !== 'assigned' || (pr.assignees ?? []).some(user => user.login.toLowerCase() === login))
            .filter(pr => !text || matchesSearch({ number: pr.number, title: pr.title, author: pr.user.login, headRefName: pr.head.ref }, text))
            .map(pr => pullRequestSummaryOf(pr, states, viewer))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    /**
     * Returns the pull requests for the Dashboard: the open pull requests that ask the viewer for a review, and the open
     * pull requests of the viewer that need an action. The issue search gives both lists. Each pull request of the viewer
     * needs one more request for its merge state, at most `MAX_DASHBOARD_PULLS`.
     */
    async dashboardPullRequests(scope: string[] | undefined): Promise<DashboardPullRequests> {
        const host = this.client.host();
        if (!host) return { reviewRequests: [], myPullRequests: [] };
        const [reviewing, mine] = await Promise.all([
            this.client.request<GtIssue[]>('GET', '/repos/issues/search?type=pulls&state=open&review_requested=true&limit=50'),
            this.client.request<GtIssue[]>('GET', '/repos/issues/search?type=pulls&state=open&created=true&limit=50')
        ]);
        const inScope = (repo: GiteaRepoRef | undefined): repo is GiteaRepoRef =>
            !!repo && (!scope || scope.some(name => name.toLowerCase() === repo.owner.toLowerCase()));
        const reviewRequests: ReviewRequestItem[] = [];
        for (const issue of reviewing ?? []) {
            const repo = repoOfIssue(host, issue);
            if (inScope(repo) && !issue.pull_request?.draft) reviewRequests.push(reviewRequestItemOf(repo, issue));
        }
        const own = (mine ?? []).flatMap(issue => {
            const repo = repoOfIssue(host, issue);
            return inScope(repo) ? [{ repo, issue }] : [];
        });
        const items = await Promise.all(
            own.slice(0, MAX_DASHBOARD_PULLS).map(async ({ repo, issue }) => {
                const pr = await this.client.request<GtPullRequest>('GET', `${giteaRepoApi(repo)}/pulls/${issue.number}`).catch(() => undefined);
                return pr ? myPullRequestItemOf(repo, pr) : undefined;
            })
        );
        return { reviewRequests, myPullRequests: items.filter((item): item is MyPullRequestItem => !!item) };
    }

    async branchStatus(root: string): Promise<BranchStatus | null> {
        const ref = await this.repoFor(root);
        if (!ref) return null;
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const localSha = await git(root, ['rev-parse', 'HEAD']);
        let pullRequest: PullRequest | null = null;
        if (branch !== 'HEAD') {
            const list = await this.client.request<GtPullRequest[]>('GET', `${repo.api}/pulls?state=all&sort=recentupdate&limit=50`);
            const own = (list ?? []).filter(pr => pr.head.ref === branch);
            const pick = own.find(pr => pr.state === 'open') ?? own[0];
            if (pick) pullRequest = await this.pullRequest(root, pick.number);
        }
        return {
            repo: giteaRepoRef(ref),
            branch,
            sha: pullRequest?.state === 'OPEN' && pullRequest.headRefOid ? pullRequest.headRefOid : localSha,
            pullRequest,
            host: 'gitea',
            createUrl: giteaCreatePullRequestUrl(this.webUrl(repo), repo.info.default_branch || 'main', branch)
        };
    }

    async mergedBranches(root: string): Promise<Record<string, MergedPullRequest>> {
        if (!(await this.repoFor(root))) return {};
        const repo = await this.resolve(root);
        const prs = await this.client.request<GtPullRequest[]>('GET', `${repo.api}/pulls?state=closed&sort=recentupdate&limit=50`);
        return mergedBranches(prs ?? []);
    }

    async branchSummaries(root: string): Promise<Record<string, BranchSummary>> {
        if (!(await this.repoFor(root))) return {};
        const repo = await this.resolve(root);
        const [prs, states, viewer] = await Promise.all([
            this.client.all<GtPullRequest>(`${repo.api}/pulls?state=open&sort=recentupdate`, 2),
            this.runStates(repo),
            this.viewer().catch(() => undefined)
        ]);
        return branchSummaries(prs, states, viewer);
    }

    async createPullRequest(root: string, request: NewPullRequest): Promise<number> {
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branch === 'HEAD') throw new GiteaError('The worktree has no branch (detached HEAD).', 0);
        const created = await this.client.request<GtPullRequest>('POST', `${repo.api}/pulls`, {
            head: branch,
            base: request.base || repo.info.default_branch || 'main',
            title: request.draft ? giteaDraftTitle(request.title, true) : request.title,
            body: request.body
        });
        return created.number;
    }

    /** The labels of the repository, for the label colors and the label IDs. A failure gives no labels. */
    private repoLabels(repo: ResolvedRepo): Promise<GtLabel[]> {
        const key = keyOf(repo.ref);
        let labels = this.labels.get(key);
        if (!labels) {
            labels = this.client.all<GtLabel>(`${repo.api}/labels`, 2).catch(() => {
                this.labels.delete(key);
                return [];
            });
            this.labels.set(key, labels);
        }
        return labels;
    }

    /** Loads the line comments of the reviews that have comments. Each review is one request. */
    private async reviewComments(repo: ResolvedRepo, number: number, reviews: readonly GtReview[]): Promise<GtReviewComment[]> {
        const withComments = reviews
            .filter(review => review.state !== 'PENDING' && review.state !== 'REQUEST_REVIEW' && (review.comments_count ?? 0) > 0)
            .slice(-MAX_REVIEWS_WITH_COMMENTS);
        const lists = await Promise.all(
            withComments.map(review =>
                this.client
                    .request<GtReviewComment[]>('GET', `${repo.api}/pulls/${number}/reviews/${review.id}/comments`)
                    .then(list => (list ?? []).map(comment => ({ ...comment, pull_request_review_id: comment.pull_request_review_id ?? review.id })))
            )
        );
        return lists.flat();
    }

    async pullRequest(target: RepoTarget, number: number): Promise<PullRequest> {
        const repo = await this.resolve(target);
        const base = `${repo.api}/pulls/${number}`;
        const [pr, reviews, issueComments, commits, viewer] = await Promise.all([
            this.client.request<GtPullRequest>('GET', base),
            this.client.all<GtReview>(`${base}/reviews`, 3),
            this.client.all<GtIssueComment>(`${repo.api}/issues/${number}/comments`, 3),
            this.client.all<GtCommit>(`${base}/commits?stat=false&verification=false&files=false`, 2),
            this.viewer().catch(() => undefined)
        ]);
        const reviewComments = await this.reviewComments(repo, number, reviews);
        const { pullRequest, places } = mapPullRequest({ repo: repo.ref, pr, repoInfo: repo.info, reviews, reviewComments, issueComments, commits, viewer });
        const key = this.prKey(repo.ref, number);
        for (const [id, place] of places) this.places.set(`${key}#${id}`, place);
        return pullRequest;
    }

    async pullRequestFiles(target: RepoTarget, number: number): Promise<PullRequestFile[]> {
        const repo = await this.resolve(target);
        const viewed = this.viewed.get(this.prKey(repo.ref, number)) ?? new Set<string>();
        const diff = await this.client.text(`${repo.api}/pulls/${number}.diff`);
        return mapDiffFiles(diff).map(file => ({ ...file, viewed: viewed.has(file.path) }));
    }

    async setFileViewed(pullRequestId: string, filePath: string, viewed: boolean): Promise<void> {
        const decoded = decodeGiteaId(pullRequestId);
        if (!decoded) throw new GiteaError('The pull request ID is not a Gitea ID.', 0);
        const key = this.prKey(decoded.repo, decoded.number);
        const set = this.viewed.get(key) ?? new Set<string>();
        if (viewed) set.add(filePath);
        else set.delete(filePath);
        this.viewed.set(key, set);
    }

    async commitFiles(target: RepoTarget, sha: string): Promise<CommitFiles> {
        const repo = await this.resolve(target);
        const commitApi = `${repo.api}/git/commits/${encodeURIComponent(sha)}`;
        const [commit, diff] = await Promise.all([
            this.client.request<GtCommit>('GET', `${commitApi}?stat=false&verification=false&files=false`),
            this.client.text(`${commitApi}.diff`)
        ]);
        return { parentSha: commit.parents?.[0]?.sha ?? null, files: mapDiffFiles(diff) };
    }

    async fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
        const repo = await this.resolve(target);
        const read = async (filePath: string, sha: string): Promise<string | undefined> => {
            try {
                const text = await this.client.text(`${repo.api}/raw/${encodePath(filePath)}?ref=${encodeURIComponent(sha)}`);
                if (text.length > MAX_FILE_BYTES || text.slice(0, 8000).includes('\0')) return undefined;
                return text;
            } catch (error) {
                if (error instanceof GiteaError && error.status === 404) return '';
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
     * Sends a review with its line comments in one request. A comment on more than one line goes on its last line.
     * The server refuses an approval or a request for changes on a pull request of the user.
     */
    async submitReview(target: RepoTarget, number: number, headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void> {
        const repo = await this.resolve(target);
        const kind = event === 'APPROVE' ? 'APPROVED' : event === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES' : event === 'COMMENT' ? 'COMMENT' : undefined;
        if (!kind) throw new GiteaError(`Gitea and Forgejo do not accept the review "${event}".`, 0);
        await this.client.request('POST', `${repo.api}/pulls/${number}/reviews`, {
            event: kind,
            body,
            ...(headSha ? { commit_id: headSha } : {}),
            comments: comments.map(comment => ({
                path: comment.path,
                body: comment.body,
                ...(comment.side === 'LEFT' ? { old_position: comment.line } : { new_position: comment.line })
            }))
        });
    }

    /**
     * Adds a reply to a thread. `commentId` is the `databaseId` of the comments of the thread: the ID of its first comment.
     * A server without the replies API gets a review with one comment on the line of the thread. The server shows it in
     * the same conversation.
     */
    async replyToComment(target: RepoTarget, number: number, commentId: number, body: string): Promise<void> {
        const repo = await this.resolve(target);
        try {
            await this.client.request('POST', `${repo.api}/pulls/${number}/comments/${commentId}/replies`, { body });
            return;
        } catch (error) {
            if (!isMissingApi(error)) throw error;
        }
        const key = `${this.prKey(repo.ref, number)}#${commentId}`;
        if (!this.places.has(key)) await this.pullRequest(target, number);
        const place = this.places.get(key);
        if (!place?.line) throw new GiteaError('The thread does not exist, or it is not on a line. It was possibly deleted.', 404);
        const pr = await this.client.request<GtPullRequest>('GET', `${repo.api}/pulls/${number}`);
        await this.client.request('POST', `${repo.api}/pulls/${number}/reviews`, {
            event: 'COMMENT',
            body: '',
            commit_id: pr.head.sha,
            comments: [{ path: place.path, body, ...(place.side === 'LEFT' ? { old_position: place.line } : { new_position: place.line }) }]
        });
    }

    async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
        const decoded = decodeGiteaId(threadId);
        if (!decoded?.commentId) throw new GiteaError('The thread ID is not a Gitea thread ID.', 0);
        if (decoded.repo.host !== this.client.host()) throw new GiteaError(`The thread is not on ${this.client.host()}.`, 0);
        try {
            await this.client.request('POST', `${giteaRepoApi(decoded.repo)}/pulls/comments/${decoded.commentId}/${resolved ? 'resolve' : 'unresolve'}`);
        } catch (error) {
            if (!isMissingApi(error)) throw error;
            throw new GiteaError('This server has no API to resolve a conversation. Resolve it on the web page of the pull request.', 404);
        }
    }

    /** Reactions need one request for each comment, so `reactionKinds` is empty and this call is not used. */
    async setReaction(): Promise<void> {
        throw new GiteaError('ShipWarden does not support reactions on Gitea and Forgejo yet.', 0);
    }

    /** Merges the pull request. The server refuses the merge when the head branch has a newer commit than `headSha`. */
    async merge(target: RepoTarget, number: number, headSha: string, method: MergeMethod): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${repo.api}/pulls/${number}/merge`, { Do: method, ...(headSha ? { head_commit_id: headSha } : {}) });
    }

    async changePullRequest(target: RepoTarget, number: number, change: PullRequestChange): Promise<void> {
        const repo = await this.resolve(target);
        const base = `${repo.api}/pulls/${number}`;
        switch (change.kind) {
            case 'details': {
                const update: Record<string, unknown> = {};
                if (change.title !== undefined) update.title = change.title;
                if (change.body !== undefined) update.body = change.body;
                if (change.state) update.state = change.state;
                await this.client.request('PATCH', base, update);
                return;
            }
            case 'base':
                await this.client.request('PATCH', base, { base: change.base });
                return;
            case 'draft': {
                const pr = await this.client.request<GtPullRequest>('GET', base);
                if (isDraft(pr) !== change.draft) await this.client.request('PATCH', base, { title: giteaDraftTitle(pr.title, change.draft) });
                return;
            }
            case 'autoMerge':
                throw new GiteaError('ShipWarden does not support auto-merge on Gitea and Forgejo.', 0);
            case 'mergeQueue':
                throw new GiteaError('Gitea and Forgejo have no merge queue.', 0);
            case 'assignee': {
                const pr = await this.client.request<GtPullRequest>('GET', base);
                const current = (pr.assignees ?? []).map(user => user.login);
                const wanted = change.login.toLowerCase();
                const next = change.add
                    ? [...current.filter(login => login.toLowerCase() !== wanted), change.login]
                    : current.filter(login => login.toLowerCase() !== wanted);
                await this.client.request('PATCH', base, { assignees: next });
                return;
            }
            case 'reviewer': {
                const field = change.reviewer.kind === 'team' ? 'team_reviewers' : 'reviewers';
                await this.client.request(change.add ? 'POST' : 'DELETE', `${base}/requested_reviewers`, { [field]: [change.reviewer.login] });
                return;
            }
            case 'label': {
                const label = (await this.repoLabels(repo)).find(item => item.name.toLowerCase() === change.name.toLowerCase());
                if (!label) throw new GiteaError(`The repository has no label "${change.name}".`, 404);
                if (change.add) await this.client.request('POST', `${repo.api}/issues/${number}/labels`, { labels: [label.id] });
                else await this.client.request('DELETE', `${repo.api}/issues/${number}/labels/${label.id}`);
                return;
            }
        }
    }

    /** The users that can be assignees and reviewers, and the labels of the repository, for the pickers. */
    async pullRequestCandidates(target: RepoTarget): Promise<PullRequestCandidates> {
        const repo = await this.resolve(target);
        const [users, labels] = await Promise.all([this.client.request<GtUser[]>('GET', `${repo.api}/assignees`), this.repoLabels(repo)]);
        return { users: (users ?? []).map(userOf).filter((user): user is GitHubUser => !!user), labels: labels.map(labelOf) };
    }

    /** The comment box shows no "#" list for Gitea yet. */
    async issueReferences(): Promise<IssueReference[]> {
        return [];
    }

    async issueReference(): Promise<IssueReference | null> {
        return null;
    }

    /**
     * The checks of a commit. With the runs API, the jobs of the newest run of each workflow are checks with logs, and
     * the other commit statuses (for example of an external CI) are checks without logs. Without the runs API, all
     * commit statuses are checks without logs. Gitea Actions adds a commit status for each job.
     */
    async checks(target: RepoTarget, sha: string): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        const [combined, api] = await Promise.all([
            this.client.request<GtCombinedStatus>('GET', `${repo.api}/commits/${encodeURIComponent(sha)}/status`).catch(() => undefined),
            this.actionsApi(repo).catch((): ActionsApi => 'none')
        ]);
        const statuses = combined?.statuses ?? [];
        if (api !== 'runs') return statuses.map(statusToCheck);
        const runs = latestRuns((await this.recentRuns(repo, `&head_sha=${encodeURIComponent(sha)}`)).filter(run => run.head_sha === sha));
        const jobs = await Promise.all(runs.map(run => this.jobsOf(repo, run.id)));
        return [...jobs.flat().map(jobToCheck), ...statuses.filter(status => runs.length === 0 || !isActionsStatus(status)).map(statusToCheck)];
    }

    private async jobsOf(repo: ResolvedRepo, runId: number): Promise<GtJob[]> {
        const data = await this.client.request<{ jobs?: GtJob[] | null }>('GET', `${repo.api}/actions/runs/${runId}/jobs?limit=50`);
        return [...(data?.jobs ?? [])].sort((a, b) => a.id - b.id);
    }

    /** Throws an error when the repository has no runs API. Logs, steps, and runs again need it. */
    private async requireRuns(repo: ResolvedRepo): Promise<void> {
        if ((await this.actionsApi(repo)) !== 'runs') {
            throw new GiteaError('This server has no Actions API for jobs. Open the run on the web page.', 0);
        }
    }

    async jobProgress(target: RepoTarget, jobId: number): Promise<JobProgress> {
        const repo = await this.resolve(target);
        await this.requireRuns(repo);
        return jobProgressOf(await this.client.request<GtJob>('GET', `${repo.api}/actions/jobs/${jobId}`));
    }

    /** The log of a job, without the color codes and the time stamps. */
    async jobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        await this.requireRuns(repo);
        return cleanActionsLog(await this.client.text(`${repo.api}/actions/jobs/${jobId}/logs`));
    }

    async saveJobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        const folder = path.join(os.homedir(), '.shipwarden', 'ci-logs');
        await fs.mkdir(folder, { recursive: true });
        const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, '_');
        const file = path.join(folder, `${safe(repo.ref.owner)}-${safe(repo.ref.repo)}-job-${jobId}.log`);
        await fs.writeFile(file, await this.jobLog(target, jobId));
        return file;
    }

    /** Sends a request for a run or a job. A server without the API gives an error that tells the user to use the web page. */
    private async runAction(repo: ResolvedRepo, apiPath: string, action: string): Promise<void> {
        await this.requireRuns(repo);
        try {
            await this.client.request('POST', `${repo.api}${apiPath}`);
        } catch (error) {
            if (!isMissingApi(error)) throw error;
            throw new GiteaError(`This server has no API to ${action}. Do it on the web page of the run.`, 404);
        }
    }

    async rerunJob(target: RepoTarget, jobId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.requireRuns(repo);
        const job = await this.client.request<GtJob>('GET', `${repo.api}/actions/jobs/${jobId}`);
        await this.runAction(repo, `/actions/runs/${job.run_id}/jobs/${jobId}/rerun`, 'run a job again');
    }

    async rerunFailedJobs(target: RepoTarget, runId: number): Promise<void> {
        await this.runAction(await this.resolve(target), `/actions/runs/${runId}/rerun-failed-jobs`, 'run the failed jobs again');
    }

    async cancelRun(target: RepoTarget, runId: number): Promise<void> {
        await this.runAction(await this.resolve(target), `/actions/runs/${runId}/cancel`, 'cancel a run');
    }

    async rerunRun(target: RepoTarget, runId: number): Promise<void> {
        await this.runAction(await this.resolve(target), `/actions/runs/${runId}/rerun`, 'run a run again');
    }

    /**
     * The workflow folders that the server reads, in order. Forgejo reads ".forgejo/workflows" first. Both read
     * ".gitea/workflows" and then ".github/workflows". The server uses only the first folder that exists.
     */
    private async workflowFolders(): Promise<string[]> {
        const product = parseServerVersion(await this.client.version().catch(() => '')).product;
        return [...(product === 'Forgejo' ? ['.forgejo/workflows'] : []), '.gitea/workflows', '.github/workflows'];
    }

    /**
     * The workflow files of a branch. The repository contents give them on all server versions. A workflow can start by
     * hand when it has a `workflow_dispatch` trigger and the server has the dispatch API.
     */
    async workflows(target: RepoTarget, ref: string): Promise<Workflow[]> {
        const repo = await this.resolve(target);
        const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
        for (const folder of await this.workflowFolders()) {
            let entries: { name: string; path: string; type: string }[];
            try {
                entries = await this.client.request('GET', `${repo.api}/contents/${encodePath(folder)}${query}`);
            } catch (error) {
                if (error instanceof GiteaError && error.status === 404) continue;
                throw error;
            }
            const files = (Array.isArray(entries) ? entries : []).filter(entry => entry.type === 'file' && /\.ya?ml$/i.test(entry.name));
            if (files.length === 0) continue;
            const canDispatch = !this.noDispatch.has(keyOf(repo.ref));
            return Promise.all(
                files.map(async file => {
                    let trigger = { dispatchable: false, inputs: [] as Workflow['inputs'] };
                    try {
                        trigger = parseWorkflowFile(await this.client.text(`${repo.api}/raw/${encodePath(file.path)}${query}`));
                    } catch {
                        // The file cannot be read. The workflow cannot start by hand.
                    }
                    return {
                        id: this.ids.idOf(workflowKey(file.name)),
                        name: file.name,
                        path: file.path,
                        dispatchable: canDispatch && trigger.dispatchable,
                        inputs: trigger.inputs
                    };
                })
            );
        }
        return [];
    }

    /** Starts a workflow with a `workflow_dispatch` trigger on a branch. A server without the dispatch API hides the action after the first try. */
    async dispatchWorkflow(target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void> {
        const repo = await this.resolve(target);
        const file = this.ids.keyOf(workflowId)?.replace(/^workflow:/, '');
        if (!file) throw new GiteaError('The workflow is not known. Load the workflows again.', 0);
        try {
            await this.client.request('POST', `${repo.api}/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
                ref,
                ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {})
            });
        } catch (error) {
            if (!isMissingApi(error)) throw error;
            this.noDispatch.add(keyOf(repo.ref));
            throw new GiteaError('This server has no API to start a workflow by hand. Start it on the web page of the repository.', 404);
        }
    }

    async workflowRuns(target: RepoTarget, workflowId?: number): Promise<WorkflowRun[]> {
        const repo = await this.resolve(target);
        const api = await this.actionsApi(repo);
        let runs: WorkflowRun[] = [];
        if (api === 'runs') runs = (await this.recentRuns(repo)).map(run => runToWorkflowRun(run, this.ids));
        else if (api === 'tasks') runs = tasksToRuns(await this.tasks(repo), this.ids);
        return workflowId === undefined ? runs : runs.filter(run => run.workflowId === workflowId);
    }

    private async tasks(repo: ResolvedRepo): Promise<GtTask[]> {
        const data = await this.client.request<{ workflow_runs?: GtTask[] | null }>('GET', `${repo.api}/actions/tasks?limit=50`);
        return data?.workflow_runs ?? [];
    }

    /** The jobs of a run. With the older task API, the run ID is the run number, and the jobs are its tasks. */
    async runJobs(target: RepoTarget, runId: number): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        const api = await this.actionsApi(repo);
        if (api === 'runs') return (await this.jobsOf(repo, runId)).map(jobToCheck);
        if (api === 'tasks') return (await this.tasks(repo)).filter(task => task.run_number === runId).map(taskToCheck);
        return [];
    }

    async branches(target: RepoTarget): Promise<string[]> {
        const repo = await this.resolve(target);
        const data = await this.client.all<{ name: string }>(`${repo.api}/branches`, 3);
        const main = repo.info.default_branch || 'main';
        return [main, ...data.map(item => item.name).filter(name => name !== main)];
    }

    /** Uploads the images as attachments of the pull request and adds a comment with them. Returns the address of the comment. */
    async postScreenshots(target: RepoTarget, number: number, files: UploadFile[], body: (urls: string[]) => string): Promise<string | undefined> {
        const repo = await this.resolve(target);
        const urls: string[] = [];
        for (const file of files) {
            const form = new FormData();
            form.append('attachment', new Blob([new Uint8Array(file.data)], { type: 'image/png' }), file.name);
            const asset = await this.client.form<{ browser_download_url: string }>(`${repo.api}/issues/${number}/assets`, form);
            urls.push(asset.browser_download_url);
        }
        const comment = await this.client.request<GtIssueComment>('POST', `${repo.api}/issues/${number}/comments`, { body: body(urls) });
        return comment?.html_url;
    }
}
