import {
    AZURE_REVIEW_EVENTS,
    azureProjectApi,
    azureRepoRef,
    azureRepoWebUrl,
    buildResultToConclusion,
    buildStatusToCheck,
    encodeAzureId,
    fromRefName,
    gitStatusToCheck,
    reviewDecisionFromVotes,
    reviewStateForVote,
    threadIsResolved,
    timelineResultToConclusion,
    timelineStateToCheck,
    type AzureRepoRef
} from '@shared/azure-devops';
import { myPullRequestReasons, type MyPullRequestItem, type ReviewRequestItem } from '@shared/dashboard';
import type {
    BranchSummary,
    CheckRun,
    GitHubUser,
    IssueComment,
    JobProgress,
    MergeMethod,
    PullRequest,
    PullRequestCommit,
    PullRequestFile,
    PullRequestState,
    PullRequestSummary,
    Reaction,
    ReactionContent,
    RequestedReviewer,
    Review,
    ReviewThread
} from '@shared/github';
import type { WorkflowRun } from '@shared/pipelines';
import type { CheckSummary, OpenPullRequest } from '@shared/review-queue';

// The raw shapes of the Azure DevOps REST API 7.1. Only the fields that ShipWarden reads are here.
// See https://learn.microsoft.com/rest/api/azure/devops/?view=azure-devops-rest-7.1

export interface AzIdentity {
    id: string;
    displayName: string;
    uniqueName?: string;
    imageUrl?: string;
    isContainer?: boolean;
}

export interface AzReviewer extends AzIdentity {
    vote: number;
    isRequired?: boolean;
    hasDeclined?: boolean;
}

export interface AzRepository {
    id: string;
    name: string;
    defaultBranch?: string;
    webUrl?: string;
    project?: { id: string; name: string };
    /** True when an administrator turned off the repository. Its API calls fail. */
    isDisabled?: boolean;
}

export interface AzPullRequest {
    pullRequestId: number;
    title: string;
    description?: string;
    status: 'active' | 'abandoned' | 'completed' | 'notSet' | string;
    isDraft?: boolean;
    mergeStatus?: 'notSet' | 'queued' | 'conflicts' | 'succeeded' | 'rejectedByPolicy' | 'failure' | string;
    createdBy: AzIdentity;
    creationDate: string;
    /** The time of the completion or the abandonment. */
    closedDate?: string;
    sourceRefName: string;
    targetRefName: string;
    lastMergeSourceCommit?: { commitId: string };
    lastMergeTargetCommit?: { commitId: string };
    reviewers?: AzReviewer[];
    labels?: { id?: string; name: string; active?: boolean }[];
    autoCompleteSetBy?: AzIdentity;
    completionOptions?: { mergeStrategy?: string; deleteSourceBranch?: boolean };
    repository?: AzRepository;
}

export interface AzComment {
    id: number;
    parentCommentId?: number;
    author: AzIdentity;
    content?: string;
    publishedDate: string;
    commentType?: 'text' | 'system' | 'codeChange' | 'unknown' | string;
    isDeleted?: boolean;
    /** The users that like the comment. */
    usersLiked?: AzIdentity[] | null;
}

export interface AzFilePosition {
    line: number;
    offset: number;
}

export interface AzThread {
    id: number;
    status?: string;
    publishedDate?: string;
    isDeleted?: boolean;
    threadContext?: {
        filePath: string;
        rightFileStart?: AzFilePosition | null;
        rightFileEnd?: AzFilePosition | null;
        leftFileStart?: AzFilePosition | null;
        leftFileEnd?: AzFilePosition | null;
    } | null;
    comments: AzComment[];
}

export interface AzCommit {
    commitId: string;
    comment?: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { name?: string; email?: string; date?: string };
}

export interface AzIteration {
    id: number;
    commonRefCommit?: { commitId: string };
    sourceRefCommit?: { commitId: string };
    targetRefCommit?: { commitId: string };
}

export interface AzChangeEntry {
    changeTrackingId?: number;
    changeType: string;
    item?: { path: string; isFolder?: boolean; objectId?: string; originalObjectId?: string };
    originalPath?: string;
}

