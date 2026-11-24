import { myPullRequestReasons, type MyPullRequestItem, type ReviewRequestItem } from '@shared/dashboard';
import { splitUnifiedDiff } from '@shared/bitbucket';
import type {
    BranchSummary,
    CheckRun,
    GitHubLabel,
    GitHubUser,
    IssueComment,
    JobProgress,
    MergedPullRequest,
    PullRequest,
    PullRequestCommit,
    PullRequestFile,
    PullRequestState,
    PullRequestSummary,
    Review,
    ReviewComment,
    ReviewDecision,
    ReviewThread
} from '@shared/github';
import {
    actionsStatusToCheck,
    commitStatusToCheck,
    encodeGiteaId,
    GITEA_REVIEW_EVENTS,
    giteaMergeMethods,
    giteaPullRequestWebUrl,
    giteaRepoRef,
    giteaRepoWebUrl,
    hasDraftPrefix,
    type GiteaRepoRef
} from '@shared/gitea';
import { patchLineCounts } from '@shared/gitlab';
import type { WorkflowRun } from '@shared/pipelines';
import { reviewStatusOf, uniqueLogins, type CheckSummary, type OpenPullRequest, type ReviewStatus } from '@shared/review-queue';
import { NumericIds } from '../bitbucket/bitbucket-mapping';

export { NumericIds };

// The raw shapes of the Gitea and Forgejo REST API v1. Only the fields that ShipWarden reads are here.
// See https://gitea.com/api/swagger and https://codeberg.org/api/swagger

export interface GtUser {
    id: number;
    login: string;
    full_name?: string;
    avatar_url?: string;
}

export interface GtRepo {
    id: number;
    name: string;
    full_name: string;
    owner: GtUser;
    html_url?: string;
    default_branch?: string;
    updated_at?: string;
    archived?: boolean;
    allow_merge_commits?: boolean;
    allow_rebase?: boolean;
    allow_squash_merge?: boolean;
    /** "merge", "rebase", "rebase-merge", "squash", "fast-forward-only", or "manually-merged". */
    default_merge_style?: string;
    permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
    has_actions?: boolean;
}

export interface GtLabel {
    id: number;
    name: string;
    /** "e11d21" on older servers, "#e11d21" on newer servers. */
    color?: string;
    description?: string;
}

export interface GtBranchInfo {
    label?: string;
    ref: string;
    sha: string;
    repo_id?: number;
}

export interface GtPullRequest {
    id: number;
    number: number;
    title: string;
    body?: string | null;
    user: GtUser;
    labels?: GtLabel[] | null;
    assignees?: GtUser[] | null;
    requested_reviewers?: GtUser[] | null;
    state: 'open' | 'closed' | string;
    /** Newer servers only. Older servers mark a draft with a "WIP:" title. */
    draft?: boolean;
    comments?: number;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    html_url: string;
    /** False for a conflict, and also while the server checks the pull request. */
    mergeable?: boolean;
    merged?: boolean;
    merged_at?: string | null;
    merged_by?: GtUser | null;
    base: GtBranchInfo;
    head: GtBranchInfo;
    created_at: string;
    updated_at: string;
}

/** "APPROVED", "PENDING", "COMMENT", "REQUEST_CHANGES", or "REQUEST_REVIEW". */
export interface GtReview {
    id: number;
    user: GtUser | null;
    state: string;
    body?: string;
    commit_id?: string;
    stale?: boolean;
    official?: boolean;
    dismissed?: boolean;
    submitted_at?: string;
    html_url?: string;
    comments_count?: number;
}

/** A comment on a line of the diff. `position` is the line on the new side. `original_position` is the line on the old side. */
export interface GtReviewComment {
    id: number;
    body: string;
    user: GtUser | null;
    resolver?: GtUser | null;
    pull_request_review_id?: number;
    path: string;
    commit_id?: string;
    original_commit_id?: string;
    diff_hunk?: string;
    position?: number;
    original_position?: number;
    html_url?: string;
    created_at: string;
}

export interface GtIssueComment {
    id: number;
    html_url?: string;
    user: GtUser | null;
    body: string;
    created_at: string;
}

