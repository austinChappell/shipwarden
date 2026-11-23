import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DashboardPullRequests, MyPullRequestItem, ReviewRequestItem } from '@shared/dashboard';
import type {
    BranchStatus,
    BranchSummary,
    CheckRun,
    CommitFiles,
    FileVersions,
    GitHubLabel,
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
import {
    cleanGitLabTrace,
    decodeGitLabId,
    diffLinePosition,
    draftTitle,
    gitlabCreateMergeRequestUrl,
    gitlabProjectId,
    gitlabRepoOf,
    gitlabRepoRef,
    inGroups,
    parseGitLabRemote,
    type GitLabRepoRef
} from '@shared/gitlab';
import type { WorkflowRun } from '@shared/pipelines';
import { matchesSearch, type RepoPullRequests } from '@shared/review-queue';
import type { SourceHost } from '../source-host';
import { commentOnGitLab, uploadToGitLab, type UploadFile } from '../screenshots/screenshot-upload';
import { type GitLabClient, GitLabError } from './gitlab-client';
import {
    branchSummaries,
    GITLAB_PIPELINE_WORKFLOW_ID,
    jobProgressOf,
    jobToCheck,
    labelOf,
    latestJobs,
    mapDiffs,
    mapMergeRequest,
    mergedBranches,
    mergeRequestSummaryOf,
    myMergeRequestItemOf,
    openMergeRequestOf,
    pipelinesBySha,
    pipelineToRun,
    repoOfMergeRequest,
    reviewRequestItemOf,
    userOf,
    viewerIsReviewer,
    type GlApprovals,
    type GlCommit,
    type GlDiff,
    type GlDiscussion,
    type GlJob,
    type GlLabel,
    type GlMergeRequest,
    type GlPipeline,
    type GlProject,
    type GlUser
} from './gitlab-mapping';

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

/** A project with its API path and its settings from GitLab. */
interface ResolvedRepo {
    ref: GitLabRepoRef;
    /** The API path of the project, for example "/projects/acme%2Fweb". */
    api: string;
    project: GlProject;
}

/** The path of a project for the cache keys, in lowercase. */
function keyOf(ref: GitLabRepoRef): string {
    return `${ref.namespace}/${ref.project}`.toLowerCase();
}

/**
 * Reads and changes merge requests and pipelines of one GitLab server (gitlab.com or a self-hosted server).
 * A target is a worktree path with a remote on the server, or a GitLab reference from the Review view or the
 * Pipelines view (see `gitlabRepoOf`).
 */
export class GitLabService implements SourceHost {
    readonly kind = 'gitlab' as const;

    private readonly remotes = new Map<string, GitLabRepoRef | null>();
    private readonly projects = new Map<string, Promise<GlProject>>();
    private viewerPromise: Promise<GlUser> | undefined;
    /** The user IDs of usernames, for the assignee and reviewer changes. */
    private readonly userIds = new Map<string, number>();
    /** The labels of each project, for the label colors. */
    private readonly labels = new Map<string, Promise<GlLabel[]>>();
    /** The discussion of each first note, by project and merge request. A reply needs the discussion. */
    private readonly discussions = new Map<string, string>();
    /**
     * The files that the user marked as viewed, by merge request. GitLab has no public API for this state,
     * so it stays in memory until the app quits.
     */
    private readonly viewed = new Map<string, Set<string>>();

    constructor(
        private readonly client: GitLabClient,
        private readonly readRemote: (root: string) => Promise<string> = root => git(root, ['remote', 'get-url', 'origin'])
    ) {}

    /** Returns the GitLab project of a worktree from its "origin" remote. Returns null for a remote on another server. */
    async repoFor(root: string): Promise<GitLabRepoRef | null> {
        if (!this.remotes.has(root)) {
            const url = await this.readRemote(root).catch(() => '');
            const ref = parseGitLabRemote(url, [this.client.baseUrl()]);
            this.remotes.set(root, ref && ref.host === this.client.host() ? ref : null);
        }
        return this.remotes.get(root)!;
    }

    /** True when the target is a worktree with a remote on this server, or a GitLab reference of this server. */
    async owns(target: RepoTarget): Promise<boolean> {
        if (typeof target !== 'string') return gitlabRepoOf(target)?.host === this.client.host();
        return (await this.repoFor(target)) !== null;
    }

    private async refOf(target: RepoTarget): Promise<GitLabRepoRef> {
        if (typeof target === 'string') {
            const ref = await this.repoFor(target);
            if (!ref) throw new GitLabError(`The "origin" remote of this worktree is not a project on ${this.client.host()}.`, 0);
            return ref;
        }
        const ref = gitlabRepoOf(target);
        if (!ref || ref.host !== this.client.host()) {
            throw new GitLabError(`"${target.owner}/${target.name}" is not a project on ${this.client.host()}.`, 0);
        }
        return ref;
    }

    private async resolve(target: RepoTarget): Promise<ResolvedRepo> {
        const ref = await this.refOf(target);
        const api = `/projects/${gitlabProjectId(ref)}`;
        const key = keyOf(ref);
        let project = this.projects.get(key);
        if (!project) {
            project = this.client.request<GlProject>('GET', api);
            this.projects.set(key, project);
            project.catch(() => this.projects.delete(key));
        }
        return { ref, api, project: await project };
    }

    /** Returns the user of the token. */
    private viewer(): Promise<GlUser> {
        if (!this.viewerPromise) {
            const viewer = this.client.request<GlUser>('GET', '/user');
            this.viewerPromise = viewer;
            viewer.catch(() => {
                if (this.viewerPromise === viewer) this.viewerPromise = undefined;
            });
        }
        return this.viewerPromise;
    }

    private mrApi(repo: ResolvedRepo, iid: number): string {
        return `${repo.api}/merge_requests/${iid}`;
    }

    private mrKey(ref: GitLabRepoRef, iid: number): string {
        return `${keyOf(ref)}!${iid}`;
    }

    /** The newest pipelines of the project, for the CI state of the lists. */
    private recentPipelines(repo: ResolvedRepo): Promise<Map<string, GlPipeline>> {
        return this.client.request<GlPipeline[]>('GET', `${repo.api}/pipelines?per_page=100`).then(pipelinesBySha, () => new Map<string, GlPipeline>());
    }

    /**
     * Returns the projects of the user (membership) on the server, for the Review view and the Pipelines view.
     * A scope keeps only the projects of its groups, also of their subgroups. The newest activity comes first.
     */
    async repositories(scope: string[] | undefined): Promise<GitHubRepoInfo[]> {
        const projects = await this.client.all<GlProject>('/projects?membership=true&simple=true&archived=false&order_by=last_activity_at&sort=desc', 3);
        const host = this.client.host();
        return projects.flatMap((project): GitHubRepoInfo[] => {
            if (project.archived || !inGroups(project.path_with_namespace, scope)) return [];
            const slash = project.path_with_namespace.lastIndexOf('/');
            if (slash <= 0) return [];
            const ref = gitlabRepoRef({ host, namespace: project.path_with_namespace.slice(0, slash), project: project.path_with_namespace.slice(slash + 1) });
            return [{ ...ref, ...(project.last_activity_at ? { pushedAt: project.last_activity_at } : {}) }];
        });
    }

    /** Returns the open merge requests of a project, for the review queue of the Review view. */
    async repoPullRequests(target: RepoRef): Promise<RepoPullRequests> {
        const repo = await this.resolve(target);
        const [mrs, pipelines, viewer] = await Promise.all([
            this.client.request<GlMergeRequest[]>('GET', `${repo.api}/merge_requests?state=opened&per_page=100`),
            this.recentPipelines(repo),
            this.viewer().catch(() => undefined)
        ]);
        const pullRequests = mrs.map(mr => openMergeRequestOf(repo.ref, mr, pipelines, viewer?.id));
        return { viewer: viewer?.username ?? '', openCount: pullRequests.length, pullRequests };
    }

    /**
     * Returns the merge requests of a project for a filter of the Review view, the newest first.
     * The search looks at the title, the author, the branch and the number.
     */
    async pullRequests(target: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]> {
        const repo = await this.resolve(target);
        const needsViewer = filter === 'review' || filter === 'mine' || filter === 'assigned';
        const viewer = needsViewer ? await this.viewer() : await this.viewer().catch(() => undefined);
        const state = filter === 'closed' ? 'closed' : filter === 'merged' ? 'merged' : 'opened';
        const person =
            filter === 'review'
                ? `&reviewer_id=${viewer?.id}`
                : filter === 'mine'
                  ? `&author_id=${viewer?.id}`
                  : filter === 'assigned'
                    ? `&assignee_id=${viewer?.id}`
                    : '';
        const [mrs, pipelines] = await Promise.all([
            this.client.request<GlMergeRequest[]>('GET', `${repo.api}/merge_requests?state=${state}${person}&order_by=updated_at&per_page=100`),
            state === 'opened' ? this.recentPipelines(repo) : Promise.resolve(new Map<string, GlPipeline>())
        ]);
        const text = query?.trim();
        return mrs
            .filter(mr => filter !== 'review' || viewerIsReviewer(mr, viewer?.id))
            .filter(mr => !text || matchesSearch({ number: mr.iid, title: mr.title, author: mr.author.username, headRefName: mr.source_branch }, text))
            .map(mr => mergeRequestSummaryOf(mr, pipelines, viewer?.id))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    /**
     * Returns the merge requests for the Dashboard: the open merge requests that have the viewer as a reviewer, and the
     * open merge requests of the viewer that need an action. Two requests for the whole server.
     */
    async dashboardPullRequests(scope: string[] | undefined): Promise<DashboardPullRequests> {
        const viewer = await this.viewer();
        const host = this.client.host();
        const [reviewing, mine] = await Promise.all([
            this.client.request<GlMergeRequest[]>('GET', `/merge_requests?state=opened&scope=all&reviewer_id=${viewer.id}&per_page=100`),
            this.client.request<GlMergeRequest[]>('GET', `/merge_requests?state=opened&scope=created_by_me&per_page=100`)
        ]);
        const reviewRequests: ReviewRequestItem[] = [];
        const myPullRequests: MyPullRequestItem[] = [];
        for (const mr of reviewing) {
            const repo = repoOfMergeRequest(host, mr);
            if (repo && inGroups(`${repo.namespace}/${repo.project}`, scope) && viewerIsReviewer(mr, viewer.id))
                reviewRequests.push(reviewRequestItemOf(repo, mr));
        }
        for (const mr of mine) {
            const repo = repoOfMergeRequest(host, mr);
            const item = repo && inGroups(`${repo.namespace}/${repo.project}`, scope) ? myMergeRequestItemOf(repo, mr) : undefined;
            if (item) myPullRequests.push(item);
        }
        return { reviewRequests, myPullRequests };
    }

    async branchStatus(root: string): Promise<BranchStatus | null> {
        const ref = await this.repoFor(root);
        if (!ref) return null;
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const localSha = await git(root, ['rev-parse', 'HEAD']);
        let pullRequest: PullRequest | null = null;
        if (branch !== 'HEAD') {
            const list = await this.client.request<GlMergeRequest[]>(
                'GET',
                `${repo.api}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&order_by=created_at&sort=desc&per_page=20`
            );
            const pick = list.find(mr => mr.state === 'opened') ?? list[0];
            if (pick) pullRequest = await this.pullRequest(root, pick.iid);
        }
        return {
            repo: gitlabRepoRef(ref),
            branch,
            sha: pullRequest?.state === 'OPEN' && pullRequest.headRefOid ? pullRequest.headRefOid : localSha,
            pullRequest,
            host: 'gitlab',
            createUrl: gitlabCreateMergeRequestUrl(ref, branch)
        };
    }

    async mergedBranches(root: string): Promise<Record<string, MergedPullRequest>> {
        if (!(await this.repoFor(root))) return {};
        const repo = await this.resolve(root);
        const mrs = await this.client.request<GlMergeRequest[]>('GET', `${repo.api}/merge_requests?state=merged&order_by=updated_at&per_page=100`);
        return mergedBranches(mrs);
    }

    async branchSummaries(root: string): Promise<Record<string, BranchSummary>> {
        if (!(await this.repoFor(root))) return {};
        const repo = await this.resolve(root);
        const [mrs, pipelines, viewer] = await Promise.all([
            this.client.request<GlMergeRequest[]>('GET', `${repo.api}/merge_requests?state=opened&per_page=100`),
            this.recentPipelines(repo),
            this.viewer().catch(() => undefined)
        ]);
        return branchSummaries(mrs, pipelines, viewer?.id);
    }

    async createPullRequest(root: string, request: NewPullRequest): Promise<number> {
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branch === 'HEAD') throw new GitLabError('The worktree has no branch (detached HEAD).', 0);
        const created = await this.client.request<GlMergeRequest>('POST', `${repo.api}/merge_requests`, {
            source_branch: branch,
            target_branch: request.base || repo.project.default_branch || 'main',
            title: request.draft ? draftTitle(request.title, true) : request.title,
            description: request.body
        });
        return created.iid;
    }

    /** The labels of the project. A failure gives no labels, so the labels are gray. */
    private projectLabels(repo: ResolvedRepo): Promise<GlLabel[]> {
        const key = keyOf(repo.ref);
        let labels = this.labels.get(key);
        if (!labels) {
            labels = this.client.all<GlLabel>(`${repo.api}/labels`, 2).catch(() => {
                this.labels.delete(key);
                return [];
            });
            this.labels.set(key, labels);
        }
        return labels;
    }

    async pullRequest(target: RepoTarget, number: number): Promise<PullRequest> {
        const repo = await this.resolve(target);
        const base = this.mrApi(repo, number);
        const [mr, approvals, discussions, commits, viewer, labels] = await Promise.all([
            this.client.request<GlMergeRequest>('GET', base),
            this.client.request<GlApprovals>('GET', `${base}/approvals`).catch(() => undefined),
            this.client.all<GlDiscussion>(`${base}/discussions`, 5),
            this.client.all<GlCommit>(`${base}/commits`, 1),
            this.viewer().catch(() => undefined),
            this.projectLabels(repo)
        ]);
        this.rememberDiscussions(repo.ref, number, discussions);
        const colors = new Map(labels.map(label => [label.name, label]));
        const withColors = { ...mr, labels: (mr.labels ?? []).map(label => (typeof label === 'string' ? (colors.get(label) ?? label) : label)) };
        return mapMergeRequest({
            repo: repo.ref,
            mr: withColors,
            project: repo.project,
            approvals,
            discussions,
            commits,
            checkCount: mr.head_pipeline ? 1 : 0,
            viewerId: viewer?.id
        });
    }

    /** Keeps the discussion of each note, so a reply to a note finds its discussion without a request. */
    private rememberDiscussions(ref: GitLabRepoRef, iid: number, discussions: readonly GlDiscussion[]): void {
        const key = this.mrKey(ref, iid);
        for (const discussion of discussions) {
            for (const note of discussion.notes) this.discussions.set(`${key}#${note.id}`, discussion.id);
        }
    }

    /** Returns the diffs of a merge request. A server older than GitLab 15.7 has no "diffs" API and gives the changes. */
    private async diffs(repo: ResolvedRepo, iid: number): Promise<GlDiff[]> {
        try {
            return await this.client.all<GlDiff>(`${this.mrApi(repo, iid)}/diffs`, 30);
        } catch (error) {
            if (!(error instanceof GitLabError) || error.status !== 404) throw error;
            const data = await this.client.request<{ changes?: GlDiff[] }>('GET', `${this.mrApi(repo, iid)}/changes`);
            return data.changes ?? [];
        }
    }

    async pullRequestFiles(target: RepoTarget, number: number): Promise<PullRequestFile[]> {
        const repo = await this.resolve(target);
        const viewed = this.viewed.get(this.mrKey(repo.ref, number)) ?? new Set<string>();
        return mapDiffs(await this.diffs(repo, number)).map(file => ({ ...file, viewed: viewed.has(file.path) }));
    }

    async setFileViewed(pullRequestId: string, filePath: string, viewed: boolean): Promise<void> {
        const decoded = decodeGitLabId(pullRequestId);
        if (!decoded) throw new GitLabError('The merge request ID is not a GitLab ID.', 0);
        const key = this.mrKey(decoded.repo, decoded.iid);
        const set = this.viewed.get(key) ?? new Set<string>();
        if (viewed) set.add(filePath);
        else set.delete(filePath);
        this.viewed.set(key, set);
    }

    async commitFiles(target: RepoTarget, sha: string): Promise<CommitFiles> {
        const repo = await this.resolve(target);
        const commitApi = `${repo.api}/repository/commits/${encodeURIComponent(sha)}`;
        const [commit, diffs] = await Promise.all([this.client.request<GlCommit>('GET', commitApi), this.client.all<GlDiff>(`${commitApi}/diff`, 30)]);
        return { parentSha: commit.parent_ids?.[0] ?? null, files: mapDiffs(diffs) };
    }

    async fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
        const repo = await this.resolve(target);
        const read = async (filePath: string, sha: string): Promise<string | undefined> => {
            try {
                const text = await this.client.text(`${repo.api}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(sha)}`);
                if (text.length > MAX_FILE_BYTES || text.slice(0, 8000).includes('\0')) return undefined;
                return text;
            } catch (error) {
                if (error instanceof GitLabError && error.status === 404) return '';
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
     * Sends a review: each pending comment becomes a discussion on its diff line, the body becomes a note,
     * and the event approves or revokes the approval. A comment on more than one line goes on its last line.
     */
    async submitReview(target: RepoTarget, number: number, headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void> {
        const repo = await this.resolve(target);
        const base = this.mrApi(repo, number);
        if (comments.length > 0) {
            const [mr, diffs] = await Promise.all([this.client.request<GlMergeRequest>('GET', base), this.diffs(repo, number)]);
            const refs = mr.diff_refs;
            if (!refs) throw new GitLabError('GitLab gave no diff commits for this merge request. Load it again and try again.', 0);
            const files = mapDiffs(diffs);
            for (const comment of comments) {
                const file = files.find(item => item.path === comment.path);
                await this.client.request('POST', `${base}/discussions`, {
                    body: comment.body,
                    position: {
                        position_type: 'text',
                        base_sha: refs.base_sha,
                        start_sha: refs.start_sha,
                        head_sha: refs.head_sha,
                        old_path: file?.previousPath ?? comment.path,
                        new_path: comment.path,
                        ...diffLinePosition(file?.patch, comment.side, comment.line)
                    }
                });
            }
        }
        if (body.trim()) {
            await this.client.request('POST', `${base}/notes`, { body });
        }
        if (event === 'APPROVE') {
            await this.client.request('POST', `${base}/approve`, headSha ? { sha: headSha } : {});
        } else if (event === 'UNAPPROVE') {
            await this.client.request('POST', `${base}/unapprove`);
        }
    }

    /** Returns the discussion of a note. It looks in the known discussions first, else it loads the discussions. */
    private async discussionOf(repo: ResolvedRepo, iid: number, noteId: number): Promise<string> {
        const key = `${this.mrKey(repo.ref, iid)}#${noteId}`;
        const known = this.discussions.get(key);
        if (known) return known;
        const discussions = await this.client.all<GlDiscussion>(`${this.mrApi(repo, iid)}/discussions`, 5);
        this.rememberDiscussions(repo.ref, iid, discussions);
        const found = this.discussions.get(key);
        if (!found) throw new GitLabError('The thread does not exist. It was possibly deleted.', 404);
        return found;
    }

    /** Adds a reply to a thread. `noteId` is the `databaseId` of the comments of the thread: the ID of its first note. */
    async replyToComment(target: RepoTarget, number: number, noteId: number, body: string): Promise<void> {
        const repo = await this.resolve(target);
        const discussion = await this.discussionOf(repo, number, noteId);
        await this.client.request('POST', `${this.mrApi(repo, number)}/discussions/${encodeURIComponent(discussion)}/notes`, { body });
    }

    async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
        const decoded = decodeGitLabId(threadId);
        if (!decoded?.discussionId) throw new GitLabError('The thread ID is not a GitLab thread ID.', 0);
        if (decoded.repo.host !== this.client.host()) throw new GitLabError(`The thread is not on ${this.client.host()}.`, 0);
        await this.client.request(
            'PUT',
            `/projects/${gitlabProjectId(decoded.repo)}/merge_requests/${decoded.iid}/discussions/${encodeURIComponent(decoded.discussionId)}?resolved=${resolved}`
        );
    }

    /** GitLab has award emoji on notes. ShipWarden does not support them yet, so `reactionKinds` is empty. */
    async setReaction(): Promise<void> {
        throw new GitLabError('ShipWarden does not support reactions on GitLab yet.', 0);
    }

    /** Merges the merge request. GitLab refuses the merge when the source branch has a newer commit than `headSha`. */
    async merge(target: RepoTarget, number: number, headSha: string, method: MergeMethod): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('PUT', `${this.mrApi(repo, number)}/merge`, { ...(headSha ? { sha: headSha } : {}), squash: method === 'squash' });
    }

    /** Returns the ID of a GitLab user by username. */
    private async userId(login: string): Promise<number> {
        const known = this.userIds.get(login.toLowerCase());
        if (known !== undefined) return known;
        const users = await this.client.request<GlUser[]>('GET', `/users?username=${encodeURIComponent(login)}`);
        if (!users?.[0]) throw new GitLabError(`GitLab has no user "${login}".`, 404);
        this.userIds.set(login.toLowerCase(), users[0].id);
        return users[0].id;
    }

    async changePullRequest(target: RepoTarget, number: number, change: PullRequestChange): Promise<void> {
        const repo = await this.resolve(target);
        const base = this.mrApi(repo, number);
        switch (change.kind) {
            case 'details': {
                const update: Record<string, unknown> = {};
                if (change.title !== undefined) update.title = change.title;
                if (change.body !== undefined) update.description = change.body;
                if (change.state) update.state_event = change.state === 'closed' ? 'close' : 'reopen';
                await this.client.request('PUT', base, update);
                return;
            }
            case 'base':
                await this.client.request('PUT', base, { target_branch: change.base });
                return;
            case 'draft': {
                const mr = await this.client.request<GlMergeRequest>('GET', base);
                await this.client.request('PUT', base, { title: draftTitle(mr.title, change.draft) });
                return;
            }
            case 'autoMerge':
                if (change.method) {
                    // "auto_merge" replaces "merge_when_pipeline_succeeds" in GitLab 17.11. Older servers ignore it.
                    await this.client.request('PUT', `${base}/merge`, {
                        auto_merge: true,
                        merge_when_pipeline_succeeds: true,
                        squash: change.method === 'squash',
                        ...(change.headSha ? { sha: change.headSha } : {})
                    });
                } else {
                    await this.client.request('POST', `${base}/cancel_merge_when_pipeline_succeeds`);
                }
                return;
            case 'mergeQueue':
                throw new GitLabError('ShipWarden does not support the GitLab merge train.', 0);
            case 'assignee':
            case 'reviewer': {
                const login = change.kind === 'assignee' ? change.login : change.reviewer.login;
                const [mr, id] = await Promise.all([this.client.request<GlMergeRequest>('GET', base), this.userId(login)]);
                const current = ((change.kind === 'assignee' ? mr.assignees : mr.reviewers) ?? []).map(user => user.id);
                const next = change.add ? [...new Set([...current, id])] : current.filter(item => item !== id);
                await this.client.request('PUT', base, change.kind === 'assignee' ? { assignee_ids: next } : { reviewer_ids: next });
                return;
            }
            case 'label':
                await this.client.request('PUT', base, change.add ? { add_labels: change.name } : { remove_labels: change.name });
                return;
        }
    }

    /** The members of the project (also of its groups) and the labels of the project, for the pickers. */
    async pullRequestCandidates(target: RepoTarget): Promise<PullRequestCandidates> {
        const repo = await this.resolve(target);
        const [members, labels] = await Promise.all([this.client.all<GlUser>(`${repo.api}/members/all`, 3), this.projectLabels(repo)]);
        for (const member of members) this.userIds.set(member.username.toLowerCase(), member.id);
        const users = members.map(userOf).filter((user): user is GitHubUser => !!user);
        return { users, labels: labels.map(labelOf) satisfies GitHubLabel[] };
    }

    /** GitLab uses "!" for merge requests and "#" for issues. The comment box shows no "#" list for GitLab yet. */
    async issueReferences(): Promise<IssueReference[]> {
        return [];
    }

    async issueReference(): Promise<IssueReference | null> {
        return null;
    }

    /** The jobs of a pipeline, the newest try of each job, in the order of creation. */
    private async pipelineJobs(repo: ResolvedRepo, pipelineId: number): Promise<GlJob[]> {
        const jobs = await this.client.all<GlJob>(`${repo.api}/pipelines/${pipelineId}/jobs`, 3);
        return latestJobs(jobs).sort((a, b) => a.id - b.id);
    }

    /** The jobs of the newest pipeline of the commit. Each job is one check. */
    async checks(target: RepoTarget, sha: string): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        const pipelines = await this.client.request<GlPipeline[]>(
            'GET',
            `${repo.api}/pipelines?sha=${encodeURIComponent(sha)}&order_by=id&sort=desc&per_page=1`
        );
        const pipeline = pipelines[0];
        if (!pipeline) return [];
        return (await this.pipelineJobs(repo, pipeline.id)).map(jobToCheck);
    }

    async jobProgress(target: RepoTarget, jobId: number): Promise<JobProgress> {
        const repo = await this.resolve(target);
        return jobProgressOf(await this.client.request<GlJob>('GET', `${repo.api}/jobs/${jobId}`));
    }

    /** The log (trace) of a job, without the section markers and the color codes. */
    async jobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        return cleanGitLabTrace(await this.client.text(`${repo.api}/jobs/${jobId}/trace`));
    }

    async saveJobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        const folder = path.join(os.homedir(), '.shipwarden', 'ci-logs');
        await fs.mkdir(folder, { recursive: true });
        const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, '_');
        const file = path.join(folder, `${safe(repo.ref.namespace)}-${safe(repo.ref.project)}-job-${jobId}.log`);
        await fs.writeFile(file, await this.jobLog(target, jobId));
        return file;
    }

    /** Runs a job again (retry). GitLab makes a new job. */
    async rerunJob(target: RepoTarget, jobId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${repo.api}/jobs/${jobId}/retry`);
    }

    /** Runs the failed and the canceled jobs of a pipeline again. */
    async rerunFailedJobs(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${repo.api}/pipelines/${runId}/retry`);
    }

    /** A GitLab project has one pipeline definition (.gitlab-ci.yml). It can start by hand on a branch. */
    async workflows(target: RepoTarget, _ref: string): Promise<Workflow[]> {
        await this.resolve(target);
        return [{ id: GITLAB_PIPELINE_WORKFLOW_ID, name: 'Pipeline', path: '.gitlab-ci.yml', dispatchable: true, inputs: [] }];
    }

    /** Starts a new pipeline on a branch. The inputs become CI/CD variables of the pipeline. */
    async dispatchWorkflow(target: RepoTarget, _workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void> {
        const repo = await this.resolve(target);
        const variables = Object.entries(inputs ?? {}).map(([key, value]) => ({ key, value }));
        await this.client.request('POST', `${repo.api}/pipeline`, { ref, ...(variables.length > 0 ? { variables } : {}) });
    }

    async workflowRuns(target: RepoTarget, _workflowId?: number): Promise<WorkflowRun[]> {
        const repo = await this.resolve(target);
        return (await this.client.request<GlPipeline[]>('GET', `${repo.api}/pipelines?per_page=40`)).map(pipelineToRun);
    }

    async runJobs(target: RepoTarget, runId: number): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        return (await this.pipelineJobs(repo, runId)).map(jobToCheck);
    }

    async cancelRun(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${repo.api}/pipelines/${runId}/cancel`);
    }

    /**
     * Runs a pipeline again. GitLab retries the failed and the canceled jobs of the same pipeline. A merge request
     * pipeline cannot start again on its ref with the pipeline API, so a retry is the safe choice.
     */
    async rerunRun(target: RepoTarget, runId: number): Promise<void> {
        await this.rerunFailedJobs(target, runId);
    }

    async branches(target: RepoTarget): Promise<string[]> {
        const repo = await this.resolve(target);
        const data = await this.client.all<{ name: string }>(`${repo.api}/repository/branches`, 3);
        const main = repo.project.default_branch || 'main';
        return [main, ...data.map(item => item.name).filter(name => name !== main)];
    }

    /** Uploads the images to the project and adds a note with them to the merge request. */
    async postScreenshots(target: RepoTarget, number: number, files: UploadFile[], body: (urls: string[]) => string): Promise<string | undefined> {
        const repo = await this.resolve(target);
        const urls = await uploadToGitLab(this.client, repo.api, files);
        await commentOnGitLab(this.client, this.mrApi(repo, number), body(urls));
        return undefined;
    }
}
