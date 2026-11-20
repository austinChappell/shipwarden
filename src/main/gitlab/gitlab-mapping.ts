import { myPullRequestReasons, type MyPullRequestItem, type ReviewRequestItem } from '@shared/dashboard';
import type {
    BranchSummary,
    CheckRun,
    GitHubLabel,
    GitHubUser,
    IssueComment,
    JobProgress,
    MergeMethod,
    MergedPullRequest,
    PullRequest,
    PullRequestCommit,
    PullRequestFile,
    PullRequestState,
    PullRequestSummary,
    ReviewDecision,
    Review,
    ReviewComment,
    ReviewThread
} from '@shared/github';
import {
    encodeGitLabId,
    GITLAB_APPROVED_EVENTS,
    GITLAB_REVIEW_EVENTS,
    gitlabMergeRequestWebUrl,
    gitlabRepoRef,
    gitlabRepoWebUrl,
    jobStatusToCheck,
    patchLineCounts,
    type GitLabRepoRef
} from '@shared/gitlab';
import type { WorkflowRun } from '@shared/pipelines';
import { reviewStatusOf, uniqueLogins, type CheckSummary, type OpenPullRequest, type ReviewStatus } from '@shared/review-queue';

// The raw shapes of the GitLab REST API v4. Only the fields that ShipWarden reads are here.
// See https://docs.gitlab.com/api/merge_requests/ and https://docs.gitlab.com/api/discussions/

export interface GlUser {
    id: number;
    username: string;
    name?: string;
    avatar_url?: string | null;
    web_url?: string;
}

export interface GlProject {
    id: number;
    path_with_namespace: string;
    default_branch?: string | null;
    web_url?: string;
    last_activity_at?: string;
    archived?: boolean;
    /** "never", "always", "default_on" or "default_off". */
    squash_option?: string;
    /** "merge", "rebase_merge" or "ff". */
    merge_method?: string;
}

export interface GlLabel {
    name: string;
    color?: string;
    description?: string | null;
}

export interface GlPipeline {
    id: number;
    iid?: number;
    project_id?: number;
    sha: string;
    ref: string;
    status: string;
    source?: string;
    name?: string | null;
    created_at: string;
    updated_at?: string;
    started_at?: string | null;
    finished_at?: string | null;
    web_url: string;
    user?: GlUser | null;
}

export interface GlMergeRequest {
    id: number;
    iid: number;
    project_id: number;
    title: string;
    description?: string | null;
    state: 'opened' | 'closed' | 'merged' | 'locked' | string;
    draft?: boolean;
    work_in_progress?: boolean;
    author: GlUser;
    assignees?: GlUser[];
    reviewers?: GlUser[];
    /** Strings, or objects with "with_labels_details=true". */
    labels?: (string | GlLabel)[];
    source_branch: string;
    target_branch: string;
    source_project_id?: number;
    target_project_id?: number;
    sha?: string | null;
    created_at: string;
    updated_at: string;
    merged_at?: string | null;
    closed_at?: string | null;
    user_notes_count?: number;
    /** GitLab 15.6 and later. See https://docs.gitlab.com/api/merge_requests/#merge-status */
    detailed_merge_status?: string;
    /** The older merge status: "can_be_merged", "cannot_be_merged", "unchecked" or "checking". */
    merge_status?: string;
    has_conflicts?: boolean;
    merge_when_pipeline_succeeds?: boolean;
    merge_user?: GlUser | null;
    squash?: boolean;
    diff_refs?: { base_sha: string; head_sha: string; start_sha: string } | null;
    /** The number of changed files as text. It can be "1000+". */
    changes_count?: string | null;
    web_url: string;
    references?: { short?: string; full?: string };
    /** Only the single merge request has it. */
    user?: { can_merge?: boolean };
    /** Only the single merge request has it. */
    head_pipeline?: GlPipeline | null;
}

export interface GlApprovals {
    approved?: boolean;
    approvals_required?: number;
    approvals_left?: number;
    approved_by?: { user: GlUser }[];
    user_has_approved?: boolean;
    user_can_approve?: boolean;
}

