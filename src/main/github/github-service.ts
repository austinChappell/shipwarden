import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    canManagePullRequests,
    canMergePullRequests,
    cleanActionsLog,
    latestChecks,
    parseActionsRunId,
    parseGitHubRemote,
    pullRequestSearch,
    signedImageUrls,
    withSignedImages,
    type BranchStatus,
    type BranchSummary,
    type CheckConclusion,
    type CheckRun,
    type CheckStatus,
    type FileVersions,
    type GitHubLabel,
    type GitHubOwner,
    type GitHubUser,
    type GitHubRepoInfo,
    type MergeMethod,
    type PendingComment,
    type PullRequestCandidates,
    type PullRequestChange,
    type PullRequestCommit,
    type PullRequest,
    type PullRequestFile,
    type PullRequestFilter,
    type PullRequestSummary,
    type RepoRef,
    type RequestedReviewer,
    type ReviewEvent,
    type Workflow,
    type JobProgress
} from '@shared/github';
import {
    DASHBOARD_WINDOW_DAYS,
    myPullRequestReasons,
    newComments,
    ownerQualifiers,
    type DashboardPullRequests,
    type PullRequestCommentItem
} from '@shared/dashboard';
import { GitHubClient, GitHubError } from './github-client';
import { parseWorkflowFile } from './workflow-file';
import type { WorkflowRun } from '@shared/pipelines';

interface RestWorkflowRun {
    id: number;
    name: string | null;
    display_title?: string;
    workflow_id: number;
    run_number: number;
    head_branch: string | null;
    head_sha: string;
    event: string;
    status: string | null;
    conclusion: string | null;
    actor?: { login: string } | null;
    triggering_actor?: { login: string } | null;
    created_at: string;
    updated_at: string;
    run_started_at?: string;
    html_url: string;
}

const DASHBOARD_COMMENT_FIELDS = 'id url createdAt bodyText bodyHTML author { __typename login }';

const DASHBOARD_SUMMARY_FIELDS = `
  id number title url state isDraft updatedAt createdAt reviewDecision mergeable mergeStateStatus
  repository { name owner { login } }
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/** The comments of pull requests by node ID. The Dashboard asks only for pull requests that changed. */
const DASHBOARD_COMMENTS_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest {
  id updatedAt
  comments(last: 20) { nodes { ${DASHBOARD_COMMENT_FIELDS} } }
  reviews(last: 20) { nodes { ${DASHBOARD_COMMENT_FIELDS} state } }
  reviewThreads(last: 30) { nodes { path comments(last: 10) { nodes { ${DASHBOARD_COMMENT_FIELDS} } } } }
} } }`;

/** The number of pull requests in one request for comments. A larger request can pass the time limit of GitHub. */
const DASHBOARD_COMMENTS_BATCH = 10;

function dashboardRepo(pr: DashboardPr): RepoRef {
    return { owner: pr.repository.owner.login, name: pr.repository.name };
}

function dashboardSearch(first: number): string {
    return `query($q: String!) { viewer { login } search(query: $q, type: ISSUE, first: ${first}) { nodes { ... on PullRequest { ${DASHBOARD_SUMMARY_FIELDS} } } } }`;
}

interface DashboardComment {
    id: string;
    url: string;
    createdAt: string;
    bodyText: string;
    bodyHTML: string;
    author: { __typename: string; login: string } | null;
    state?: string;
}

