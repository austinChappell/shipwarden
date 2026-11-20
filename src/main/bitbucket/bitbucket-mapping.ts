import { myPullRequestReasons, type MyPullRequestItem } from '@shared/dashboard';
import {
    BITBUCKET_APPROVED_EVENTS,
    BITBUCKET_REVIEW_EVENTS,
    bitbucketPipelinesWebUrl,
    bitbucketPullRequestWebUrl,
    bitbucketRepoRef,
    bitbucketRepoWebUrl,
    commitStatusToCheck,
    encodeBitbucketId,
    mergeMethodsOfStrategies,
    pipelineStateToCheck,
    splitUnifiedDiff,
    type BitbucketRepoRef
} from '@shared/bitbucket';
import type {
    BranchSummary,
    CheckRun,
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
import type { WorkflowRun } from '@shared/pipelines';
import { reviewStatusOf, uniqueLogins, type CheckSummary, type OpenPullRequest, type ReviewStatus } from '@shared/review-queue';

// The raw shapes of the Bitbucket Cloud REST API 2.0. Only the fields that ShipWarden reads are here.
// See https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/

export interface BbUser {
    uuid?: string;
    account_id?: string;
    display_name?: string;
    nickname?: string;
    links?: { avatar?: { href?: string } };
}

export interface BbRepository {
    uuid?: string;
    full_name: string;
    slug?: string;
    name?: string;
    updated_on?: string;
    mainbranch?: { name?: string } | null;
    links?: { html?: { href?: string } };
}

export interface BbBranchRef {
    branch?: { name?: string };
    commit?: { hash?: string } | null;
    repository?: { full_name?: string; uuid?: string } | null;
}

export interface BbParticipant {
    user: BbUser;
    role?: 'PARTICIPANT' | 'REVIEWER' | string;
    approved?: boolean;
    /** "approved", "changes_requested", or null. */
    state?: string | null;
    participated_on?: string | null;
}

export interface BbPullRequest {
    id: number;
    title: string;
    description?: string | null;
    summary?: { raw?: string | null } | null;
    /** OPEN, MERGED, DECLINED, or SUPERSEDED. */
    state: string;
    draft?: boolean;
    author: BbUser;
    source: BbBranchRef;
    destination: BbBranchRef;
    merge_commit?: { hash?: string } | null;
    comment_count?: number;
    task_count?: number;
    close_source_branch?: boolean;
    reviewers?: BbUser[];
    participants?: BbParticipant[];
    created_on: string;
    updated_on: string;
    links?: { html?: { href?: string } };
}

export interface BbInline {
    path: string;
    /** The line in the old file. Null for a comment on an added line. */
    from?: number | null;
    /** The line in the new file. Null for a comment on a removed line. */
    to?: number | null;
    start_from?: number | null;
    start_to?: number | null;
    outdated?: boolean;
}

export interface BbComment {
    id: number;
    content?: { raw?: string | null } | null;
    user?: BbUser | null;
    created_on: string;
    updated_on?: string;
    deleted?: boolean;
    pending?: boolean;
    inline?: BbInline | null;
    parent?: { id: number } | null;
    /** Set on the first comment of a thread when a user resolved the thread. */
    resolution?: { type?: string; user?: BbUser; created_on?: string } | null;
    links?: { html?: { href?: string } };
}

export interface BbCommit {
    hash: string;
    message?: string;
    date?: string;
    author?: { raw?: string; user?: BbUser | null };
    parents?: { hash: string }[];
    links?: { html?: { href?: string } };
}

export interface BbDiffStat {
    /** added, removed, modified, renamed, or a conflict state such as "merge conflict". */
    status: string;
    lines_added?: number;
    lines_removed?: number;
    old?: { path?: string } | null;
    new?: { path?: string } | null;
}

export interface BbCommitStatus {
    key: string;
    name?: string | null;
    /** SUCCESSFUL, FAILED, INPROGRESS, or STOPPED. */
    state: string;
    url?: string | null;
    description?: string | null;
    created_on?: string;
    updated_on?: string;
}

export interface BbPipelineTarget {
    type?: string;
    ref_type?: string;
    ref_name?: string;
    commit?: { hash?: string } | null;
    selector?: { type?: string; pattern?: string } | null;
    source?: string;
    destination?: string;
    destination_commit?: { hash?: string } | null;
    pullrequest?: { id?: number; title?: string } | null;
}

export interface BbPipeline {
    uuid: string;
    build_number: number;
    state?: { name?: string; result?: { name?: string } | null; stage?: { name?: string } | null } | null;
    target?: BbPipelineTarget | null;
    trigger?: { name?: string } | null;
    creator?: BbUser | null;
    created_on: string;
    completed_on?: string | null;
}

export interface BbStep {
    uuid: string;
    name?: string | null;
    state?: { name?: string; result?: { name?: string } | null } | null;
    started_on?: string | null;
    completed_on?: string | null;
}

export interface BbBranch {
    name: string;
    target?: { hash?: string };
    merge_strategies?: string[];
    default_merge_strategy?: string;
}

/**
 * Gives a stable number to each text key, for the numeric IDs of the UI (check IDs, job IDs, and run IDs).
 * Bitbucket gives UUIDs to pipelines and steps. The numbers stay the same while the app runs.
 */
export class NumericIds {
    private readonly numbers = new Map<string, number>();
    private readonly keys = new Map<number, string>();

    idOf(key: string): number {
        let id = this.numbers.get(key);
        if (id === undefined) {
            id = this.numbers.size + 1;
            this.numbers.set(key, id);
            this.keys.set(id, key);
        }
        return id;
    }

    keyOf(id: number): string | undefined {
        return this.keys.get(id);
    }
}

/** The text key of a pipeline for `NumericIds`. */
export function pipelineKey(pipelineUuid: string): string {
    return `pipeline:${pipelineUuid}`;
}

/** The text key of a step for `NumericIds`. */
export function stepKey(pipelineUuid: string, stepUuid: string): string {
    return `step:${pipelineUuid}:${stepUuid}`;
}

/** The name of a user for the UI. Bitbucket has no public usernames. The nickname is the closest value. */
export function loginOf(user: BbUser | null | undefined): string {
    return user?.nickname || user?.display_name || 'unknown';
}

/** A user for the UI. The login is the nickname of the user. */
export function userOf(user: BbUser | null | undefined): GitHubUser | null {
    if (!user) return null;
    const avatar = user.links?.avatar?.href;
    return { login: loginOf(user), ...(avatar ? { avatarUrl: avatar } : {}), ...(user.display_name ? { name: user.display_name } : {}) };
}

/** True when two users are the same user. The UUID decides, else the account ID. */
export function sameUser(a: BbUser | null | undefined, b: BbUser | null | undefined): boolean {
    if (!a || !b) return false;
    if (a.uuid && b.uuid) return a.uuid === b.uuid;
    return !!a.account_id && a.account_id === b.account_id;
}

export function pullRequestState(state: string): PullRequestState {
    if (state === 'MERGED') return 'MERGED';
    if (state === 'DECLINED' || state === 'SUPERSEDED') return 'CLOSED';
    return 'OPEN';
}

/** The diffstat states that tell that the merge has a conflict. */
const CONFLICT_STATUSES = new Set(['merge conflict', 'local deleted', 'remote deleted', 'local and remote deleted']);

/** True when a file of the diffstat has a merge conflict. */
export function hasConflicts(diffstat: readonly BbDiffStat[]): boolean {
    return diffstat.some(file => CONFLICT_STATUSES.has(file.status));
}

/**
 * The merge state of a pull request, in the words of GitHub. Bitbucket gives no merge state. The diffstat shows the
 * conflicts. Without a diffstat, the state is not known. A request for changes blocks the merge.
 */
export function mergeStateOf(
    pr: Pick<BbPullRequest, 'draft' | 'state'>,
    diffstat: readonly BbDiffStat[] | undefined,
    decision: ReviewDecision
): { mergeable: string; mergeStateStatus: string } {
    if (!diffstat) return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
    if (hasConflicts(diffstat)) return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    if (pr.draft) return { mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' };
    if (decision === 'CHANGES_REQUESTED') return { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
    return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
}

/** True when a participant approved. */
function approved(participant: BbParticipant): boolean {
    return participant.approved === true || participant.state === 'approved';
}

/** True when a participant requested changes. */
function requestedChanges(participant: BbParticipant): boolean {
    return participant.state === 'changes_requested';
}

/**
 * The review decision of a pull request from its participants.
 * - "changes requested": a participant requested changes.
 * - "approved": a participant approved.
 * - "review required": the pull request has reviewers and no approval.
 * - null: no reviewers and no approval.
 * Bitbucket can need more approvals (a branch restriction). The API of the pull request does not give that number.
 */
export function reviewDecisionOf(participants: readonly BbParticipant[] | undefined, reviewerCount: number): ReviewDecision {
    const list = participants ?? [];
    if (list.some(requestedChanges)) return 'CHANGES_REQUESTED';
    if (list.some(approved)) return 'APPROVED';
    return reviewerCount > 0 ? 'REVIEW_REQUIRED' : null;
}

/** The description of a pull request. Older answers have only `summary.raw`. */
function descriptionOf(pr: Pick<BbPullRequest, 'description' | 'summary'>): string {
    return pr.description ?? pr.summary?.raw ?? '';
}

/** The web page of a pull request. */
function webUrlOf(repo: BitbucketRepoRef, pr: Pick<BbPullRequest, 'id' | 'links'>): string {
    return pr.links?.html?.href || bitbucketPullRequestWebUrl(repo, pr.id);
}

/** The text of a comment. */
function bodyOf(comment: BbComment): string {
    return comment.content?.raw ?? '';
}

/**
 * Splits the comments of a pull request into threads. The comments with an inline position become review threads, and
 * the other comments become comments of the conversation. Deleted comments stay out.
 * A reply has a parent. A reply to a reply belongs to the thread of the first comment.
 * Each comment of a thread has the ID of the first comment as `databaseId`. A reply uses it as the parent.
 */
export function mapComments(
    repo: BitbucketRepoRef,
    id: number,
    comments: readonly BbComment[],
    webUrl: string
): { threads: ReviewThread[]; issueComments: IssueComment[] } {
    const byId = new Map(comments.map(comment => [comment.id, comment]));
    const rootOf = (comment: BbComment): BbComment => {
        let current = comment;
        const seen = new Set<number>();
        while (current.parent && byId.has(current.parent.id) && !seen.has(current.id)) {
            seen.add(current.id);
            current = byId.get(current.parent.id)!;
        }
        return current;
    };
    const groups = new Map<number, BbComment[]>();
    for (const comment of comments) {
        const root = rootOf(comment);
        const group = groups.get(root.id) ?? [];
        group.push(comment);
        groups.set(root.id, group);
    }
    const threads: ReviewThread[] = [];
    const issueComments: IssueComment[] = [];
    const urlOf = (comment: BbComment) => comment.links?.html?.href || `${webUrl}#comment-${comment.id}`;
    for (const [rootId, group] of groups) {
        const root = byId.get(rootId)!;
        const visible = group
            .filter(comment => !comment.deleted && !comment.pending && bodyOf(comment).trim() !== '')
            .sort((a, b) => a.created_on.localeCompare(b.created_on));
        if (visible.length === 0) continue;
        const inline = root.inline;
        if (!inline?.path) {
            issueComments.push(
                ...visible.map(comment => ({
                    id: `bitbucket-comment:${comment.id}`,
                    author: userOf(comment.user),
                    body: bodyOf(comment),
                    createdAt: comment.created_on,
                    url: urlOf(comment)
                }))
            );
            continue;
        }
        const reviewComments: ReviewComment[] = visible.map(comment => ({
            id: `bitbucket-comment:${comment.id}`,
            databaseId: root.id,
            author: userOf(comment.user),
            body: bodyOf(comment),
            createdAt: comment.created_on,
            url: urlOf(comment)
        }));
        const side = inline.to != null ? 'RIGHT' : 'LEFT';
        const line = inline.to ?? inline.from ?? null;
        const start = (side === 'RIGHT' ? inline.start_to : inline.start_from) ?? null;
        const startLine = start !== null && start !== line ? start : null;
        const outdated = inline.outdated === true;
        threads.push({
            id: encodeBitbucketId(repo, id, root.id),
            path: inline.path,
            line: outdated ? null : line,
            originalLine: line,
            startLine: outdated ? null : startLine,
            originalStartLine: startLine,
            side,
            isResolved: !!root.resolution,
            isOutdated: outdated,
            comments: reviewComments
        });
    }
    issueComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { threads, issueComments: issueComments.slice(-50) };
}

/** Converts the commits of a pull request (newest first from Bitbucket) to the UI model (oldest first). */
export function mapCommits(repo: BitbucketRepoRef, commits: readonly BbCommit[]): PullRequestCommit[] {
    return commits
        .slice(0, 100)
        .reverse()
        .map(commit => ({
            oid: commit.hash,
            abbreviatedOid: commit.hash.slice(0, 7),
            messageHeadline: (commit.message ?? '').split('\n')[0],
            committedDate: commit.date ?? '',
            url: commit.links?.html?.href ?? `${bitbucketRepoWebUrl(repo)}/commits/${commit.hash}`,
            author: commit.author?.user ? loginOf(commit.author.user) : (commit.author?.raw?.replace(/\s*<[^>]*>\s*$/, '') ?? null)
        }));
}

/** The file status of the UI for a diffstat status. A conflict state is "modified". */
function fileStatusOf(status: string): string {
    if (status === 'added' || status === 'removed' || status === 'renamed') return status;
    return 'modified';
}

/**
 * Converts the diffstat and the diff of a pull request or a commit to the files of the UI.
 * The diffstat gives the files and the line counts. The diff gives the "@@" hunks of each file.
 */
export function mapFiles(diffstat: readonly BbDiffStat[], diff: string | undefined): PullRequestFile[] {
    const patches = splitUnifiedDiff(diff ?? '');
    return diffstat.map(entry => {
        const status = fileStatusOf(entry.status);
        const newPath = entry.new?.path;
        const oldPath = entry.old?.path;
        const path = newPath ?? oldPath ?? '';
        const patch = patches.find(item => (newPath ? item.newPath === newPath : item.oldPath === oldPath))?.patch;
        return {
            path,
            ...(status === 'renamed' && oldPath && oldPath !== path ? { previousPath: oldPath } : {}),
            status,
            additions: entry.lines_added ?? 0,
            deletions: entry.lines_removed ?? 0,
            ...(patch ? { patch } : {})
        };
    });
}

export interface PullRequestParts {
    repo: BitbucketRepoRef;
    pr: BbPullRequest;
    comments: readonly BbComment[];
    commits: readonly BbCommit[];
    /** The changed files. Undefined when the diffstat did not load. */
    diffstat?: readonly BbDiffStat[];
    /** The destination branch, for the merge strategies. */
    branch?: BbBranch;
    /** The number of checks of the head commit. */
    checkCount?: number;
    /** The user of the token. */
    viewer?: BbUser;
}

/** Returns the full hash of a short hash from the commits (newest first). Returns the short hash when no commit matches. */
export function fullHash(short: string, commits: readonly BbCommit[]): string {
    if (!short) return '';
    return commits.find(commit => commit.hash.startsWith(short))?.hash ?? short;
}

/** Converts a pull request with its comments, commits, and diffstat to the UI model. */
export function mapPullRequest(parts: PullRequestParts): PullRequest {
    const { repo, pr, viewer, diffstat } = parts;
    const url = webUrlOf(repo, pr);
    const { threads, issueComments } = mapComments(repo, pr.id, parts.comments, url);
    const participants = pr.participants ?? [];
    const reviewers = pr.reviewers ?? [];
    const reviews: Review[] = participants
        .filter(participant => approved(participant) || requestedChanges(participant))
        .map(participant => ({
            id: `${encodeBitbucketId(repo, pr.id)}#participant:${participant.user.uuid ?? participant.user.account_id ?? loginOf(participant.user)}`,
            author: userOf(participant.user),
            state: requestedChanges(participant) ? 'CHANGES_REQUESTED' : 'APPROVED',
            body: '',
            submittedAt: participant.participated_on ?? null,
            url
        }));
    const decided = (user: BbUser) =>
        participants.some(participant => sameUser(participant.user, user) && (approved(participant) || requestedChanges(participant)));
    const decision = reviewDecisionOf(participants, reviewers.length);
    const state = pullRequestState(pr.state);
    const methods = mergeMethodsOfStrategies(parts.branch?.merge_strategies, parts.branch?.default_merge_strategy);
    const viewerApproved = !!viewer && participants.some(participant => sameUser(participant.user, viewer) && approved(participant));
    const isDraft = pr.draft === true;
    return {
        id: encodeBitbucketId(repo, pr.id),
        number: pr.id,
        title: pr.title,
        body: descriptionOf(pr),
        url,
        state,
        isDraft,
        ...mergeStateOf(pr, diffstat, decision),
        reviewDecision: decision,
        author: userOf(pr.author),
        baseRefName: pr.destination.branch?.name ?? '',
        headRefName: pr.source.branch?.name ?? '',
        isCrossRepository:
            !!pr.source.repository?.full_name &&
            !!pr.destination.repository?.full_name &&
            pr.source.repository.full_name.toLowerCase() !== pr.destination.repository.full_name.toLowerCase(),
        // Bitbucket gives short hashes (12 characters) in the pull request. The newest commit gives the full head hash.
        baseRefOid: pr.destination.commit?.hash ?? '',
        headRefOid: fullHash(pr.source.commit?.hash ?? '', parts.commits),
        additions: (diffstat ?? []).reduce((sum, file) => sum + (file.lines_added ?? 0), 0),
        deletions: (diffstat ?? []).reduce((sum, file) => sum + (file.lines_removed ?? 0), 0),
        changedFiles: diffstat?.length ?? 0,
        createdAt: pr.created_on,
        viewerDidAuthor: sameUser(pr.author, viewer),
        reviews,
        issueComments,
        threads,
        allowedMergeMethods: methods.allowed,
        defaultMergeMethod: methods.preferred,
        commits: mapCommits(repo, parts.commits),
        commitCount: parts.commits.length,
        checkCount: parts.checkCount ?? 0,
        assignees: [],
        hasAssignees: false,
        reviewRequests: reviewers.filter(user => !decided(user)).map(user => ({ kind: 'user' as const, login: loginOf(user) })),
        viewerIsRequested: viewer ? !isDraft && reviewers.some(user => sameUser(user, viewer)) && !decided(viewer) : undefined,
        labels: [],
        viewerCanUpdate: true,
        viewerCanManage: true,
        // Bitbucket Cloud has no public API for auto-merge.
        autoMerge: null,
        viewerCanEnableAutoMerge: false,
        viewerCanDisableAutoMerge: false,
        viewerCanMerge: true,
        host: 'bitbucket',
        reviewEvents: viewerApproved ? BITBUCKET_APPROVED_EVENTS : BITBUCKET_REVIEW_EVENTS,
        // Bitbucket has no reactions on comments.
        reactionKinds: []
    };
}

/** The web page of a pipeline. */
export function pipelineWebUrl(repo: BitbucketRepoRef, buildNumber: number): string {
    return `${bitbucketPipelinesWebUrl(repo)}/results/${buildNumber}`;
}

/** Converts a step of a pipeline to a check of the UI. A step has a log and can run again, like a GitHub Actions job. */
export function stepToCheck(repo: BitbucketRepoRef, pipeline: BbPipeline, step: BbStep, ids: NumericIds): CheckRun {
    const mapped = pipelineStateToCheck(step.state?.name, step.state?.result?.name);
    return {
        id: ids.idOf(stepKey(pipeline.uuid, step.uuid)),
        name: step.name || 'Step',
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: step.started_on ?? null,
        completedAt: mapped.status === 'completed' ? (step.completed_on ?? null) : null,
        url: `${pipelineWebUrl(repo, pipeline.build_number)}/steps/${encodeURIComponent(step.uuid)}`,
        runId: ids.idOf(pipelineKey(pipeline.uuid)),
        isActions: true
    };
}

/** True for a commit status that Bitbucket Pipelines made. The steps of the pipeline show instead. */
export function isPipelinesStatus(status: BbCommitStatus): boolean {
    return /\/(?:pipelines\/results|addon\/pipelines)\//.test(status.url ?? '');
}

/** Converts a commit status (from another CI service) to a check of the UI. It has no log. */
export function commitStatusToCheckRun(status: BbCommitStatus, ids: NumericIds): CheckRun {
    const mapped = commitStatusToCheck(status.state);
    return {
        id: ids.idOf(`status:${status.key}`),
        name: status.name || status.key,
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: status.created_on ?? null,
        completedAt: mapped.status === 'completed' ? (status.updated_on ?? null) : null,
        url: status.url ?? null,
        isActions: false,
        isStatus: true
    };
}

/** The progress of a step for the log view. Bitbucket gives no sub-steps, so the step has no steps. */
export function stepProgressOf(step: BbStep): JobProgress {
    const mapped = pipelineStateToCheck(step.state?.name, step.state?.result?.name);
    return {
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: step.started_on ?? null,
        completedAt: mapped.status === 'completed' ? (step.completed_on ?? null) : null,
        steps: []
    };
}

/** The ID of the one "workflow" of a Bitbucket repository. All pipelines of a repository come from its bitbucket-pipelines.yml. */
export const BITBUCKET_PIPELINE_WORKFLOW_ID = 1;

/** The branch of a pipeline. A pipeline of a pull request runs on its source branch. Null for a pipeline on a tag or a commit. */
function pipelineBranch(target: BbPipelineTarget | null | undefined): string | null {
    if (!target) return null;
    if (target.ref_type === 'branch' && target.ref_name) return target.ref_name;
    if (target.type === 'pipeline_pullrequest_target' && target.source) return target.source;
    return null;
}

/** Converts a pipeline to a run of the Pipelines view. All pipelines of a repository are one workflow. */
export function pipelineToRun(repo: BitbucketRepoRef, pipeline: BbPipeline, ids: NumericIds): WorkflowRun {
    const mapped = pipelineStateToCheck(pipeline.state?.name, pipeline.state?.result?.name, pipeline.state?.stage?.name);
    const target = pipeline.target;
    const where = target?.pullrequest?.title ?? pipelineBranch(target) ?? target?.ref_name ?? target?.commit?.hash?.slice(0, 7) ?? '';
    return {
        id: ids.idOf(pipelineKey(pipeline.uuid)),
        title: where ? `Pipeline #${pipeline.build_number} on ${where}` : `Pipeline #${pipeline.build_number}`,
        workflowId: BITBUCKET_PIPELINE_WORKFLOW_ID,
        workflowName: 'Pipeline',
        runNumber: pipeline.build_number,
        branch: pipelineBranch(target),
        event: (pipeline.trigger?.name ?? 'push').toLowerCase(),
        status: mapped.status,
        conclusion: mapped.conclusion,
        actor: pipeline.creator ? loginOf(pipeline.creator) : null,
        createdAt: pipeline.created_on,
        updatedAt: pipeline.completed_on ?? pipeline.created_on,
        startedAt: pipeline.created_on,
        url: pipelineWebUrl(repo, pipeline.build_number),
        headSha: target?.commit?.hash ?? ''
    };
}

/** The combined CI state of a pipeline for the lists: SUCCESS, FAILURE, or PENDING. Null without a pipeline. */
export function pipelineState(pipeline: BbPipeline | undefined | null): string | null {
    if (!pipeline) return null;
    const mapped = pipelineStateToCheck(pipeline.state?.name, pipeline.state?.result?.name, pipeline.state?.stage?.name);
    if (mapped.status !== 'completed') return 'PENDING';
    return mapped.conclusion === 'failure' || mapped.conclusion === 'cancelled' || mapped.conclusion === 'timed_out' ? 'FAILURE' : 'SUCCESS';
}

/** The check summary of a pipeline for the review queue. A pipeline has one state, so the total is 1. */
export function pipelineCheckSummary(pipeline: BbPipeline | undefined): CheckSummary {
    const state = pipelineState(pipeline);
    if (!state) return { state: null, failing: 0, pending: 0, total: 0 };
    return { state, failing: state === 'FAILURE' ? 1 : 0, pending: state === 'PENDING' ? 1 : 0, total: 1 };
}

/**
 * Returns the newest pipeline of each commit. The pull request gives a short hash, so the map has the first 12
 * characters of each hash (see `shortHash`).
 */
export function pipelinesByCommit(pipelines: readonly BbPipeline[]): Map<string, BbPipeline> {
    const byCommit = new Map<string, BbPipeline>();
    for (const pipeline of pipelines) {
        const hash = pipeline.target?.commit?.hash;
        if (!hash) continue;
        const key = shortHash(hash);
        const current = byCommit.get(key);
        if (!current || pipeline.build_number > current.build_number) byCommit.set(key, pipeline);
    }
    return byCommit;
}

/** The first 12 characters of a commit hash. The pull request API gives hashes of this length. */
export function shortHash(hash: string): string {
    return hash.slice(0, 12);
}

/** Returns the reviewers and the review status of a pull request of a list. */
function peopleOf(pr: BbPullRequest): { assignees: string[]; reviewers: string[]; reviewStatus: ReviewStatus } {
    const reviewers = pr.reviewers ?? [];
    const reviewed = (pr.participants ?? []).filter(participant => approved(participant) || requestedChanges(participant)).map(item => item.user);
    return {
        assignees: [],
        reviewers: uniqueLogins([[...reviewers, ...reviewed].filter(user => !sameUser(user, pr.author)).map(loginOf)]),
        reviewStatus: reviewStatusOf(reviewDecisionOf(pr.participants, reviewers.length))
    };
}

/** True when the viewer is a reviewer of an open pull request, did not write it, and did not review it yet. A draft asks for no review. */
export function viewerIsReviewer(pr: BbPullRequest, viewer: BbUser | undefined): boolean {
    if (!viewer || pr.draft || sameUser(pr.author, viewer)) return false;
    if (!(pr.reviewers ?? []).some(user => sameUser(user, viewer))) return false;
    return !(pr.participants ?? []).some(participant => sameUser(participant.user, viewer) && (approved(participant) || requestedChanges(participant)));
}

/** The CI state of the head commit of a pull request, from the newest pipelines. */
function headPipeline(pr: BbPullRequest, pipelines: Map<string, BbPipeline>): BbPipeline | undefined {
    const hash = pr.source.commit?.hash;
    return hash ? pipelines.get(shortHash(hash)) : undefined;
}

/** Converts an open pull request to the model of the review queue. A list has no diffstat, so the line counts are 0. */
export function openPullRequestOf(repo: BitbucketRepoRef, pr: BbPullRequest, pipelines: Map<string, BbPipeline>, viewer: BbUser | undefined): OpenPullRequest {
    const checks = pipelineCheckSummary(headPipeline(pr, pipelines));
    const viewerDidAuthor = sameUser(pr.author, viewer);
    const decision = reviewDecisionOf(pr.participants, (pr.reviewers ?? []).length);
    return {
        id: encodeBitbucketId(repo, pr.id),
        number: pr.id,
        title: pr.title,
        url: webUrlOf(repo, pr),
        author: loginOf(pr.author),
        isDraft: pr.draft === true,
        createdAt: pr.created_on,
        updatedAt: pr.updated_on,
        headRefName: pr.source.branch?.name ?? '',
        baseRefName: pr.destination.branch?.name ?? '',
        headRefOid: pr.source.commit?.hash ?? '',
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        comments: pr.comment_count ?? 0,
        viewerDidAuthor,
        reviewRequested: viewerIsReviewer(pr, viewer),
        reviewDecision: decision,
        checks,
        actions: viewerDidAuthor
            ? myPullRequestReasons({ isDraft: pr.draft === true, reviewDecision: decision, ...mergeStateOf(pr, undefined, decision), checks: checks.state })
            : [],
        ...peopleOf(pr)
    };
}

/** Converts a pull request to a row of the pull request list. A pull request that is not open has no CI state. */
export function pullRequestSummaryOf(pr: BbPullRequest, pipelines: Map<string, BbPipeline>, viewer: BbUser | undefined): PullRequestSummary {
    const state = pullRequestState(pr.state);
    return {
        number: pr.id,
        title: pr.title,
        author: loginOf(pr.author),
        isDraft: pr.draft === true,
        state,
        updatedAt: pr.updated_on,
        reviewDecision: reviewDecisionOf(pr.participants, (pr.reviewers ?? []).length),
        checks: state === 'OPEN' ? pipelineState(headPipeline(pr, pipelines)) : null,
        comments: pr.comment_count ?? 0,
        additions: 0,
        deletions: 0,
        viewerDidAuthor: sameUser(pr.author, viewer),
        ...peopleOf(pr)
    };
}

/**
 * Converts a pull request of the viewer to an item of the Dashboard. Returns undefined when the viewer has nothing to
 * do on it. A list has no diffstat and no CI state, so the item shows only a request for changes.
 */
export function myPullRequestItemOf(repo: BitbucketRepoRef, pr: BbPullRequest): MyPullRequestItem | undefined {
    const decision = reviewDecisionOf(pr.participants, (pr.reviewers ?? []).length);
    const reasons = myPullRequestReasons({ isDraft: pr.draft === true, reviewDecision: decision, ...mergeStateOf(pr, undefined, decision), checks: null });
    if (reasons.length === 0) return undefined;
    return {
        repo: bitbucketRepoRef(repo),
        number: pr.id,
        title: pr.title,
        url: webUrlOf(repo, pr),
        updatedAt: pr.updated_on,
        createdAt: pr.created_on,
        reasons,
        headSha: pr.source.commit?.hash ?? undefined
    };
}

/** Returns the repository of a pull request from its destination ("workspace/repo"). */
export function repoOfPullRequest(pr: BbPullRequest): BitbucketRepoRef | undefined {
    const [workspace, repo, ...rest] = (pr.destination.repository?.full_name ?? '').split('/');
    return workspace && repo && rest.length === 0 ? { workspace, repo } : undefined;
}

/** Returns the newest merged pull request of each source branch. A pull request without a head commit is left out. */
export function mergedBranches(prs: readonly BbPullRequest[]): Record<string, MergedPullRequest> {
    const merged: Record<string, MergedPullRequest> = {};
    const newest = [...prs].sort((a, b) => b.updated_on.localeCompare(a.updated_on));
    for (const pr of newest) {
        const branch = pr.source.branch?.name;
        const hash = pr.source.commit?.hash;
        if (pr.state !== 'MERGED' || !branch || !hash) continue;
        if (!merged[branch]) merged[branch] = { number: pr.id, title: pr.title, headSha: hash };
    }
    return merged;
}

/**
 * Returns the open pull requests by source branch, with the state of the newest pipeline of their head commit.
 * The viewer sets the viewer role: "author" for the author, "involved" for a reviewer or a participant.
 */
export function branchSummaries(prs: readonly BbPullRequest[], pipelines: Map<string, BbPipeline>, viewer?: BbUser): Record<string, BranchSummary> {
    const summaries: Record<string, BranchSummary> = {};
    for (const pr of prs) {
        const branch = pr.source.branch?.name;
        if (pr.state !== 'OPEN' || !branch || summaries[branch]) continue;
        const involved = !!viewer && [...(pr.reviewers ?? []), ...(pr.participants ?? []).map(item => item.user)].some(user => sameUser(user, viewer));
        summaries[branch] = {
            number: pr.id,
            title: pr.title,
            url: pr.links?.html?.href ?? '',
            headSha: pr.source.commit?.hash ?? undefined,
            isDraft: pr.draft === true,
            reviewDecision: reviewDecisionOf(pr.participants, (pr.reviewers ?? []).length),
            checks: pipelineState(headPipeline(pr, pipelines)),
            viewerRole: viewer === undefined ? undefined : sameUser(pr.author, viewer) ? 'author' : involved ? 'involved' : undefined
        };
    }
    return summaries;
}