export interface GlPosition {
    base_sha: string;
    start_sha: string;
    head_sha: string;
    old_path: string;
    new_path: string;
    position_type: 'text' | 'image' | 'file' | string;
    old_line: number | null;
    new_line: number | null;
    line_range?: {
        start?: { old_line?: number | null; new_line?: number | null };
        end?: { old_line?: number | null; new_line?: number | null };
    } | null;
}

export interface GlNote {
    id: number;
    /** "DiffNote" for a note on a diff line, "DiscussionNote" for a threaded note, null for a single note. */
    type: string | null;
    body: string;
    author: GlUser;
    created_at: string;
    system: boolean;
    resolvable?: boolean;
    resolved?: boolean;
    position?: GlPosition | null;
}

export interface GlDiscussion {
    id: string;
    individual_note: boolean;
    notes: GlNote[];
}

export interface GlCommit {
    id: string;
    short_id?: string;
    title: string;
    message?: string;
    author_name?: string;
    authored_date?: string;
    committed_date?: string;
    web_url?: string;
    parent_ids?: string[];
}

export interface GlDiff {
    old_path: string;
    new_path: string;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
    diff: string;
    too_large?: boolean;
    collapsed?: boolean;
}

export interface GlJob {
    id: number;
    name: string;
    stage: string;
    status: string;
    allow_failure?: boolean;
    created_at?: string;
    started_at?: string | null;
    finished_at?: string | null;
    web_url: string;
    ref?: string;
    pipeline: { id: number; sha?: string; ref?: string; status?: string };
    user?: GlUser | null;
    retried?: boolean;
}

/** A user for the UI. The login is the GitLab username. */
export function userOf(user: GlUser | null | undefined): GitHubUser | null {
    if (!user) return null;
    return { login: user.username, ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}), ...(user.name ? { name: user.name } : {}) };
}

export function mergeRequestState(state: string): PullRequestState {
    if (state === 'merged') return 'MERGED';
    if (state === 'closed' || state === 'locked') return 'CLOSED';
    return 'OPEN';
}

/** True for a draft. Older servers have only `work_in_progress`. */
export function isDraft(mr: Pick<GlMergeRequest, 'draft' | 'work_in_progress'>): boolean {
    return mr.draft ?? mr.work_in_progress ?? false;
}

/** The merge states that block a merge until a person or a pipeline acts. */
const BLOCKED_STATUSES = new Set([
    'not_approved',
    'ci_must_pass',
    'ci_still_running',
    'discussions_not_resolved',
    'blocked_status',
    'requested_changes',
    'jira_association_missing',
    'external_status_checks',
    'merge_request_blocked',
    'security_policy_violations',
    'locked_paths',
    'locked_lfs_files',
    'title_regex'
]);

/**
 * The merge state of a merge request, in the words of GitHub. `myPullRequestReasons` and the merge button read them.
 * See https://docs.gitlab.com/api/merge_requests/#merge-status
 */