interface DashboardPr {
    id: string;
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    updatedAt: string;
    createdAt: string;
    reviewDecision: string | null;
    mergeable: string;
    mergeStateStatus: string;
    repository: { name: string; owner: { login: string } };
    author: { login: string } | null;
    commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface DashboardPrComments {
    id: string;
    updatedAt: string;
    comments: { nodes: DashboardComment[] };
    reviews: { nodes: DashboardComment[] };
    reviewThreads: { nodes: { path: string; comments: { nodes: DashboardComment[] } }[] };
}

/** The diff view does not load file versions that are larger than this limit. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

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

const PULL_REQUEST_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    viewerDefaultMergeMethod
    viewerPermission
    pullRequest(number: $number) {
      id number title body bodyHTML url state isDraft mergeable mergeStateStatus reviewDecision
      author { login avatarUrl }
      baseRefName headRefName baseRefOid headRefOid additions deletions changedFiles createdAt viewerDidAuthor viewerCanUpdate
      assignees(first: 20) { nodes { login avatarUrl } }
      labels(first: 50) { nodes { name color description } }
      reviewRequests(first: 30) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug name } ... on Bot { login } ... on Mannequin { login } } }
      }
      reviews(last: 30) { nodes { id author { login avatarUrl } state body bodyHTML submittedAt url } }
      comments(last: 50) { nodes { id author { login avatarUrl } body bodyHTML createdAt url } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          comments(first: 50) { nodes { id databaseId author { login avatarUrl } body bodyHTML createdAt url } }
        }
      }
      commits(last: 100) {
        totalCount
        nodes { commit { oid abbreviatedOid messageHeadline committedDate url author { name user { login } } } }
      }
      headCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts { totalCount } } } } }
    }
  }
}`;

interface GraphQlPullRequest {
    repository: {
        mergeCommitAllowed: boolean;
        squashMergeAllowed: boolean;
        rebaseMergeAllowed: boolean;
        viewerDefaultMergeMethod: 'MERGE' | 'SQUASH' | 'REBASE';
        viewerPermission: string | null;
        pullRequest: Omit<PullRequest, 'reviews' | 'issueComments' | 'threads' | 'allowedMergeMethods' | 'defaultMergeMethod' | 'commits' | 'commitCount' | 'checkCount'
            | 'assignees' | 'labels' | 'reviewRequests' | 'viewerCanManage' | 'viewerCanMerge'> & {
            bodyHTML: string;
            assignees: { nodes: GitHubUser[] };
            labels: { nodes: GitHubLabel[] };
            reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string; name?: string } | null }[] };
            commits: {
                totalCount: number;
                nodes: { commit: Omit<PullRequestCommit, 'author'> & { author: { name: string | null; user: { login: string } | null } | null } }[];
            };
            headCommit: { nodes: { commit: { statusCheckRollup: { contexts: { totalCount: number } } | null } }[] };
            reviews: { nodes: (PullRequest['reviews'][number] & { bodyHTML: string })[] };
            comments: { nodes: (PullRequest['issueComments'][number] & { bodyHTML: string })[] };
            reviewThreads: {
                nodes: (Omit<PullRequest['threads'][number], 'comments' | 'side'> & {
                    diffSide: 'LEFT' | 'RIGHT';
                    comments: { nodes: (PullRequest['threads'][number]['comments'][number] & { bodyHTML: string })[] };
                })[];
            };
        } | null;
    };
}

interface RestCheckRun {
    id: number;
    name: string;
    status: CheckStatus;
    conclusion: CheckConclusion;
    started_at: string | null;
    completed_at: string | null;
    details_url: string | null;
    html_url: string | null;
    app?: { slug?: string };
}

interface RestStatus {
    id: number;
    context: string;
    state: 'success' | 'failure' | 'error' | 'pending';
    target_url: string | null;
    created_at: string;
    updated_at: string;
}

/** The fields of a pull request in a search result of the Review view. */
interface GraphQlSummary {
    number: number;
    title: string;
    isDraft: boolean;
    state: PullRequestSummary['state'];
    updatedAt: string;
    reviewDecision: PullRequestSummary['reviewDecision'];
    additions: number;
    deletions: number;
    viewerDidAuthor: boolean;
    author: { login: string } | null;
    comments: { totalCount: number };
    commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

/** Reads and changes pull requests, reviews and GitHub Actions for the worktrees and the Review view. */
export class GitHubService {
    /** The comments of each pull request for the Dashboard, by node ID, with the `updatedAt` of the pull request at the load. */
    private readonly dashboardCommentCache = new Map<string, DashboardPrComments>();

    private readonly repos = new Map<string, RepoRef | null>();

    constructor(private readonly client: GitHubClient) {}

    /** Returns the GitHub repository of the worktree, from the "origin" remote. Returns null when it is not a GitHub repository. */
    async repoFor(root: string): Promise<RepoRef | null> {
        if (!this.repos.has(root)) {
            const url = await git(root, ['remote', 'get-url', 'origin']).catch(() => '');
            this.repos.set(root, parseGitHubRemote(url) ?? null);
        }
        return this.repos.get(root)!;
    }