export interface GtCommit {
    sha: string;
    html_url?: string;
    commit: { message: string; author?: { name?: string; date?: string }; committer?: { name?: string; date?: string } };
    author?: GtUser | null;
    parents?: { sha: string }[];
}

export interface GtCommitStatus {
    id: number;
    /** "pending", "success", "error", "failure", "warning", or "skipped". */
    status: string;
    target_url?: string;
    description?: string;
    context: string;
    created_at?: string;
    updated_at?: string;
}

export interface GtCombinedStatus {
    state?: string;
    sha?: string;
    statuses?: GtCommitStatus[] | null;
}

/** A run of the newer Actions API (`/actions/runs`). */
export interface GtRun {
    id: number;
    display_title?: string;
    /** The workflow file, for example "ci.yml" or ".gitea/workflows/ci.yml@refs/heads/main". */
    path?: string;
    event?: string;
    head_branch?: string;
    head_sha: string;
    html_url?: string;
    run_number?: number;
    status: string;
    conclusion?: string | null;
    created_at?: string;
    updated_at?: string;
    started_at?: string | null;
    actor?: GtUser | null;
    trigger_actor?: GtUser | null;
}

export interface GtStep {
    number: number;
    name: string;
    status: string;
    conclusion?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
}

/** A job of the newer Actions API (`/actions/runs/{run}/jobs`). */
export interface GtJob {
    id: number;
    run_id: number;
    name: string;
    status: string;
    conclusion?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    html_url?: string;
    head_sha?: string;
    steps?: GtStep[] | null;
}

/** A task (one try of a job) of the older Actions API (`/actions/tasks`). */
export interface GtTask {
    id: number;
    name: string;
    display_title?: string;
    head_branch?: string;
    head_sha: string;
    run_number: number;
    event?: string;
    status: string;
    /** The workflow file name, for example "ci.yml". */
    workflow_id?: string;
    url?: string;
    created_at?: string;
    updated_at?: string;
    run_started_at?: string;
}

/** An item of the issue search (`/repos/issues/search`). A pull request has `pull_request`. */
export interface GtIssue {
    id: number;
    number: number;
    title: string;
    html_url: string;
    user: GtUser | null;
    state: string;
    created_at: string;
    updated_at: string;
    repository?: { id?: number; name: string; owner: string; full_name?: string };
    pull_request?: { merged?: boolean; draft?: boolean } | null;
}

/** A user for the UI. The login is the username. */
export function userOf(user: GtUser | null | undefined): GitHubUser | null {
    if (!user) return null;
    return { login: user.login, ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}), ...(user.full_name ? { name: user.full_name } : {}) };
}

function sameUser(a: GtUser | null | undefined, b: GtUser | null | undefined): boolean {
    return !!a && !!b && (a.id === b.id || a.login.toLowerCase() === b.login.toLowerCase());
}