export function mergeStateOf(mr: Pick<GlMergeRequest, 'detailed_merge_status' | 'merge_status' | 'has_conflicts'>): {
    mergeable: string;
    mergeStateStatus: string;
} {
    const status =
        mr.detailed_merge_status ?? (mr.merge_status === 'can_be_merged' ? 'mergeable' : mr.merge_status === 'cannot_be_merged' ? 'conflict' : 'checking');
    if (mr.has_conflicts || status === 'conflict' || status === 'broken_status') return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    if (status === 'checking' || status === 'unchecked' || status === 'approvals_syncing' || status === 'preparing') {
        return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
    }
    if (status === 'mergeable') return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
    if (status === 'need_rebase') return { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' };
    if (status === 'draft_status') return { mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' };
    if (BLOCKED_STATUSES.has(status)) return { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
    return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
}

/**
 * The review decision of a merge request from its approvals.
 * - "approved": at least one approval and no more approvals required.
 * - "review required": approvals are required, or the merge request has reviewers and no approval.
 * - null: no approval rules and no reviewers.
 * GitLab has no "request changes" in the free tier API, so the decision is never "changes requested".
 */
export function reviewDecisionOf(approvals: GlApprovals | undefined, reviewerCount: number): ReviewDecision {
    const approvedBy = approvals?.approved_by?.length ?? 0;
    const left = approvals?.approvals_left ?? 0;
    if (approvedBy > 0 && left <= 0) return 'APPROVED';
    if (left > 0 || reviewerCount > 0) return 'REVIEW_REQUIRED';
    return null;
}

/** The merge methods of a project. A project that always squashes accepts only "squash". */
export function mergeMethodsOf(project: Pick<GlProject, 'squash_option'> | undefined): { allowed: MergeMethod[]; preferred: MergeMethod } {
    switch (project?.squash_option) {
        case 'never':
            return { allowed: ['merge'], preferred: 'merge' };
        case 'always':
            return { allowed: ['squash'], preferred: 'squash' };
        case 'default_on':
            return { allowed: ['merge', 'squash'], preferred: 'squash' };
        default:
            return { allowed: ['merge', 'squash'], preferred: 'merge' };
    }
}

/** A label for the UI. GitLab colors are "#rrggbb". A label without details is gray. */
export function labelOf(label: string | GlLabel): GitHubLabel {
    if (typeof label === 'string') return { name: label, color: '8b949e' };
    return { name: label.name, color: (label.color ?? '#8b949e').replace(/^#/, ''), description: label.description ?? null };
}

/**
 * Splits the discussions of a merge request: discussions on a diff line become review threads, and the other notes
 * become comments of the conversation. System notes (for example "added 1 commit") stay out.
 * A thread whose position is on an older commit than `headSha` is outdated.
 * Each comment of a thread has the ID of the first note as `databaseId`. A reply uses it to find the discussion.
 */
export function mapDiscussions(
    repo: GitLabRepoRef,
    iid: number,
    discussions: readonly GlDiscussion[],
    headSha: string | undefined,
    webUrl: string
): { threads: ReviewThread[]; issueComments: IssueComment[] } {
    const threads: ReviewThread[] = [];
    const issueComments: IssueComment[] = [];
    for (const discussion of discussions) {
        const notes = discussion.notes.filter(note => !note.system && note.body.trim() !== '');
        if (notes.length === 0) continue;
        const first = notes[0];
        const position = first.position;
        if (!position || first.type !== 'DiffNote' || position.position_type !== 'text') {
            issueComments.push(
                ...notes.map(note => ({
                    id: `gitlab-note:${note.id}`,
                    author: userOf(note.author),
                    body: note.body,
                    createdAt: note.created_at,
                    url: `${webUrl}#note_${note.id}`
                }))
            );
            continue;
        }
        const comments: ReviewComment[] = notes.map(note => ({
            id: `gitlab-note:${note.id}`,
            databaseId: first.id,
            author: userOf(note.author),
            body: note.body,
            createdAt: note.created_at,
            url: `${webUrl}#note_${note.id}`
        }));
        const side = position.new_line != null ? 'RIGHT' : 'LEFT';
        const line = position.new_line ?? position.old_line ?? null;
        const range = position.line_range;
        const startLine = range?.start ? ((side === 'RIGHT' ? range.start.new_line : range.start.old_line) ?? null) : null;
        const outdated = !!headSha && !!position.head_sha && position.head_sha !== headSha;
        threads.push({
            id: encodeGitLabId(repo, iid, discussion.id),
            path: position.new_path || position.old_path,
            line: outdated ? null : line,
            originalLine: line,
            startLine: outdated || startLine === line ? null : startLine,
            originalStartLine: startLine === line ? null : startLine,
            side,
            isResolved: notes.some(note => note.resolvable) ? notes.every(note => !note.resolvable || note.resolved) : false,
            isOutdated: outdated,
            comments
        });
    }
    issueComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { threads, issueComments: issueComments.slice(-50) };
}

/** Converts the commits of a merge request (newest first from GitLab) to the UI model (oldest first). */
export function mapCommits(repo: GitLabRepoRef, commits: readonly GlCommit[]): PullRequestCommit[] {
    return commits
        .slice(0, 100)
        .reverse()
        .map(commit => ({
            oid: commit.id,
            abbreviatedOid: commit.short_id ?? commit.id.slice(0, 8),
            messageHeadline: commit.title,
            committedDate: commit.committed_date ?? commit.authored_date ?? '',
            url: commit.web_url ?? `${gitlabRepoWebUrl(repo)}/-/commit/${commit.id}`,
            author: commit.author_name ?? null
        }));
}

/** Converts the diffs of a merge request or a commit to the files of the UI, with the patch and the line counts. */
export function mapDiffs(diffs: readonly GlDiff[]): PullRequestFile[] {
    return diffs.map(diff => {
        const status = diff.new_file ? 'added' : diff.deleted_file ? 'removed' : diff.renamed_file ? 'renamed' : 'modified';
        const patch = diff.diff && !diff.too_large ? diff.diff : undefined;
        return {
            path: diff.deleted_file ? diff.old_path : diff.new_path,
            ...(diff.renamed_file ? { previousPath: diff.old_path } : {}),
            status,
            ...patchLineCounts(patch),
            ...(patch ? { patch } : {})
        };
    });
}

export interface MergeRequestParts {
    repo: GitLabRepoRef;
    mr: GlMergeRequest;
    project?: GlProject;
    approvals?: GlApprovals;
    discussions: readonly GlDiscussion[];
    commits: readonly GlCommit[];
    /** The jobs of the head pipeline, for the check count. */
    checkCount?: number;
    /** The ID of the user of the token. */
    viewerId?: number;
}

/** Converts a merge request with its discussions, approvals and commits to the UI model. */
export function mapMergeRequest(parts: MergeRequestParts): PullRequest {
    const { repo, mr, viewerId, approvals } = parts;
    const url = mr.web_url || gitlabMergeRequestWebUrl(repo, mr.iid);
    const headSha = mr.diff_refs?.head_sha ?? mr.sha ?? '';
    const { threads, issueComments } = mapDiscussions(repo, mr.iid, parts.discussions, headSha, url);
    const approvedBy = (approvals?.approved_by ?? []).map(item => item.user);
    const reviewers = mr.reviewers ?? [];
    const reviews: Review[] = approvedBy.map(user => ({
        id: `${encodeGitLabId(repo, mr.iid)}#approval:${user.id}`,
        author: userOf(user),
        state: 'APPROVED',
        body: '',
        submittedAt: null,
        url
    }));
    const approvedIds = new Set(approvedBy.map(user => user.id));
    const state = mergeRequestState(mr.state);
    const methods = mergeMethodsOf(parts.project);
    const viewerApproved = approvals?.user_has_approved ?? (viewerId !== undefined && approvedIds.has(viewerId));
    const autoMerge = !!mr.merge_when_pipeline_succeeds;
    return {
        id: encodeGitLabId(repo, mr.iid),
        number: mr.iid,
        title: mr.title,
        body: mr.description ?? '',
        url,
        state,
        isDraft: isDraft(mr),
        ...mergeStateOf(mr),
        reviewDecision: reviewDecisionOf(approvals, reviewers.length),
        author: userOf(mr.author),
        baseRefName: mr.target_branch,
        headRefName: mr.source_branch,
        isCrossRepository: mr.source_project_id !== undefined && mr.target_project_id !== undefined && mr.source_project_id !== mr.target_project_id,
        baseRefOid: mr.diff_refs?.base_sha ?? '',
        headRefOid: headSha,
        // The merge request API gives no line counts. The Files tab counts them from the diffs.
        additions: 0,
        deletions: 0,
        changedFiles: Number.parseInt(mr.changes_count ?? '0', 10) || 0,
        createdAt: mr.created_at,
        viewerDidAuthor: viewerId !== undefined && mr.author.id === viewerId,
        reviews,
        issueComments,
        threads,
        allowedMergeMethods: methods.allowed,
        defaultMergeMethod: mr.squash ? 'squash' : methods.preferred,
        commits: mapCommits(repo, parts.commits),
        commitCount: parts.commits.length,
        checkCount: parts.checkCount ?? 0,
        assignees: (mr.assignees ?? []).map(userOf).filter((user): user is GitHubUser => !!user),
        reviewRequests: reviewers.filter(user => !approvedIds.has(user.id)).map(user => ({ kind: 'user' as const, login: user.username })),
        viewerIsRequested: viewerId === undefined ? undefined : !isDraft(mr) && reviewers.some(user => user.id === viewerId) && !approvedIds.has(viewerId),
        labels: (mr.labels ?? []).map(labelOf),
        viewerCanUpdate: true,
        viewerCanManage: true,
        autoMerge: autoMerge ? { method: mr.squash ? 'squash' : 'merge', enabledBy: mr.merge_user?.username ?? null } : null,
        viewerCanEnableAutoMerge: state === 'OPEN' && !autoMerge && mr.user?.can_merge !== false,
        viewerCanDisableAutoMerge: autoMerge,
        viewerCanMerge: mr.user?.can_merge ?? true,
        host: 'gitlab',
        reviewEvents: viewerApproved ? GITLAB_APPROVED_EVENTS : GITLAB_REVIEW_EVENTS,
        // GitLab has award emoji on notes. ShipWarden does not show them yet.
        reactionKinds: []
    };
}

/** Converts a job to a check of the UI. A job has a log and can run again, like a GitHub Actions job. */
export function jobToCheck(job: GlJob): CheckRun {
    const mapped = jobStatusToCheck(job.status, job.allow_failure);
    return {
        id: job.id,
        name: job.stage ? `${job.stage} › ${job.name}` : job.name,
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: job.started_at ?? null,
        completedAt: mapped.status === 'completed' ? (job.finished_at ?? null) : null,
        url: job.web_url,
        runId: job.pipeline.id,
        isActions: true
    };
}

/** Keeps the newest try of each job. A retried job has a newer job with the same name and stage. */
export function latestJobs(jobs: readonly GlJob[]): GlJob[] {
    const newest = new Map<string, GlJob>();
    for (const job of jobs) {
        const key = `${job.stage}\u0000${job.name}`;
        const current = newest.get(key);
        if (!current || job.id > current.id) newest.set(key, job);
    }
    return [...newest.values()];
}

/** The progress of a job for the log view. GitLab has no steps API, so the job has no steps. */
export function jobProgressOf(job: GlJob): JobProgress {
    const mapped = jobStatusToCheck(job.status, job.allow_failure);
    return {
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: job.started_at ?? null,
        completedAt: mapped.status === 'completed' ? (job.finished_at ?? null) : null,
        steps: []
    };
}

/** The ID of the one "workflow" of a GitLab project. All pipelines of a project come from its .gitlab-ci.yml. */
export const GITLAB_PIPELINE_WORKFLOW_ID = 1;

/** Converts a pipeline to a run of the Pipelines view. All pipelines of a project are one workflow. */
export function pipelineToRun(pipeline: GlPipeline): WorkflowRun {
    const mapped = jobStatusToCheck(pipeline.status);
    return {
        id: pipeline.id,
        title: pipeline.name || `Pipeline #${pipeline.iid ?? pipeline.id} on ${pipeline.ref}`,
        workflowId: GITLAB_PIPELINE_WORKFLOW_ID,
        workflowName: 'Pipeline',
        runNumber: pipeline.iid ?? pipeline.id,
        branch: pipeline.ref.startsWith('refs/merge-requests/') ? null : pipeline.ref,
        event: pipeline.source ?? 'push',
        status: mapped.status,
        conclusion: mapped.conclusion,
        actor: pipeline.user?.username ?? null,
        createdAt: pipeline.created_at,
        updatedAt: pipeline.updated_at ?? pipeline.created_at,
        startedAt: pipeline.started_at ?? null,
        url: pipeline.web_url,
        headSha: pipeline.sha
    };
}

/** The combined CI state of a pipeline for the lists: SUCCESS, FAILURE or PENDING. Null without a pipeline. */
export function pipelineState(pipeline: Pick<GlPipeline, 'status'> | undefined | null): string | null {
    if (!pipeline) return null;
    const mapped = jobStatusToCheck(pipeline.status);
    if (mapped.status !== 'completed') return 'PENDING';
    return mapped.conclusion === 'failure' || mapped.conclusion === 'cancelled' ? 'FAILURE' : 'SUCCESS';
}

/** The check summary of a pipeline for the review queue. GitLab gives one status for a pipeline, so the total is 1. */
export function pipelineCheckSummary(pipeline: Pick<GlPipeline, 'status'> | undefined): CheckSummary {
    const state = pipelineState(pipeline);
    if (!state) return { state: null, failing: 0, pending: 0, total: 0 };
    return { state, failing: state === 'FAILURE' ? 1 : 0, pending: state === 'PENDING' ? 1 : 0, total: 1 };
}

/** Returns the newest pipeline of each commit. The list from GitLab is newest first, but the ID decides. */
export function pipelinesBySha(pipelines: readonly GlPipeline[]): Map<string, GlPipeline> {
    const bySha = new Map<string, GlPipeline>();
    for (const pipeline of pipelines) {
        const current = bySha.get(pipeline.sha);
        if (!current || pipeline.id > current.id) bySha.set(pipeline.sha, pipeline);
    }
    return bySha;
}

/** Returns the reviewers and the review status of a merge request from the list API, which has no approvals. */
function peopleOf(mr: GlMergeRequest): { assignees: string[]; reviewers: string[]; reviewStatus: ReviewStatus } {
    const reviewers = mr.reviewers ?? [];
    return {
        assignees: (mr.assignees ?? []).map(user => user.username),
        reviewers: uniqueLogins([reviewers.filter(user => user.id !== mr.author.id).map(user => user.username)]),
        reviewStatus: reviewStatusOf(reviewers.length > 0 ? 'REVIEW_REQUIRED' : null)
    };
}

/** True when the viewer is a reviewer of an open merge request and did not write it. A draft asks for no review. */
export function viewerIsReviewer(mr: GlMergeRequest, viewerId: number | undefined): boolean {
    return viewerId !== undefined && !isDraft(mr) && mr.author.id !== viewerId && (mr.reviewers ?? []).some(user => user.id === viewerId);
}

/**
 * Converts an open merge request to the model of the review queue. The list API has no approvals,
 * so the review decision and the review of the viewer are not known.
 */
export function openMergeRequestOf(repo: GitLabRepoRef, mr: GlMergeRequest, pipelines: Map<string, GlPipeline>, viewerId: number | undefined): OpenPullRequest {
    const checks = pipelineCheckSummary(mr.sha ? pipelines.get(mr.sha) : undefined);
    const viewerDidAuthor = viewerId !== undefined && mr.author.id === viewerId;
    return {
        id: encodeGitLabId(repo, mr.iid),
        number: mr.iid,
        title: mr.title,
        url: mr.web_url,
        author: mr.author.username,
        isDraft: isDraft(mr),
        createdAt: mr.created_at,
        updatedAt: mr.updated_at,
        headRefName: mr.source_branch,
        baseRefName: mr.target_branch,
        headRefOid: mr.sha ?? '',
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        comments: mr.user_notes_count ?? 0,
        viewerDidAuthor,
        reviewRequested: viewerIsReviewer(mr, viewerId),
        reviewDecision: null,
        checks,
        actions: viewerDidAuthor ? myPullRequestReasons({ isDraft: isDraft(mr), reviewDecision: null, ...mergeStateOf(mr), checks: checks.state }) : [],
        ...peopleOf(mr)
    };
}

/** Converts a merge request to a row of the pull request list. A merge request that is not open has no CI state. */
export function mergeRequestSummaryOf(mr: GlMergeRequest, pipelines: Map<string, GlPipeline>, viewerId: number | undefined): PullRequestSummary {
    const state = mergeRequestState(mr.state);
    return {
        number: mr.iid,
        title: mr.title,
        author: mr.author.username,
        isDraft: isDraft(mr),
        state,
        updatedAt: mr.updated_at,
        reviewDecision: null,
        checks: state === 'OPEN' && mr.sha ? pipelineState(pipelines.get(mr.sha)) : null,
        comments: mr.user_notes_count ?? 0,
        additions: 0,
        deletions: 0,
        viewerDidAuthor: viewerId !== undefined && mr.author.id === viewerId,
        ...peopleOf(mr)
    };
}

/**
 * Returns the project of a merge request from a global list (for example the Dashboard), from "references.full"
 * ("group/sub/project!12"). Returns undefined when the list gives no reference.
 */
export function repoOfMergeRequest(host: string, mr: GlMergeRequest): GitLabRepoRef | undefined {
    const full = mr.references?.full;
    const path = full ? full.replace(/![0-9]+$/, '') : undefined;
    if (!path) return undefined;
    const slash = path.lastIndexOf('/');
    if (slash <= 0) return undefined;
    return { host, namespace: path.slice(0, slash), project: path.slice(slash + 1) };
}

/** Converts a merge request that asks the viewer for a review to an item of the Dashboard. */
export function reviewRequestItemOf(repo: GitLabRepoRef, mr: GlMergeRequest): ReviewRequestItem {
    return {
        repo: gitlabRepoRef(repo),
        number: mr.iid,
        title: mr.title,
        url: mr.web_url,
        author: mr.author.username,
        updatedAt: mr.updated_at,
        createdAt: mr.created_at
    };
}

/**
 * Converts a merge request of the viewer to an item of the Dashboard. Returns undefined when the viewer has nothing
 * to do on it. The list API has no pipeline, so the item shows only conflicts and "ready to merge".
 */
export function myMergeRequestItemOf(repo: GitLabRepoRef, mr: GlMergeRequest): MyPullRequestItem | undefined {
    const merge = mergeStateOf(mr);
    const reasons = myPullRequestReasons({
        isDraft: isDraft(mr),
        reviewDecision: merge.mergeStateStatus === 'CLEAN' ? 'APPROVED' : null,
        ...merge,
        checks: null
    });
    if (reasons.length === 0) return undefined;
    return {
        repo: gitlabRepoRef(repo),
        number: mr.iid,
        title: mr.title,
        url: mr.web_url,
        updatedAt: mr.updated_at,
        createdAt: mr.created_at,
        reasons,
        headSha: mr.sha ?? undefined,
        mergeMethod: mr.squash ? 'squash' : undefined
    };
}

/** Returns the newest merged merge request of each source branch. A merge request without a head commit is left out. */
export function mergedBranches(mrs: readonly GlMergeRequest[]): Record<string, MergedPullRequest> {
    const merged: Record<string, MergedPullRequest> = {};
    const newest = [...mrs].sort((a, b) => (b.merged_at ?? b.updated_at).localeCompare(a.merged_at ?? a.updated_at));
    for (const mr of newest) {
        if (mr.state !== 'merged' || !mr.sha) continue;
        if (!merged[mr.source_branch]) merged[mr.source_branch] = { number: mr.iid, title: mr.title, headSha: mr.sha };
    }
    return merged;
}

/**
 * Returns the open merge requests by source branch, with the state of the newest pipeline of their head commit.
 * The viewer ID sets the viewer role: "author" for the author, "involved" for a reviewer or an assignee.
 */
export function branchSummaries(mrs: readonly GlMergeRequest[], pipelines: Map<string, GlPipeline>, viewerId?: number): Record<string, BranchSummary> {
    const summaries: Record<string, BranchSummary> = {};
    for (const mr of mrs) {
        if (mr.state !== 'opened' || summaries[mr.source_branch]) continue;
        const involved = [...(mr.reviewers ?? []), ...(mr.assignees ?? [])].some(user => user.id === viewerId);
        summaries[mr.source_branch] = {
            number: mr.iid,
            title: mr.title,
            url: mr.web_url,
            headSha: mr.sha ?? undefined,
            isDraft: isDraft(mr),
            reviewDecision: null,
            checks: mr.sha ? pipelineState(pipelines.get(mr.sha)) : null,
            viewerRole: viewerId === undefined ? undefined : mr.author.id === viewerId ? 'author' : involved ? 'involved' : undefined
        };
    }
    return summaries;
}