    /** Returns the branch, the PR of the branch and the commit to show checks for. Returns null without a GitHub remote. */
    async branchStatus(root: string): Promise<BranchStatus | null> {
        const repo = await this.repoFor(root);
        if (!repo) {
            return null;
        }
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const localSha = await git(root, ['rev-parse', 'HEAD']);
        const pulls = branch === 'HEAD'
            ? []
            : await this.client.rest<{ number: number }[]>('GET', `/repos/${repo.owner}/${repo.name}/pulls?state=all&sort=updated&direction=desc&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`);
        const pullRequest = pulls.length > 0 ? await this.pullRequest(repo, pulls[0].number) : null;
        return { repo, branch, sha: pullRequest?.state === 'OPEN' ? pullRequest.headRefOid : localSha, pullRequest };
    }

    /**
     * Returns the open pull requests of the repository by head branch, with the combined CI state.
     * One GraphQL request covers all worktrees, so the worktree list can poll it.
     */
    async branchSummaries(root: string): Promise<Record<string, BranchSummary>> {
        const repo = await this.repoFor(root);
        if (!repo) {
            return {};
        }
        const data = await this.client.graphql<{
            repository: { pullRequests: { nodes: {
                number: number; title: string; url: string; isDraft: boolean; headRefName: string; headRefOid: string; reviewDecision: BranchSummary['reviewDecision'];
                isCrossRepository: boolean;
                commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
            }[] } };
        }>(`query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft headRefName headRefOid reviewDecision isCrossRepository
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`, { owner: repo.owner, name: repo.name });
        const summaries: Record<string, BranchSummary> = {};
        for (const pr of data.repository.pullRequests.nodes) {
            // A pull request from a fork can have the same branch name as a local branch. It is not the worktree's PR.
            if (pr.isCrossRepository || summaries[pr.headRefName]) {
                continue;
            }
            summaries[pr.headRefName] = {
                number: pr.number,
                title: pr.title,
                url: pr.url,
                headSha: pr.headRefOid,
                isDraft: pr.isDraft,
                reviewDecision: pr.reviewDecision,
                checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null
            };
        }
        return summaries;
    }

    async pullRequest(repo: RepoRef, number: number): Promise<PullRequest> {
        const data = await this.client.graphql<GraphQlPullRequest>(PULL_REQUEST_QUERY, { owner: repo.owner, name: repo.name, number });
        const pr = data.repository.pullRequest;
        if (!pr) {
            throw new Error(`Pull request #${number} does not exist in ${repo.owner}/${repo.name}.`);
        }
        const allowed: MergeMethod[] = [];
        if (data.repository.mergeCommitAllowed) allowed.push('merge');
        if (data.repository.squashMergeAllowed) allowed.push('squash');
        if (data.repository.rebaseMergeAllowed) allowed.push('rebase');
        const { commits, headCommit, bodyHTML, comments: issueComments, assignees, labels, reviewRequests, ...rest } = pr;
        // Images of private repositories need the signed URLs from the HTML that GitHub rendered.
        const images = signedImageUrls([
            bodyHTML,
            ...pr.reviews.nodes.map(review => review.bodyHTML),
            ...issueComments.nodes.map(comment => comment.bodyHTML),
            ...pr.reviewThreads.nodes.flatMap(thread => thread.comments.nodes.map(comment => comment.bodyHTML))
        ]);
        const sign = <T extends { body: string; bodyHTML: string }>({ bodyHTML: _html, ...item }: T): Omit<T, 'bodyHTML'> =>
            ({ ...item, body: withSignedImages(item.body, images) });
        return {
            ...rest,
            body: withSignedImages(pr.body, images),
            commits: commits.nodes.map(({ commit: { author, ...commit } }) => ({ ...commit, author: author?.user?.login ?? author?.name ?? null })),
            commitCount: commits.totalCount,
            checkCount: headCommit.nodes[0]?.commit.statusCheckRollup?.contexts.totalCount ?? 0,
            reviews: pr.reviews.nodes.map(sign),
            issueComments: issueComments.nodes.map(sign),
            threads: pr.reviewThreads.nodes.map(({ diffSide, comments, ...thread }) => ({ ...thread, side: diffSide, comments: comments.nodes.map(sign) })),
            allowedMergeMethods: allowed,
            defaultMergeMethod: data.repository.viewerDefaultMergeMethod.toLowerCase() as MergeMethod,
            assignees: assignees.nodes,
            labels: labels.nodes,
            reviewRequests: reviewRequests.nodes.flatMap(({ requestedReviewer: reviewer }): RequestedReviewer[] => {
                if (reviewer?.__typename === 'Team' && reviewer.slug) return [{ kind: 'team', login: reviewer.slug, name: reviewer.name }];
                if (reviewer?.login) return [{ kind: 'user', login: reviewer.login }];
                return [];
            }),
            viewerCanManage: canManagePullRequests(data.repository.viewerPermission),
            viewerCanMerge: canMergePullRequests(data.repository.viewerPermission)
        };
    }