export interface AzBuild {
    id: number;
    buildNumber: string;
    status: string;
    result?: string;
    queueTime?: string;
    startTime?: string;
    finishTime?: string;
    sourceBranch: string;
    sourceVersion: string;
    reason?: string;
    definition: { id: number; name: string; path?: string };
    requestedFor?: AzIdentity;
    triggerInfo?: Record<string, string>;
    _links?: { web?: { href: string } };
}

export interface AzBuildDefinition {
    id: number;
    name: string;
    path?: string;
    queueStatus?: 'enabled' | 'paused' | 'disabled' | string;
}

export interface AzTimelineRecord {
    id: string;
    parentId?: string | null;
    type: string;
    name: string;
    state?: string | null;
    result?: string | null;
    startTime?: string | null;
    finishTime?: string | null;
    order?: number | null;
    log?: { id: number; url?: string } | null;
}

export interface AzGitStatus {
    id: number;
    state: string;
    description?: string;
    context: { name: string; genre?: string };
    targetUrl?: string;
    creationDate?: string;
    updatedDate?: string;
}

/** The list wrapper of most Azure DevOps list endpoints. */
export interface AzList<T> {
    count?: number;
    value: T[];
}

/** The login of an identity in the UI: the email or account name, else the display name. */
export function loginOf(identity: AzIdentity | null | undefined): string {
    return identity?.uniqueName || identity?.displayName || 'unknown';
}

/** A user for the UI. Azure DevOps avatars need a login, so the page cannot load them. They stay out. */
export function userOf(identity: AzIdentity | null | undefined): GitHubUser | null {
    return identity ? { login: loginOf(identity) } : null;
}

export function pullRequestState(status: string): PullRequestState {
    if (status === 'completed') return 'MERGED';
    if (status === 'abandoned') return 'CLOSED';
    return 'OPEN';
}

/** Converts a merge strategy of Azure DevOps to the merge method of the UI. */
export function mergeMethodOf(strategy: string | undefined): MergeMethod {
    switch (strategy) {
        case 'squash':
            return 'squash';
        case 'rebase':
        case 'rebaseMerge':
            return 'rebase';
        default:
            return 'merge';
    }
}

/** Converts a merge method of the UI to the merge strategy of Azure DevOps. */
export function mergeStrategyOf(method: MergeMethod): string {
    switch (method) {
        case 'squash':
            return 'squash';
        case 'rebase':
            return 'rebase';
        default:
            return 'noFastForward';
    }
}

/** The web page of a pull request. */
export function pullRequestUrl(repo: AzureRepoRef, id: number): string {
    return `${azureRepoWebUrl(repo)}/pullrequest/${id}`;
}

/** The web page of a build. */
export function buildUrl(repo: AzureRepoRef, build: AzBuild): string {
    return build._links?.web?.href ?? `${azureProjectApi(repo).replace(/\/_apis$/, '')}/_build/results?buildId=${build.id}`;
}