export function pullRequestState(pr: Pick<GtPullRequest, 'state' | 'merged'>): PullRequestState {
    if (pr.merged) return 'MERGED';
    return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** True for a draft. Older servers have no `draft` field, so the "WIP:" prefix of the title decides. */
export function isDraft(pr: Pick<GtPullRequest, 'draft' | 'title'>): boolean {
    return pr.draft ?? hasDraftPrefix(pr.title);
}

/**
 * The merge state of a pull request, in the words of GitHub. `myPullRequestReasons` and the merge button read them.
 * The API gives only `mergeable`. It is false for a conflict and also while the server checks the pull request,
 * so false is "CONFLICTING".
 */
export function mergeStateOf(pr: Pick<GtPullRequest, 'state' | 'merged' | 'mergeable' | 'draft' | 'title'>): { mergeable: string; mergeStateStatus: string } {
    if (pullRequestState(pr) !== 'OPEN' || pr.mergeable === undefined) return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
    if (!pr.mergeable) return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    return { mergeable: 'MERGEABLE', mergeStateStatus: isDraft(pr) ? 'DRAFT' : 'CLEAN' };
}

/** The review state of GitHub for a review state of Gitea. */
export function reviewStateOf(review: Pick<GtReview, 'state' | 'dismissed'>): string {
    if (review.dismissed) return 'DISMISSED';
    if (review.state === 'APPROVED') return 'APPROVED';
    if (review.state === 'REQUEST_CHANGES') return 'CHANGES_REQUESTED';
    if (review.state === 'PENDING') return 'PENDING';
    return 'COMMENTED';
}

/** True for a review that a person sent. A pending review (a draft) and a review request are not reviews. */
function isSubmitted(review: GtReview): boolean {
    return review.state !== 'PENDING' && review.state !== 'REQUEST_REVIEW';
}

/** The newest approval or request for changes of each user. Dismissed reviews do not count. */
export function latestVerdicts(reviews: readonly GtReview[]): Map<string, 'APPROVED' | 'CHANGES_REQUESTED'> {
    const latest = new Map<string, { id: number; state: 'APPROVED' | 'CHANGES_REQUESTED' }>();
    for (const review of reviews) {
        if (!review.user || review.dismissed || (review.state !== 'APPROVED' && review.state !== 'REQUEST_CHANGES')) continue;
        const key = review.user.login.toLowerCase();
        const current = latest.get(key);
        if (!current || review.id > current.id) latest.set(key, { id: review.id, state: review.state === 'APPROVED' ? 'APPROVED' : 'CHANGES_REQUESTED' });
    }
    return new Map([...latest].map(([key, value]) => [key, value.state]));
}

/**
 * The review decision of a pull request from its reviews.
 * - "changes requested": a user's newest verdict asks for changes.
 * - "approved": at least one approval and no request for changes.
 * - "review required": the pull request has requested reviewers and no verdict.
 * - null: no verdicts and no requested reviewers.
 * The API does not give the approvals that a protected branch needs, so one approval is "approved".
 */
export function reviewDecisionOf(reviews: readonly GtReview[], requestedCount: number): ReviewDecision {
    const verdicts = [...latestVerdicts(reviews).values()];
    if (verdicts.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
    if (verdicts.includes('APPROVED')) return 'APPROVED';
    return requestedCount > 0 ? 'REVIEW_REQUIRED' : null;
}

/** A label for the UI. The color has no "#". */
export function labelOf(label: GtLabel): GitHubLabel {
    return { name: label.name, color: (label.color || '8b949e').replace(/^#/, ''), description: label.description || null };
}

/** The ID of a review for the UI. */
export function reviewIdOf(repo: GiteaRepoRef, number: number, reviewId: number): string {
    return `${encodeGiteaId(repo, number)}#review:${reviewId}`;
}

/** The place of a comment in the diff: the side and the line. A comment without a line is on the file. */
export function commentLine(comment: Pick<GtReviewComment, 'position' | 'original_position'>): { side: 'LEFT' | 'RIGHT'; line: number | null } {
    if (comment.position) return { side: 'RIGHT', line: comment.position };
    if (comment.original_position) return { side: 'LEFT', line: comment.original_position };
    return { side: 'RIGHT', line: null };
}

/** The place of a thread, for a reply without the replies API: the file, the side, and the line. */
export interface ThreadPlace {
    path: string;
    side: 'LEFT' | 'RIGHT';
    line: number | null;
}

/**
 * Groups the line comments of a pull request into threads. Gitea and Forgejo keep a conversation as the comments on
 * the same file, side, and line. A reply is a new comment on that line, often in another review.
 * Each comment of a thread has the ID of the first comment as `databaseId`. A reply and "resolve" use it.
 * A thread is resolved when one of its comments has a resolver.
 * The API does not tell whether a comment is outdated, so no thread is outdated.
 */
export function mapThreads(
    repo: GiteaRepoRef,
    number: number,
    comments: readonly GtReviewComment[],
    reviewIds: ReadonlySet<number>
): { threads: ReviewThread[]; places: Map<number, ThreadPlace> } {
    const groups = new Map<string, GtReviewComment[]>();
    const sorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
    for (const comment of sorted) {
        if (comment.pull_request_review_id !== undefined && !reviewIds.has(comment.pull_request_review_id)) continue;
        const { side, line } = commentLine(comment);
        const key = `${comment.path}\u0000${side}\u0000${line ?? ''}`;
        const list = groups.get(key) ?? [];
        list.push(comment);
        groups.set(key, list);
    }
    const threads: ReviewThread[] = [];
    const places = new Map<number, ThreadPlace>();
    for (const list of groups.values()) {
        const first = list[0];
        const { side, line } = commentLine(first);
        places.set(first.id, { path: first.path, side, line });
        const items: ReviewComment[] = list.map(comment => ({
            id: `gitea-comment:${comment.id}`,
            databaseId: first.id,
            author: userOf(comment.user),
            body: comment.body,
            createdAt: comment.created_at,
            url: comment.html_url ?? '',
            ...(comment.diff_hunk ? { diffHunk: comment.diff_hunk } : {}),
            ...(comment.pull_request_review_id ? { reviewId: reviewIdOf(repo, number, comment.pull_request_review_id) } : {})
        }));
        threads.push({
            id: encodeGiteaId(repo, number, first.id),
            path: first.path,
            line,
            originalLine: line,
            startLine: null,
            originalStartLine: null,
            side,
            isResolved: list.some(comment => !!comment.resolver),
            isOutdated: false,
            comments: items
        });
    }
    return { threads, places };
}

/** Converts the comments of the conversation to the UI model: the newest 50, the oldest first. */
export function mapIssueComments(comments: readonly GtIssueComment[], webUrl: string): IssueComment[] {
    return [...comments]
        .filter(comment => comment.body.trim() !== '')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(-50)
        .map(comment => ({
            id: `gitea-issue-comment:${comment.id}`,
            author: userOf(comment.user),
            body: comment.body,
            createdAt: comment.created_at,
            url: comment.html_url ?? `${webUrl}#issuecomment-${comment.id}`
        }));
}

/**
 * Converts the commits of a pull request to the UI model: the newest 100, the oldest first. The order of the API is not
 * the same on all versions, so the commit time decides.
 */
export function mapCommits(repo: GiteaRepoRef, commits: readonly GtCommit[]): PullRequestCommit[] {
    const time = (commit: GtCommit) => commit.commit.committer?.date ?? commit.commit.author?.date ?? '';
    const sorted = [...commits].sort((a, b) => time(a).localeCompare(time(b)));
    return sorted.slice(-100).map(commit => ({
        oid: commit.sha,
        abbreviatedOid: commit.sha.slice(0, 10),
        messageHeadline: commit.commit.message.split('\n')[0],
        committedDate: commit.commit.committer?.date ?? commit.commit.author?.date ?? '',
        url: commit.html_url ?? `${giteaRepoWebUrl(repo)}/commit/${commit.sha}`,
        author: commit.author?.login ?? commit.commit.author?.name ?? null
    }));
}

/**
 * Converts a unified diff (the ".diff" of a pull request or a commit) to the files of the UI. The file status comes
 * from the paths: no old path is "added", no new path is "removed", and two paths are "renamed". A binary file has no
 * "---" and "+++" lines, so its "new file mode" or "deleted file mode" line gives the status.
 */
export function mapDiffFiles(diff: string): PullRequestFile[] {
    const modes = diff
        .replace(/\r\n/g, '\n')
        .split(/^diff --git /m)
        .slice(1)
        .map(block => (/^new file mode /m.test(block) ? 'added' : /^deleted file mode /m.test(block) ? 'removed' : undefined));
    return splitUnifiedDiff(diff).map((file, index) => {
        const status = modes[index] ?? (!file.oldPath ? 'added' : !file.newPath ? 'removed' : file.oldPath !== file.newPath ? 'renamed' : 'modified');
        const path = file.newPath ?? file.oldPath ?? '';
        return {
            path,
            ...(status === 'renamed' && file.oldPath ? { previousPath: file.oldPath } : {}),
            status,
            ...patchLineCounts(file.patch),
            ...(file.patch ? { patch: file.patch } : {})
        };
    });
}

export interface PullRequestParts {
    repo: GiteaRepoRef;
    pr: GtPullRequest;
    repoInfo?: GtRepo;
    reviews: readonly GtReview[];
    reviewComments: readonly GtReviewComment[];
    issueComments: readonly GtIssueComment[];
    commits: readonly GtCommit[];
    /** The number of checks on the head commit. */
    checkCount?: number;
    /** The user of the token. */
    viewer?: GtUser;
}

/** Converts a pull request with its reviews, comments, and commits to the UI model. */
export function mapPullRequest(parts: PullRequestParts): { pullRequest: PullRequest; places: Map<number, ThreadPlace> } {
    const { repo, pr, viewer } = parts;
    const url = pr.html_url || giteaPullRequestWebUrl(repo, pr.number);
    const submitted = parts.reviews.filter(isSubmitted);
    const { threads, places } = mapThreads(repo, pr.number, parts.reviewComments, new Set(submitted.map(review => review.id)));
    const reviews: Review[] = submitted
        // A review of only line comments has no body. Its comments are in the threads.
        .filter(review => review.state !== 'COMMENT' || (review.body ?? '').trim() !== '')
        .map(review => ({
            id: reviewIdOf(repo, pr.number, review.id),
            author: userOf(review.user),
            state: reviewStateOf(review),
            body: review.body ?? '',
            submittedAt: review.submitted_at ?? null,
            url: review.html_url ?? url
        }));
    const requested = pr.requested_reviewers ?? [];
    const verdicts = latestVerdicts(parts.reviews);
    const state = pullRequestState(pr);
    const methods = giteaMergeMethods(parts.repoInfo ?? {});
    const canPush = parts.repoInfo?.permissions ? !!parts.repoInfo.permissions.push : true;
    const draft = isDraft(pr);
    return {
        places,
        pullRequest: {
            id: encodeGiteaId(repo, pr.number),
            number: pr.number,
            title: pr.title,
            body: pr.body ?? '',
            url,
            state,
            isDraft: draft,
            ...mergeStateOf(pr),
            reviewDecision: reviewDecisionOf(parts.reviews, requested.length),
            author: userOf(pr.user),
            baseRefName: pr.base.ref,
            headRefName: pr.head.ref,
            isCrossRepository: pr.head.repo_id !== undefined && pr.base.repo_id !== undefined && pr.head.repo_id !== pr.base.repo_id,
            baseRefOid: pr.base.sha,
            headRefOid: pr.head.sha,
            additions: pr.additions ?? 0,
            deletions: pr.deletions ?? 0,
            changedFiles: pr.changed_files ?? 0,
            createdAt: pr.created_at,
            viewerDidAuthor: sameUser(pr.user, viewer),
            reviews,
            issueComments: mapIssueComments(parts.issueComments, url),
            threads,
            allowedMergeMethods: methods.allowed,
            defaultMergeMethod: methods.preferred,
            commits: mapCommits(repo, parts.commits),
            commitCount: parts.commits.length,
            checkCount: parts.checkCount ?? 0,
            assignees: (pr.assignees ?? []).map(userOf).filter((user): user is GitHubUser => !!user),
            reviewRequests: requested.filter(user => !verdicts.has(user.login.toLowerCase())).map(user => ({ kind: 'user' as const, login: user.login })),
            viewerIsRequested: viewer ? !draft && requested.some(user => sameUser(user, viewer)) : undefined,
            labels: (pr.labels ?? []).map(labelOf),
            viewerCanUpdate: true,
            viewerCanManage: canPush,
            // The API has the scheduled merge ("merge when checks succeed") but does not show it on a pull request, so
            // ShipWarden does not offer auto-merge.
            autoMerge: null,
            viewerCanEnableAutoMerge: false,
            viewerCanDisableAutoMerge: false,
            viewerCanMerge: canPush,
            host: 'gitea',
            reviewEvents: GITEA_REVIEW_EVENTS,
            // Reactions need one request for each comment, so ShipWarden does not show them.
            reactionKinds: []
        }
    };
}

/** The file name of a workflow from the path of a run, for example "ci.yml" from ".gitea/workflows/ci.yml@refs/heads/main". */
export function workflowFileOf(path: string | null | undefined): string {
    const plain = (path ?? '').replace(/@.*$/, '');
    return plain.slice(plain.lastIndexOf('/') + 1) || 'workflow';
}

/** The text key of a workflow file for `NumericIds`. */
export function workflowKey(file: string): string {
    return `workflow:${file}`;
}

/** Converts a run of the newer Actions API to a run of the Pipelines view. */
export function runToWorkflowRun(run: GtRun, ids: NumericIds): WorkflowRun {
    const mapped = actionsStatusToCheck(run.status, run.conclusion);
    const file = workflowFileOf(run.path);
    return {
        id: run.id,
        title: run.display_title || `Run #${run.run_number ?? run.id}`,
        workflowId: ids.idOf(workflowKey(file)),
        workflowName: file,
        runNumber: run.run_number ?? run.id,
        branch: run.head_branch || null,
        event: run.event ?? 'push',
        status: mapped.status,
        conclusion: mapped.conclusion,
        actor: (run.trigger_actor ?? run.actor)?.login ?? null,
        createdAt: run.created_at ?? run.started_at ?? '',
        updatedAt: run.updated_at ?? run.created_at ?? '',
        startedAt: run.started_at ?? null,
        url: run.html_url ?? '',
        headSha: run.head_sha
    };
}

/** Converts a job of the newer Actions API to a check. It has a log and can run again. */
export function jobToCheck(job: GtJob): CheckRun {
    const mapped = actionsStatusToCheck(job.status, job.conclusion);
    return {
        id: job.id,
        name: job.name,
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: job.started_at ?? null,
        completedAt: mapped.status === 'completed' ? (job.completed_at ?? null) : null,
        url: job.html_url ?? null,
        runId: job.run_id,
        isActions: true
    };
}

/** The progress of a job for the log view, with its steps. */
export function jobProgressOf(job: GtJob): JobProgress {
    const mapped = actionsStatusToCheck(job.status, job.conclusion);
    return {
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: job.started_at ?? null,
        completedAt: mapped.status === 'completed' ? (job.completed_at ?? null) : null,
        steps: (job.steps ?? []).map(step => {
            const item = actionsStatusToCheck(step.status, step.conclusion);
            return {
                number: step.number,
                name: step.name,
                status: item.status,
                conclusion: item.conclusion,
                startedAt: step.started_at ?? null,
                completedAt: item.status === 'completed' ? (step.completed_at ?? null) : null
            };
        })
    };
}

/**
 * Converts a task of the older Actions API to a check. The older API has no job log, so the check has no log and
 * cannot run again from ShipWarden.
 */
export function taskToCheck(task: GtTask): CheckRun {
    const mapped = actionsStatusToCheck(task.status);
    return {
        id: task.id,
        name: task.name,
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: task.run_started_at ?? null,
        completedAt: mapped.status === 'completed' ? (task.updated_at ?? null) : null,
        url: task.url ?? null,
        runId: task.run_number,
        isActions: false
    };
}

/**
 * Converts the tasks of the older Actions API to runs of the Pipelines view. A run is the tasks with the same run
 * number. Its ID is the run number. A run fails when a task fails, and it is active while a task is active.
 */
export function tasksToRuns(tasks: readonly GtTask[], ids: NumericIds): WorkflowRun[] {
    const groups = new Map<number, GtTask[]>();
    for (const task of tasks) {
        const list = groups.get(task.run_number) ?? [];
        list.push(task);
        groups.set(task.run_number, list);
    }
    const runs: WorkflowRun[] = [];
    for (const [runNumber, list] of groups) {
        const first = [...list].sort((a, b) => a.id - b.id)[0];
        const checks = list.map(taskToCheck);
        const active = checks.some(check => check.status !== 'completed');
        const failed = checks.find(check => check.conclusion === 'failure' || check.conclusion === 'cancelled');
        const file = first.workflow_id || 'workflow';
        runs.push({
            id: runNumber,
            title: first.display_title || first.name,
            workflowId: ids.idOf(workflowKey(file)),
            workflowName: file,
            runNumber,
            branch: first.head_branch || null,
            event: first.event ?? 'push',
            status: active ? 'in_progress' : 'completed',
            conclusion: active ? null : (failed?.conclusion ?? 'success'),
            actor: null,
            createdAt: first.created_at ?? '',
            updatedAt:
                list
                    .map(task => task.updated_at ?? '')
                    .sort()
                    .pop() ?? '',
            startedAt: first.run_started_at ?? null,
            url: (first.url ?? '').replace(/\/jobs\/\d+$/, ''),
            headSha: first.head_sha
        });
    }
    return runs.sort((a, b) => b.runNumber - a.runNumber);
}

/** Converts a commit status to a check. A status has no log in ShipWarden. */
export function statusToCheck(status: GtCommitStatus): CheckRun {
    const mapped = commitStatusToCheck(status.status);
    return {
        id: status.id,
        name: status.context,
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: status.created_at ?? null,
        completedAt: mapped.status === 'completed' ? (status.updated_at ?? null) : null,
        url: status.target_url || null,
        isActions: false,
        isStatus: true
    };
}

/** True when a commit status comes from Gitea Actions. Its target is the page of a job of a run. */
export function isActionsStatus(status: GtCommitStatus): boolean {
    return /\/actions\/runs\/\d+(?:\/jobs\/\d+)?\/?$/.test(status.target_url ?? '');
}

/** Keeps the newest run of each workflow. The API lists the newest runs first, but the ID decides. */
export function latestRuns(runs: readonly GtRun[]): GtRun[] {
    const newest = new Map<string, GtRun>();
    for (const run of runs) {
        const key = workflowFileOf(run.path);
        const current = newest.get(key);
        if (!current || run.id > current.id) newest.set(key, run);
    }
    return [...newest.values()];
}

/**
 * Returns the combined CI state of each commit from the newest runs: FAILURE when a run failed, PENDING while a run
 * is active, else SUCCESS. The newest run of each workflow on the commit counts.
 */
export function runStatesBySha(runs: readonly GtRun[]): Map<string, string> {
    const bySha = new Map<string, GtRun[]>();
    for (const run of runs) {
        const list = bySha.get(run.head_sha) ?? [];
        list.push(run);
        bySha.set(run.head_sha, list);
    }
    const states = new Map<string, string>();
    for (const [sha, list] of bySha) {
        const mapped = latestRuns(list).map(run => actionsStatusToCheck(run.status, run.conclusion));
        const state = mapped.some(item => item.conclusion === 'failure' || item.conclusion === 'cancelled')
            ? 'FAILURE'
            : mapped.some(item => item.status !== 'completed')
              ? 'PENDING'
              : 'SUCCESS';
        states.set(sha, state);
    }
    return states;
}

/** The check summary of a commit for the review queue. The runs give one state, so the total is 1. */
export function checkSummaryOf(state: string | undefined): CheckSummary {
    if (!state) return { state: null, failing: 0, pending: 0, total: 0 };
    return { state, failing: state === 'FAILURE' ? 1 : 0, pending: state === 'PENDING' ? 1 : 0, total: 1 };
}

/** The reviewers, the assignees, and the review status of a pull request from the list API, which has no reviews. */
function peopleOf(pr: GtPullRequest): { assignees: string[]; reviewers: string[]; reviewStatus: ReviewStatus } {
    const requested = pr.requested_reviewers ?? [];
    return {
        assignees: (pr.assignees ?? []).map(user => user.login),
        reviewers: uniqueLogins([requested.filter(user => !sameUser(user, pr.user)).map(user => user.login)]),
        reviewStatus: reviewStatusOf(requested.length > 0 ? 'REVIEW_REQUIRED' : null)
    };
}

/** True when the viewer is a requested reviewer of an open pull request and did not write it. A draft asks for no review. */
export function viewerIsReviewer(pr: GtPullRequest, viewer: GtUser | undefined): boolean {
    return !!viewer && !isDraft(pr) && !sameUser(pr.user, viewer) && (pr.requested_reviewers ?? []).some(user => sameUser(user, viewer));
}

/** Converts an open pull request to the model of the review queue. The list API has no reviews, so the decision is not known. */
export function openPullRequestOf(repo: GiteaRepoRef, pr: GtPullRequest, states: Map<string, string>, viewer: GtUser | undefined): OpenPullRequest {
    const checks = checkSummaryOf(states.get(pr.head.sha));
    const viewerDidAuthor = sameUser(pr.user, viewer);
    return {
        id: encodeGiteaId(repo, pr.number),
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        author: pr.user.login,
        isDraft: isDraft(pr),
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        headRefName: pr.head.ref,
        baseRefName: pr.base.ref,
        headRefOid: pr.head.sha,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: pr.changed_files ?? 0,
        comments: pr.comments ?? 0,
        viewerDidAuthor,
        reviewRequested: viewerIsReviewer(pr, viewer),
        reviewDecision: null,
        checks,
        actions: viewerDidAuthor ? myPullRequestReasons({ isDraft: isDraft(pr), reviewDecision: null, ...mergeStateOf(pr), checks: checks.state }) : [],
        ...peopleOf(pr)
    };
}

/** Converts a pull request to a row of the pull request list. A pull request that is not open has no CI state. */
export function pullRequestSummaryOf(pr: GtPullRequest, states: Map<string, string>, viewer: GtUser | undefined): PullRequestSummary {
    const state = pullRequestState(pr);
    return {
        number: pr.number,
        title: pr.title,
        author: pr.user.login,
        isDraft: isDraft(pr),
        state,
        updatedAt: pr.updated_at,
        reviewDecision: null,
        checks: state === 'OPEN' ? (states.get(pr.head.sha) ?? null) : null,
        comments: pr.comments ?? 0,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        viewerDidAuthor: sameUser(pr.user, viewer),
        ...peopleOf(pr)
    };
}

/** Returns the repository of an item of the issue search. Returns undefined when the item has no repository. */
export function repoOfIssue(host: string, issue: GtIssue): GiteaRepoRef | undefined {
    const repo = issue.repository;
    if (!repo?.owner || !repo.name) return undefined;
    return { host, owner: repo.owner, repo: repo.name };
}

/** Converts a pull request that asks the viewer for a review to an item of the Dashboard. */
export function reviewRequestItemOf(repo: GiteaRepoRef, issue: GtIssue): ReviewRequestItem {
    return {
        repo: giteaRepoRef(repo),
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        author: issue.user?.login ?? null,
        updatedAt: issue.updated_at,
        createdAt: issue.created_at
    };
}

/**
 * Converts a pull request of the viewer to an item of the Dashboard. Returns undefined when the viewer has nothing to
 * do on it. The pull request API has no reviews, so the item shows only conflicts.
 */
export function myPullRequestItemOf(repo: GiteaRepoRef, pr: GtPullRequest): MyPullRequestItem | undefined {
    const reasons = myPullRequestReasons({ isDraft: isDraft(pr), reviewDecision: null, ...mergeStateOf(pr), checks: null });
    if (reasons.length === 0) return undefined;
    return {
        repo: giteaRepoRef(repo),
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        updatedAt: pr.updated_at,
        createdAt: pr.created_at,
        reasons,
        headSha: pr.head.sha
    };
}

/** Returns the newest merged pull request of each head branch. */
export function mergedBranches(prs: readonly GtPullRequest[]): Record<string, MergedPullRequest> {
    const merged: Record<string, MergedPullRequest> = {};
    const newest = [...prs].sort((a, b) => (b.merged_at ?? b.updated_at).localeCompare(a.merged_at ?? a.updated_at));
    for (const pr of newest) {
        if (!pr.merged || !pr.head.sha) continue;
        if (!merged[pr.head.ref]) merged[pr.head.ref] = { number: pr.number, title: pr.title, headSha: pr.head.sha };
    }
    return merged;
}

/**
 * Returns the open pull requests by head branch, with the CI state of their head commit.
 * The viewer sets the viewer role: "author" for the author, "involved" for a requested reviewer or an assignee.
 */
export function branchSummaries(prs: readonly GtPullRequest[], states: Map<string, string>, viewer?: GtUser): Record<string, BranchSummary> {
    const summaries: Record<string, BranchSummary> = {};
    for (const pr of prs) {
        if (pullRequestState(pr) !== 'OPEN' || summaries[pr.head.ref]) continue;
        const involved = [...(pr.requested_reviewers ?? []), ...(pr.assignees ?? [])].some(user => sameUser(user, viewer));
        summaries[pr.head.ref] = {
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            headSha: pr.head.sha,
            isDraft: isDraft(pr),
            reviewDecision: null,
            checks: states.get(pr.head.sha) ?? null,
            viewerRole: !viewer ? undefined : sameUser(pr.user, viewer) ? 'author' : involved ? 'involved' : undefined
        };
    }
    return summaries;
}