    /** Returns the users that the user can assign or ask for a review, and the labels of the repository. */
    async pullRequestCandidates(repo: RepoRef): Promise<PullRequestCandidates> {
        const query = `query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            assignableUsers(first: 100) { nodes { login avatarUrl } }
            labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name color description } }
          }
        }`;
        const data = await this.client.graphql<{ repository: { assignableUsers: { nodes: GitHubUser[] }; labels: { nodes: GitHubLabel[] } } }>(
            query, { owner: repo.owner, name: repo.name });
        return { users: data.repository.assignableUsers.nodes, labels: data.repository.labels.nodes };
    }

    /** Makes one change to a pull request: the details, an assignee, a reviewer or a label. */
    async changePullRequest(repo: RepoRef, number: number, change: PullRequestChange): Promise<void> {
        const base = `/repos/${repo.owner}/${repo.name}`;
        switch (change.kind) {
            case 'details':
                await this.client.rest('PATCH', `${base}/pulls/${number}`, { title: change.title, body: change.body, state: change.state });
                return;
            case 'draft': {
                // Only GraphQL can change the draft state.
                const mutation = change.draft
                    ? 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } } }'
                    : 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }';
                await this.client.graphql(mutation, { id: change.pullRequestId });
                return;
            }
            case 'assignee':
                await this.client.rest(change.add ? 'POST' : 'DELETE', `${base}/issues/${number}/assignees`, { assignees: [change.login] });
                return;
            case 'reviewer': {
                const field = change.reviewer.kind === 'team' ? 'team_reviewers' : 'reviewers';
                await this.client.rest(change.add ? 'POST' : 'DELETE', `${base}/pulls/${number}/requested_reviewers`, { [field]: [change.reviewer.login] });
                return;
            }
            case 'label':
                if (change.add) {
                    await this.client.rest('POST', `${base}/issues/${number}/labels`, { labels: [change.name] });
                } else {
                    await this.client.rest('DELETE', `${base}/issues/${number}/labels/${encodeURIComponent(change.name)}`);
                }
                return;
        }
    }

    async pullRequestFiles(repo: RepoRef, number: number): Promise<PullRequestFile[]> {
        const [files, viewed] = await Promise.all([
            this.client.paginate<{ filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }>(
                `/repos/${repo.owner}/${repo.name}/pulls/${number}/files`
            ),
            this.viewedFiles(repo, number).catch(() => new Set<string>())
        ]);
        return files.map(file => ({
            path: file.filename,
            previousPath: file.previous_filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            viewed: viewed.has(file.filename),
            ...(file.patch ? { patch: file.patch } : {})
        }));
    }

    /** Returns the files that the user marked as viewed. Only GraphQL has this state. */
    private async viewedFiles(repo: RepoRef, number: number): Promise<Set<string>> {
        const viewed = new Set<string>();
        let after: string | null = null;
        // A pull request can have 3000 files. GraphQL returns 100 on each page.
        for (let page = 0; page < 30; page++) {
            const data: { repository: { pullRequest: { files: { nodes: { path: string; viewerViewedState: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } } =
                await this.client.graphql(`query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } }
    }
  }
}`, { owner: repo.owner, name: repo.name, number, after });
            const files = data.repository.pullRequest.files;
            files.nodes.filter(file => file.viewerViewedState === 'VIEWED').forEach(file => viewed.add(file.path));
            if (!files.pageInfo.hasNextPage) break;
            after = files.pageInfo.endCursor;
        }
        return viewed;
    }

    /** Marks a file of a pull request as viewed or not viewed, as the "Viewed" box on GitHub does. `pullRequestId` is the node ID. */
    async setFileViewed(pullRequestId: string, path: string, viewed: boolean): Promise<void> {
        const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
        await this.client.graphql(`mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, { id: pullRequestId, path });
    }

    /** Returns the user and the organizations of the token, for the organization choice of the Review view. */
    /** Returns the review requests and the user's open pull requests that need an action, for the Dashboard. */
    async dashboardPullRequests(owners: string[] | 'all' | undefined): Promise<DashboardPullRequests> {
        const scope = `${ownerQualifiers(owners)} archived:false is:pr`.trim();
        const [review, mine] = await Promise.all([
            this.dashboardSearch(`${scope} is:open draft:false review-requested:@me sort:updated-desc`, 100),
            this.dashboardSearch(`${scope} is:open author:@me sort:updated-desc`, 100)
        ]);
        return {
            reviewRequests: review.prs.map(pr => ({
                repo: dashboardRepo(pr),
                number: pr.number,
                title: pr.title,
                url: pr.url,
                author: pr.author?.login ?? null,
                updatedAt: pr.updatedAt,
                createdAt: pr.createdAt
            })),
            myPullRequests: mine.prs
                .map(pr => ({
                    repo: dashboardRepo(pr),
                    number: pr.number,
                    title: pr.title,
                    url: pr.url,
                    updatedAt: pr.updatedAt,
                    reasons: myPullRequestReasons({ ...pr, checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null })
                }))
                .filter(pr => pr.reasons.length > 0)
        };
    }

    /**
     * Returns the new comments for the Dashboard, on pull requests of the user or where the user commented or reviewed.
     * GitHub search is slow for these searches, so they come after the pull requests.
     */
    async dashboardComments(owners: string[] | 'all' | undefined): Promise<PullRequestCommentItem[]> {
        const since = new Date(Date.now() - DASHBOARD_WINDOW_DAYS * 24 * 3600 * 1000);
        const recent = `${ownerQualifiers(owners)} archived:false is:pr updated:>=${since.toISOString().slice(0, 10)} sort:updated-desc`.trim();
        const results = await Promise.all([
            this.dashboardSearch(`${recent} author:@me`, 30),
            this.dashboardSearch(`${recent} commenter:@me`, 30),
            this.dashboardSearch(`${recent} reviewed-by:@me`, 30)
        ]);
        const viewer = results[0].viewer;
        const involved = new Map<string, DashboardPr>();
        for (const pr of results.flatMap(result => result.prs)) {
            involved.set(pr.id, pr);
        }
        await this.loadDashboardComments([...involved.values()]);

        const comments = new Map<string, PullRequestCommentItem>();
        for (const pr of involved.values()) {
            const loaded = this.dashboardCommentCache.get(pr.id);
            if (!loaded) continue;
            const all = [
                ...loaded.comments.nodes.map(comment => ({ comment, path: undefined as string | undefined })),
                // A review with no text and no decision is only the container of its line comments.
                ...loaded.reviews.nodes
                    .filter(item => item.bodyText.trim() || item.state === 'APPROVED' || item.state === 'CHANGES_REQUESTED')
                    .map(comment => ({ comment, path: undefined as string | undefined })),
                ...loaded.reviewThreads.nodes.flatMap(thread => thread.comments.nodes.map(comment => ({ comment, path: thread.path })))
            ].map(({ comment, path }) => ({
                id: comment.id,
                author: comment.author?.login ?? null,
                isBot: comment.author?.__typename === 'Bot' || !!comment.author?.login.endsWith('[bot]'),
                createdAt: comment.createdAt,
                comment,
                path
            }));
            for (const { comment, path } of newComments(all, viewer, since)) {
                comments.set(comment.id, {
                    id: comment.id,
                    repo: dashboardRepo(pr),
                    number: pr.number,
                    prTitle: pr.title,
                    prUrl: pr.url,
                    author: comment.author!.login,
                    text: comment.bodyText,
                    html: comment.bodyHTML,
                    createdAt: comment.createdAt,
                    url: comment.url,
                    path,
                    reviewState: comment.state
                });
            }
        }
        return [...comments.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    private async dashboardSearch(q: string, first: number): Promise<{ viewer: string; prs: DashboardPr[] }> {
        const data = await this.client.graphql<{ viewer: { login: string }; search: { nodes: (DashboardPr | Record<string, never>)[] } }>(dashboardSearch(first), { q });
        return { viewer: data.viewer.login, prs: data.search.nodes.filter((node): node is DashboardPr => 'number' in node) };
    }

    /**
     * Loads the comments of the pull requests that changed since the last load, 10 pull requests in each request.
     * A failed request fails the load. The pull requests of the batches that loaded keep their comments.
     * The comments of a pull request without a change come from memory, so a refresh is cheap.
     */
    private async loadDashboardComments(prs: DashboardPr[]): Promise<void> {
        const changed = prs.filter(pr => this.dashboardCommentCache.get(pr.id)?.updatedAt !== pr.updatedAt).map(pr => pr.id);
        const batches: string[][] = [];
        for (let index = 0; index < changed.length; index += DASHBOARD_COMMENTS_BATCH) {
            batches.push(changed.slice(index, index + DASHBOARD_COMMENTS_BATCH));
        }
        // Two requests at the same time. More can trigger the secondary rate limit of GitHub.
        let next = 0;
        await Promise.all([0, 1].map(async () => {
            while (next < batches.length) {
                const ids = batches[next++];
                const data = await this.client.graphql<{ nodes: (DashboardPrComments | null)[] }>(DASHBOARD_COMMENTS_QUERY, { ids });
                for (const node of data.nodes) {
                    if (node && 'comments' in node) {
                        this.dashboardCommentCache.set(node.id, node);
                    }
                }
            }
        }));
        // Forget pull requests that are not in the Dashboard searches any more.
        const current = new Set(prs.map(pr => pr.id));
        for (const id of this.dashboardCommentCache.keys()) {
            if (!current.has(id)) this.dashboardCommentCache.delete(id);
        }
    }

    async owners(): Promise<GitHubOwner[]> {
        const [user, orgs] = await Promise.all([
            this.client.rest<{ login: string }>('GET', '/user'),
            this.client.paginate<{ login: string }>('/user/orgs', undefined, 300)
        ]);
        return [{ login: user.login, kind: 'user' }, ...orgs.map(org => ({ login: org.login, kind: 'organization' as const }))];
    }

    /**
     * Returns the repositories that the user can access, of the given owners (all owners when undefined),
     * the repository with the newest push first.
     */
    async repositories(owners?: string[]): Promise<GitHubRepoInfo[]> {
        const wanted = owners ? new Set(owners.map(owner => owner.toLowerCase())) : undefined;
        const repos = await this.client.paginate<{ name: string; owner: { login: string }; pushed_at?: string; archived: boolean }>(
            '/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member', undefined, 1000
        );
        return repos
            .filter(repo => !repo.archived && (!wanted || wanted.has(repo.owner.login.toLowerCase())))
            .map(repo => ({ owner: repo.owner.login, name: repo.name, pushedAt: repo.pushed_at }));
    }

    /**
     * Returns the pull requests of a repository for a filter of the Review view, the newest update first.
     * The closed list is shorter and has no CI state, because GitHub is slow to get the CI state of old pull requests.
     */
    async pullRequests(repo: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]> {
        const closed = filter === 'closed';
        const data = await this.client.graphql<{ search: { nodes: (GraphQlSummary | Record<string, never>)[] } }>(`query($q: String!, $first: Int!, $checks: Boolean!) {
  search(query: $q, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        number title isDraft state updatedAt reviewDecision additions deletions viewerDidAuthor
        author { login }
        comments { totalCount }
        commits(last: 1) @include(if: $checks) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`, { q: `${pullRequestSearch(repo, filter, query)} sort:updated-desc`, first: closed ? 30 : 50, checks: !closed });
        return data.search.nodes
            .filter((node): node is GraphQlSummary => 'number' in node)
            .map(node => ({
                number: node.number,
                title: node.title,
                author: node.author?.login ?? null,
                isDraft: node.isDraft,
                state: node.state,
                updatedAt: node.updatedAt,
                reviewDecision: node.reviewDecision,
                checks: node.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
                comments: node.comments.totalCount,
                additions: node.additions,
                deletions: node.deletions,
                viewerDidAuthor: node.viewerDidAuthor
            }));
    }

    /** Returns the base and head versions of a file in a pull request. A missing version is an empty string. */
    async fileVersions(repo: RepoRef, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
        const read = async (filePath: string, sha: string): Promise<string | undefined> => {
            try {
                const text = await this.client.text(`/repos/${repo.owner}/${repo.name}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`);
                if (text.length > MAX_FILE_BYTES || text.slice(0, 8000).includes('\0')) {
                    return undefined;
                }
                return text;
            } catch (error) {
                if (error instanceof GitHubError && error.status === 404) {
                    return '';
                }
                throw error;
            }
        };
        const [base, head] = await Promise.all([
            file.status === 'added' ? Promise.resolve('') : read(file.previousPath ?? file.path, baseSha),
            file.status === 'removed' ? Promise.resolve('') : read(file.path, headSha)
        ]);
        if (base === undefined || head === undefined) {
            return { base: '', head: '', unavailable: true };
        }
        return { base, head };
    }

    async submitReview(repo: RepoRef, number: number, headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void> {
        await this.client.rest('POST', `/repos/${repo.owner}/${repo.name}/pulls/${number}/reviews`, {
            commit_id: headSha,
            event,
            body: body || undefined,
            comments: comments.map(comment => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body }))
        });
    }

    async replyToComment(repo: RepoRef, number: number, commentId: number, body: string): Promise<void> {
        await this.client.rest('POST', `/repos/${repo.owner}/${repo.name}/pulls/${number}/comments/${commentId}/replies`, { body });
    }

    async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
        const mutation = resolved
            ? 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }'
            : 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }';
        await this.client.graphql(mutation, { id: threadId });
    }

    async merge(repo: RepoRef, number: number, headSha: string, method: MergeMethod): Promise<void> {
        await this.client.rest('PUT', `/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, { merge_method: method, sha: headSha });
    }

    /** Returns the check runs and the commit statuses of a commit. */
    async checks(repo: RepoRef, sha: string): Promise<CheckRun[]> {
        const base = `/repos/${repo.owner}/${repo.name}/commits/${sha}`;
        const [runs, statuses] = await Promise.all([
            this.client.paginate<RestCheckRun>(`${base}/check-runs`, page => (page as { check_runs: RestCheckRun[] }).check_runs, 500),
            this.client.rest<{ statuses: RestStatus[] }>('GET', `${base}/status`)
        ]);
        const checks: CheckRun[] = runs.map(run => {
            const isActions = run.app?.slug === 'github-actions';
            return {
                id: run.id,
                name: run.name,
                status: run.status,
                conclusion: run.conclusion,
                startedAt: run.started_at,
                completedAt: run.completed_at,
                url: run.html_url ?? run.details_url,
                isActions,
                runId: isActions ? parseActionsRunId(run.details_url) : undefined
            };
        });
        for (const status of statuses.statuses) {
            checks.push({
                id: status.id,
                name: status.context,
                status: status.state === 'pending' ? 'pending' : 'completed',
                conclusion: status.state === 'pending' ? null : status.state,
                startedAt: status.created_at,
                completedAt: status.state === 'pending' ? null : status.updated_at,
                url: status.target_url,
                isActions: false,
                isStatus: true
            });
        }
        return latestChecks(checks).sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The status of a job and its steps. It works while the job runs, also when the log is not ready. */
    async jobProgress(repo: RepoRef, jobId: number): Promise<JobProgress> {
        interface RawStep { number: number; name: string; status: CheckStatus; conclusion: CheckConclusion; started_at: string | null; completed_at: string | null }
        const job = await this.client.rest<{ status: CheckStatus; conclusion: CheckConclusion; started_at: string | null; completed_at: string | null; steps?: RawStep[] }>(
            'GET', `/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}`
        );
        return {
            status: job.status,
            conclusion: job.conclusion,
            startedAt: job.started_at,
            completedAt: job.completed_at,
            steps: (job.steps ?? []).map(step => ({
                number: step.number,
                name: step.name,
                status: step.status,
                conclusion: step.conclusion,
                startedAt: step.started_at,
                completedAt: step.completed_at
            }))
        };
    }

    async jobLog(repo: RepoRef, jobId: number): Promise<string> {
        return cleanActionsLog(await this.client.text(`/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/logs`, 'application/vnd.github+json'));
    }

    /** Saves the log of a job to a file, so that an agent can read the full log. Returns the file path. */
    async saveJobLog(repo: RepoRef, jobId: number): Promise<string> {
        const folder = path.join(os.homedir(), '.shipwarden', 'ci-logs');
        await fs.mkdir(folder, { recursive: true });
        const file = path.join(folder, `${repo.owner}-${repo.name}-job-${jobId}.log`);
        await fs.writeFile(file, await this.jobLog(repo, jobId));
        return file;
    }

    async rerunJob(repo: RepoRef, jobId: number): Promise<void> {
        await this.client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/rerun`);
    }

    async rerunFailedJobs(repo: RepoRef, runId: number): Promise<void> {
        await this.client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/rerun-failed-jobs`);
    }

    /** Lists the active workflows. A workflow is dispatchable when its file has a workflow_dispatch trigger. */
    async workflows(repo: RepoRef, ref: string): Promise<Workflow[]> {
        const list = await this.client.paginate<{ id: number; name: string; path: string; state: string }>(
            `/repos/${repo.owner}/${repo.name}/actions/workflows`,
            page => (page as { workflows: { id: number; name: string; path: string; state: string }[] }).workflows
        );
        const active = list.filter(workflow => workflow.state === 'active' && workflow.path.startsWith('.github/workflows/'));
        return Promise.all(active.map(async workflow => {
            let trigger = { dispatchable: false, inputs: [] as Workflow['inputs'] };
            try {
                trigger = parseWorkflowFile(await this.client.text(`/repos/${repo.owner}/${repo.name}/contents/${workflow.path}?ref=${encodeURIComponent(ref)}`));
            } catch {
                // The workflow file is not on this branch.
            }
            return { id: workflow.id, name: workflow.name, path: workflow.path, ...trigger };
        }));
    }

    /** Starts a workflow with a `workflow_dispatch` trigger on a branch or tag, with the values of its inputs. */
    async dispatchWorkflow(repo: RepoRef, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void> {
        await this.client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/workflows/${workflowId}/dispatches`, {
            ref,
            ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {})
        });
    }

    /** Returns the newest workflow runs of a repository, of one workflow when `workflowId` is set. */
    async workflowRuns(repo: RepoRef, workflowId?: number): Promise<WorkflowRun[]> {
        const base = workflowId
            ? `/repos/${repo.owner}/${repo.name}/actions/workflows/${workflowId}/runs`
            : `/repos/${repo.owner}/${repo.name}/actions/runs`;
        const data = await this.client.rest<{ workflow_runs: RestWorkflowRun[] }>('GET', `${base}?per_page=40`);
        return data.workflow_runs.map(run => ({
            id: run.id,
            title: run.display_title ?? run.name ?? `Run ${run.run_number}`,
            workflowId: run.workflow_id,
            workflowName: run.name ?? '',
            runNumber: run.run_number,
            branch: run.head_branch,
            event: run.event,
            status: run.status ?? 'queued',
            conclusion: run.conclusion,
            actor: run.triggering_actor?.login ?? run.actor?.login ?? null,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            startedAt: run.run_started_at ?? null,
            url: run.html_url,
            headSha: run.head_sha
        }));
    }

    /** Returns the jobs of the latest attempt of a run, as check runs, so the log view can show their logs. */
    async runJobs(repo: RepoRef, runId: number): Promise<CheckRun[]> {
        const jobs = await this.client.paginate<{ id: number; name: string; status: CheckStatus; conclusion: CheckConclusion; started_at: string | null; completed_at: string | null; html_url: string | null; run_id: number }>(
            `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/jobs?filter=latest`,
            page => (page as { jobs: never[] }).jobs
        );
        return jobs.map(job => ({
            id: job.id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            startedAt: job.started_at,
            completedAt: job.completed_at,
            url: job.html_url,
            runId: job.run_id,
            isActions: true
        }));
    }

    async cancelRun(repo: RepoRef, runId: number): Promise<void> {
        await this.client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/cancel`);
    }

    /** Runs all jobs of a finished run again. */
    async rerunRun(repo: RepoRef, runId: number): Promise<void> {
        await this.client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/rerun`);
    }

    /** Returns the branches of a repository (at most 300), the default branch first. */
    async branches(repo: RepoRef): Promise<string[]> {
        const [info, list] = await Promise.all([
            this.client.rest<{ default_branch: string }>('GET', `/repos/${repo.owner}/${repo.name}`),
            this.client.paginate<{ name: string }>(`/repos/${repo.owner}/${repo.name}/branches`, undefined, 300)
        ]);
        const names = list.map(branch => branch.name).filter(name => name !== info.default_branch);
        return [info.default_branch, ...names];
    }
}