/** Removes the leading "/" of an Azure path. */
function repoPath(path: string): string {
    return path.replace(/^\//, '');
}

/** The reactions that Azure DevOps accepts on a comment. A like shows as a thumbs up. */
export const AZURE_REACTIONS: ReactionContent[] = ['THUMBS_UP'];

/** Changes the likes of a comment to a thumbs up reaction. */
export function likesOf(comment: Pick<AzComment, 'usersLiked'>, viewerId: string | undefined): Reaction[] {
    const users = comment.usersLiked ?? [];
    if (users.length === 0) return [];
    return [{ content: 'THUMBS_UP', count: users.length, viewerHasReacted: !!viewerId && users.some(user => user.id === viewerId) }];
}

/**
 * Splits the threads of a pull request: threads on a file become review threads, and threads without a file become
 * comments of the conversation. System threads (for example "X voted") and deleted comments stay out.
 */
export function mapThreads(
    repo: AzureRepoRef,
    pullRequestId: number,
    threads: readonly AzThread[],
    viewerId?: string
): { threads: ReviewThread[]; issueComments: IssueComment[] } {
    const web = pullRequestUrl(repo, pullRequestId);
    const reviewThreads: ReviewThread[] = [];
    const issueComments: IssueComment[] = [];
    for (const thread of threads) {
        if (thread.isDeleted) continue;
        const threadId = encodeAzureId(repo, pullRequestId, thread.id);
        const url = `${web}?discussionId=${thread.id}`;
        const comments = thread.comments
            .filter(comment => !comment.isDeleted && comment.commentType !== 'system' && (comment.content ?? '').trim() !== '')
            .map(comment => ({
                id: `${threadId}#${comment.id}`,
                // A reply goes to the thread, so the thread ID is the ID for the reply.
                databaseId: thread.id,
                author: userOf(comment.author),
                body: comment.content ?? '',
                createdAt: comment.publishedDate,
                url,
                reactions: likesOf(comment, viewerId)
            }));
        if (comments.length === 0) continue;
        const context = thread.threadContext;
        if (!context?.filePath) {
            issueComments.push(...comments.map(({ databaseId: _databaseId, ...comment }) => comment));
            continue;
        }
        const right = context.rightFileStart ?? context.rightFileEnd;
        const left = context.leftFileStart ?? context.leftFileEnd;
        const line = right?.line ?? left?.line ?? null;
        reviewThreads.push({
            id: threadId,
            path: repoPath(context.filePath),
            line,
            originalLine: line,
            side: right ? 'RIGHT' : 'LEFT',
            isResolved: threadIsResolved(thread.status),
            isOutdated: false,
            comments
        });
    }
    issueComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { threads: reviewThreads, issueComments: issueComments.slice(-50) };
}

/** Converts the commits of a pull request (newest first from Azure) to the UI model (oldest first). */
export function mapCommits(repo: AzureRepoRef, commits: readonly AzCommit[]): PullRequestCommit[] {
    return commits
        .slice(0, 100)
        .reverse()
        .map(commit => ({
            oid: commit.commitId,
            abbreviatedOid: commit.commitId.slice(0, 7),
            messageHeadline: (commit.comment ?? '').split('\n')[0],
            committedDate: commit.committer?.date ?? commit.author?.date ?? '',
            url: `${azureRepoWebUrl(repo)}/commit/${commit.commitId}`,
            author: commit.author?.name ?? null
        }));
}

export interface PullRequestParts {
    repo: AzureRepoRef;
    pr: AzPullRequest;
    threads: readonly AzThread[];
    commits: readonly AzCommit[];
    /** The newest iteration. Its common commit is the base of the diff. */
    iteration?: AzIteration;
    /** The number of changed files, when known. */
    changedFiles?: number;
    /** The ID of the user of the token. */
    viewerId?: string;
}

/** Converts a pull request with its threads and commits to the UI model. */
export function mapPullRequest(parts: PullRequestParts): PullRequest {
    const { repo, pr, viewerId } = parts;
    const reviewers = pr.reviewers ?? [];
    const { threads, issueComments } = mapThreads(repo, pr.pullRequestId, parts.threads, viewerId);
    const url = pullRequestUrl(repo, pr.pullRequestId);
    const reviews: Review[] = reviewers.flatMap(reviewer => {
        const state = reviewStateForVote(reviewer.vote);
        return state
            ? [{ id: `${encodeAzureId(repo, pr.pullRequestId)}#vote:${reviewer.id}`, author: userOf(reviewer), state, body: '', submittedAt: null, url }]
            : [];
    });
    const reviewRequests: RequestedReviewer[] = reviewers
        .filter(reviewer => reviewer.vote === 0 && !reviewer.hasDeclined)
        .map(reviewer =>
            reviewer.isContainer ? { kind: 'team', login: loginOf(reviewer), name: reviewer.displayName } : { kind: 'user', login: loginOf(reviewer) }
        );
    const { mergeable, mergeStateStatus } = mergeStateOf(pr);
    const commits = mapCommits(repo, parts.commits);
    const headRefOid = pr.lastMergeSourceCommit?.commitId ?? parts.iteration?.sourceRefCommit?.commitId ?? '';
    const baseRefOid = parts.iteration?.commonRefCommit?.commitId ?? pr.lastMergeTargetCommit?.commitId ?? '';
    const state = pullRequestState(pr.status);
    return {
        id: encodeAzureId(repo, pr.pullRequestId),
        number: pr.pullRequestId,
        title: pr.title,
        body: pr.description ?? '',
        url,
        state,
        isDraft: pr.isDraft ?? false,
        mergeable,
        mergeStateStatus,
        reviewDecision: reviewDecisionFromVotes(reviewers),
        author: userOf(pr.createdBy),
        baseRefName: fromRefName(pr.targetRefName),
        headRefName: fromRefName(pr.sourceRefName),
        baseRefOid,
        headRefOid,
        // Azure DevOps gives no line counts for a pull request.
        additions: 0,
        deletions: 0,
        changedFiles: parts.changedFiles ?? 0,
        createdAt: pr.creationDate,
        viewerDidAuthor: !!viewerId && pr.createdBy.id === viewerId,
        reviews,
        issueComments,
        threads,
        allowedMergeMethods: ['merge', 'squash', 'rebase'],
        defaultMergeMethod: mergeMethodOf(pr.completionOptions?.mergeStrategy),
        commits,
        commitCount: parts.commits.length,
        checkCount: 0,
        assignees: [],
        reviewRequests,
        viewerIsRequested: viewerId ? reviewers.some(reviewer => reviewer.id === viewerId && reviewer.vote === 0 && !reviewer.hasDeclined) : undefined,
        labels: (pr.labels ?? []).filter(label => label.active !== false).map(label => ({ name: label.name, color: '8b949e' })),
        viewerCanUpdate: true,
        viewerCanManage: true,
        autoMerge: pr.autoCompleteSetBy ? { method: mergeMethodOf(pr.completionOptions?.mergeStrategy), enabledBy: loginOf(pr.autoCompleteSetBy) } : null,
        viewerCanEnableAutoMerge: state === 'OPEN' && !pr.autoCompleteSetBy,
        viewerCanDisableAutoMerge: !!pr.autoCompleteSetBy,
        viewerCanMerge: true,
        host: 'azure',
        reviewEvents: AZURE_REVIEW_EVENTS,
        reactionKinds: AZURE_REACTIONS,
        hasAssignees: false
    };
}

/** Converts the change entries of a pull request iteration to the files of the UI. Folders stay out. */
export function mapChanges(entries: readonly AzChangeEntry[]): PullRequestFile[] {
    const files: PullRequestFile[] = [];
    for (const entry of entries) {
        if (!entry.item?.path || entry.item.isFolder) continue;
        const type = entry.changeType.toLowerCase();
        const status = type.includes('delete') ? 'removed' : type.includes('add') ? 'added' : type.includes('rename') ? 'renamed' : 'modified';
        files.push({
            path: repoPath(entry.item.path),
            ...(entry.originalPath ? { previousPath: repoPath(entry.originalPath) } : {}),
            status,
            additions: 0,
            deletions: 0
        });
    }
    return files;
}

/** Converts a build to a check of the UI. A build is like one GitHub Actions job: it has a log and can run again. */
export function buildToCheck(repo: AzureRepoRef, build: AzBuild): CheckRun {
    return {
        id: build.id,
        name: build.definition.name,
        status: buildStatusToCheck(build.status),
        conclusion: build.status === 'completed' ? buildResultToConclusion(build.result) : null,
        startedAt: build.startTime ?? null,
        completedAt: build.finishTime ?? null,
        url: buildUrl(repo, build),
        runId: build.id,
        isActions: true
    };
}

/** Converts a status of an external service on a commit to a check of the UI. */
export function gitStatusToCheckRun(status: AzGitStatus): CheckRun {
    const mapped = gitStatusToCheck(status.state);
    const name = status.context.genre ? `${status.context.genre}/${status.context.name}` : status.context.name;
    return {
        id: status.id,
        name,
        status: mapped.status,
        conclusion: mapped.conclusion,
        startedAt: status.creationDate ?? null,
        completedAt: mapped.status === 'completed' ? (status.updatedDate ?? status.creationDate ?? null) : null,
        url: status.targetUrl ?? null,
        isActions: false,
        isStatus: true
    };
}

/** The commit that a build tested. A pull request build tests a merge commit, so the source commit is in the trigger info. */
export function buildHeadSha(build: AzBuild): string {
    return build.triggerInfo?.['pr.sourceSha'] ?? build.sourceVersion;
}

/** Keeps the newest build of each pipeline. A larger build ID is newer. */
export function latestBuilds(builds: readonly AzBuild[]): AzBuild[] {
    const newest = new Map<number, AzBuild>();
    for (const build of builds) {
        const current = newest.get(build.definition.id);
        if (!current || build.id > current.id) newest.set(build.definition.id, build);
    }
    return [...newest.values()];
}

/** Returns the newest build of each pipeline for a commit: builds of the commit and pull request builds of the commit. */
export function buildsForCommit(builds: readonly AzBuild[], sha: string): AzBuild[] {
    return latestBuilds(builds.filter(build => build.sourceVersion === sha || build.triggerInfo?.['pr.sourceSha'] === sha));
}

/** Converts a build to a run of the Pipelines view. */
export function buildToRun(repo: AzureRepoRef, build: AzBuild): WorkflowRun {
    const check = buildToCheck(repo, build);
    const prBranch = build.triggerInfo?.['pr.sourceBranch'];
    return {
        id: build.id,
        title: build.triggerInfo?.['ci.message'] ?? build.triggerInfo?.['pr.title'] ?? `${build.definition.name} ${build.buildNumber}`,
        workflowId: build.definition.id,
        workflowName: build.definition.name,
        runNumber: build.id,
        branch: fromRefName(prBranch ?? build.sourceBranch) || null,
        event: build.reason ?? 'manual',
        status: check.status,
        conclusion: check.conclusion,
        actor: build.requestedFor?.displayName ?? null,
        createdAt: build.queueTime ?? build.startTime ?? '',
        updatedAt: build.finishTime ?? build.startTime ?? build.queueTime ?? '',
        startedAt: build.startTime ?? null,
        url: check.url ?? '',
        headSha: buildHeadSha(build)
    };
}

/** Orders the records of a timeline by their parents and their `order`: stages, then jobs, then tasks. */
export function orderedRecords(records: readonly AzTimelineRecord[], type: string): AzTimelineRecord[] {
    const byId = new Map(records.map(record => [record.id, record]));
    const path = (record: AzTimelineRecord): number[] => {
        const orders: number[] = [];
        let current: AzTimelineRecord | undefined = record;
        // A depth limit protects against a cycle in bad data.
        for (let depth = 0; current && depth < 10; depth++) {
            orders.unshift(current.order ?? 0);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return orders;
    };
    const compare = (a: number[], b: number[]) => {
        for (let index = 0; index < Math.max(a.length, b.length); index++) {
            const diff = (a[index] ?? 0) - (b[index] ?? 0);
            if (diff !== 0) return diff;
        }
        return 0;
    };
    return records
        .filter(record => record.type === type)
        .map(record => ({ record, path: path(record) }))
        .sort((a, b) => compare(a.path, b.path))
        .map(item => item.record);
}

/** Converts a build and its timeline to the progress of the log view: the tasks are the steps. */
export function timelineToProgress(build: AzBuild, records: readonly AzTimelineRecord[]): JobProgress {
    const jobs = orderedRecords(records, 'Job');
    const jobNames = new Map(jobs.map(job => [job.id, job.name]));
    const tasks = orderedRecords(records, 'Task');
    return {
        status: buildStatusToCheck(build.status),
        conclusion: build.status === 'completed' ? buildResultToConclusion(build.result) : null,
        startedAt: build.startTime ?? null,
        completedAt: build.finishTime ?? null,
        steps: tasks.map((task, index) => {
            const job = task.parentId ? jobNames.get(task.parentId) : undefined;
            return {
                number: index + 1,
                name: job && jobs.length > 1 ? `${job} › ${task.name}` : task.name,
                status: timelineStateToCheck(task.state),
                conclusion: task.state === 'completed' ? timelineResultToConclusion(task.result) : null,
                startedAt: task.startTime ?? null,
                completedAt: task.finishTime ?? null
            };
        })
    };
}

/** Returns the combined CI state of builds for the worktree list: FAILURE, PENDING or SUCCESS. Null without builds. */
export function rollupState(checks: readonly Pick<CheckRun, 'status' | 'conclusion'>[]): string | null {
    if (checks.length === 0) return null;
    if (checks.some(check => ['failure', 'cancelled', 'timed_out', 'error'].includes(check.conclusion ?? ''))) return 'FAILURE';
    if (checks.some(check => check.status !== 'completed')) return 'PENDING';
    return 'SUCCESS';
}

/** Returns the newest build of each pipeline for the pull request and its head commit. */
export function pullRequestBuilds(pr: AzPullRequest, builds: readonly AzBuild[]): AzBuild[] {
    const headSha = pr.lastMergeSourceCommit?.commitId;
    return latestBuilds(
        builds.filter(
            build =>
                (build.sourceBranch === `refs/pull/${pr.pullRequestId}/merge` || build.triggerInfo?.['pr.number'] === String(pr.pullRequestId)) &&
                (!headSha || !build.triggerInfo?.['pr.sourceSha'] || build.triggerInfo['pr.sourceSha'] === headSha)
        )
    );
}

/** Returns the check summary of the builds of a pull request, for the lists of the Review view. */
export function buildCheckSummary(repo: AzureRepoRef, builds: readonly AzBuild[]): CheckSummary {
    const checks = builds.map(build => buildToCheck(repo, build));
    return {
        state: rollupState(checks),
        failing: checks.filter(check => ['failure', 'cancelled', 'timed_out', 'error'].includes(check.conclusion ?? '')).length,
        pending: checks.filter(check => check.status !== 'completed').length,
        total: checks.length
    };
}

/** The user of the token in an organization. */
export interface AzViewer {
    id: string;
    /** The login of the viewer in the UI. It is the same text as `loginOf` gives for the identity of the viewer. */
    login: string;
}

/** Returns the vote of the viewer on a pull request. Undefined when the viewer is not a reviewer. */
function viewerReviewer(pr: AzPullRequest, viewerId: string | undefined): AzReviewer | undefined {
    return viewerId ? (pr.reviewers ?? []).find(reviewer => reviewer.id === viewerId) : undefined;
}

/** True when the viewer is a reviewer of the pull request, did not vote and did not decline. A draft asks for no review. */
export function viewerIsRequested(pr: AzPullRequest, viewerId: string | undefined): boolean {
    const reviewer = viewerReviewer(pr, viewerId);
    return !pr.isDraft && !!reviewer && reviewer.vote === 0 && !reviewer.hasDeclined;
}

/** The merge state of a pull request, in the words of GitHub. `myPullRequestReasons` reads them. */
function mergeStateOf(pr: AzPullRequest): { mergeable: string; mergeStateStatus: string } {
    return {
        mergeable: pr.mergeStatus === 'conflicts' ? 'CONFLICTING' : pr.mergeStatus === 'succeeded' ? 'MERGEABLE' : 'UNKNOWN',
        mergeStateStatus:
            pr.mergeStatus === 'rejectedByPolicy' ? 'BLOCKED' : pr.mergeStatus === 'conflicts' ? 'DIRTY' : pr.mergeStatus === 'succeeded' ? 'CLEAN' : 'UNKNOWN'
    };
}

/**
 * Converts an active pull request to the model of the review queue.
 * Azure DevOps does not keep the commit of a vote, so the review of the viewer has no commit.
 * Azure DevOps gives no line counts and no comment count in the list, so they are 0.
 */
export function openPullRequestOf(repo: AzureRepoRef, pr: AzPullRequest, builds: readonly AzBuild[], viewerId: string | undefined): OpenPullRequest {
    const reviewers = pr.reviewers ?? [];
    const checks = buildCheckSummary(repo, pullRequestBuilds(pr, builds));
    const viewerDidAuthor = !!viewerId && pr.createdBy.id === viewerId;
    const vote = viewerReviewer(pr, viewerId)?.vote ?? 0;
    const reviewDecision = reviewDecisionFromVotes(reviewers);
    return {
        id: encodeAzureId(repo, pr.pullRequestId),
        number: pr.pullRequestId,
        title: pr.title,
        url: pullRequestUrl(repo, pr.pullRequestId),
        author: loginOf(pr.createdBy),
        isDraft: pr.isDraft ?? false,
        createdAt: pr.creationDate,
        updatedAt: pr.creationDate,
        headRefName: fromRefName(pr.sourceRefName),
        baseRefName: fromRefName(pr.targetRefName),
        headRefOid: pr.lastMergeSourceCommit?.commitId ?? '',
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        comments: 0,
        viewerDidAuthor,
        reviewRequested: viewerIsRequested(pr, viewerId),
        reviewDecision,
        checks,
        viewerReview: vote !== 0 ? { state: vote > 0 ? 'APPROVED' : 'CHANGES_REQUESTED', submittedAt: pr.creationDate, commitOid: null } : undefined,
        actions: viewerDidAuthor ? myPullRequestReasons({ isDraft: pr.isDraft ?? false, reviewDecision, ...mergeStateOf(pr), checks: checks.state }) : []
    };
}

/** Converts a pull request to a row of the pull request list. A pull request that is not active has no CI state. */
export function pullRequestSummaryOf(repo: AzureRepoRef, pr: AzPullRequest, builds: readonly AzBuild[], viewerId: string | undefined): PullRequestSummary {
    const state = pullRequestState(pr.status);
    return {
        number: pr.pullRequestId,
        title: pr.title,
        author: loginOf(pr.createdBy),
        isDraft: pr.isDraft ?? false,
        state,
        updatedAt: pr.closedDate ?? pr.creationDate,
        reviewDecision: reviewDecisionFromVotes(pr.reviewers ?? []),
        checks: state === 'OPEN' ? buildCheckSummary(repo, pullRequestBuilds(pr, builds)).state : null,
        comments: 0,
        additions: 0,
        deletions: 0,
        viewerDidAuthor: !!viewerId && pr.createdBy.id === viewerId
    };
}

/** Returns the repository of a pull request from a list of a project. Returns undefined when the list gives no repository. */
export function repoOfPullRequest(organization: string, pr: AzPullRequest): AzureRepoRef | undefined {
    const project = pr.repository?.project?.name;
    const repository = pr.repository?.name;
    return project && repository ? { organization, project, repository } : undefined;
}

/** Converts a pull request that asks the viewer for a review to an item of the Dashboard. */
export function reviewRequestItemOf(repo: AzureRepoRef, pr: AzPullRequest): ReviewRequestItem {
    return {
        repo: azureRepoRef(repo),
        number: pr.pullRequestId,
        title: pr.title,
        url: pullRequestUrl(repo, pr.pullRequestId),
        author: loginOf(pr.createdBy),
        updatedAt: pr.creationDate,
        createdAt: pr.creationDate
    };
}

/** Converts a pull request of the viewer to an item of the Dashboard. Returns undefined when the viewer has nothing to do on it. */
export function myPullRequestItemOf(repo: AzureRepoRef, pr: AzPullRequest, builds: readonly AzBuild[]): MyPullRequestItem | undefined {
    const reviewDecision = reviewDecisionFromVotes(pr.reviewers ?? []);
    const checks = buildCheckSummary(repo, pullRequestBuilds(pr, builds)).state;
    const reasons = myPullRequestReasons({ isDraft: pr.isDraft ?? false, reviewDecision, ...mergeStateOf(pr), checks });
    if (reasons.length === 0) return undefined;
    return {
        repo: azureRepoRef(repo),
        number: pr.pullRequestId,
        title: pr.title,
        url: pullRequestUrl(repo, pr.pullRequestId),
        updatedAt: pr.creationDate,
        createdAt: pr.creationDate,
        reasons,
        headSha: pr.lastMergeSourceCommit?.commitId,
        mergeMethod: pr.completionOptions?.mergeStrategy ? mergeMethodOf(pr.completionOptions.mergeStrategy) : undefined
    };
}

/**
 * Returns the active pull requests by source branch, with the CI state of their newest builds.
 * The viewer ID sets the viewer role: "author" for the creator, "involved" for a reviewer.
 */
export function branchSummaries(
    repo: AzureRepoRef,
    prs: readonly AzPullRequest[],
    builds: readonly AzBuild[],
    viewerId?: string
): Record<string, BranchSummary> {
    const summaries: Record<string, BranchSummary> = {};
    for (const pr of prs) {
        if (pr.status !== 'active' || !pr.sourceRefName.startsWith('refs/heads/')) continue;
        const branch = fromRefName(pr.sourceRefName);
        if (summaries[branch]) continue;
        const headSha = pr.lastMergeSourceCommit?.commitId;
        const prBuilds = pullRequestBuilds(pr, builds);
        summaries[branch] = {
            number: pr.pullRequestId,
            title: pr.title,
            url: pullRequestUrl(repo, pr.pullRequestId),
            headSha,
            isDraft: pr.isDraft ?? false,
            reviewDecision: reviewDecisionFromVotes(pr.reviewers ?? []),
            checks: rollupState(prBuilds.map(build => buildToCheck(repo, build))),
            viewerRole: !viewerId
                ? undefined
                : pr.createdBy.id === viewerId
                  ? 'author'
                  : (pr.reviewers ?? []).some(reviewer => reviewer.id === viewerId)
                    ? 'involved'
                    : undefined
        };
    }
    return summaries;
}
