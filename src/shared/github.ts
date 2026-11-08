import type { WorkflowInput } from './pipelines';
/** A GitHub repository. */
export interface RepoRef {
    owner: string;
    name: string;
}

/**
 * The repository of a GitHub request: a worktree path (ShipWarden finds the repository from its "origin" remote),
 * or a repository without a local checkout, for example in the Review view.
 */
export type RepoTarget = string | RepoRef;

/** Returns a text key for a target, for example for a cache. */
export function targetKey(target: RepoTarget): string {
    return typeof target === 'string' ? target : `github:${target.owner}/${target.name}`;
}

/** The pull requests that the Review view lists. */
export type PullRequestFilter = 'open' | 'review' | 'mine' | 'assigned' | 'closed';

export const PULL_REQUEST_FILTERS: { id: PullRequestFilter; label: string }[] = [
    { id: 'open', label: 'Open' },
    { id: 'review', label: 'Needs my review' },
    { id: 'mine', label: 'Mine' },
    { id: 'assigned', label: 'Assigned to me' },
    { id: 'closed', label: 'Closed' }
];

/** Returns the GitHub search qualifiers of a filter. */
export function pullRequestSearch(repo: RepoRef, filter: PullRequestFilter, query?: string): string {
    const qualifiers: Record<PullRequestFilter, string> = {
        open: 'is:open',
        review: 'is:open review-requested:@me',
        mine: 'is:open author:@me',
        assigned: 'is:open assignee:@me',
        closed: 'is:closed'
    };
    return [`repo:${repo.owner}/${repo.name}`, 'is:pr', qualifiers[filter], query?.trim()].filter(Boolean).join(' ');
}

/** A pull request in the list of the Review view. */
export interface PullRequestSummary {
    number: number;
    title: string;
    author: string | null;
    isDraft: boolean;
    state: PullRequestState;
    updatedAt: string;
    reviewDecision: ReviewDecision;
    /** The combined CI state of the head commit, for example SUCCESS, FAILURE or PENDING. */
    checks: string | null;
    comments: number;
    additions: number;
    deletions: number;
    viewerDidAuthor: boolean;
}

/** A GitHub user or organization that the user can select for the Review view. */
export interface GitHubOwner {
    login: string;
    kind: 'user' | 'organization';
}

/** A repository in the repository picker of the Review view. */
export interface GitHubRepoInfo {
    owner: string;
    name: string;
    /** The time of the last push, for the order of the picker. */
    pushedAt?: string;
}

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export type DiffSide = 'LEFT' | 'RIGHT';

export interface GitHubUser {
    login: string;
    avatarUrl?: string;
}

export interface ReviewComment {
    /** The GraphQL node ID. */
    id: string;
    /** The REST ID. The reply endpoint needs it. */
    databaseId: number;
    author: GitHubUser | null;
    body: string;
    createdAt: string;
    url: string;
}

export interface ReviewThread {
    id: string;
    path: string;
    /** The line in the current diff. It is null when the thread is outdated. */
    line: number | null;
    originalLine: number | null;
    side: DiffSide;
    isResolved: boolean;
    isOutdated: boolean;
    comments: ReviewComment[];
}

export interface Review {
    /** The GraphQL node ID. */
    id: string;
    author: GitHubUser | null;
    state: string;
    body: string;
    submittedAt: string | null;
    url: string;
}

/** A comment in the conversation of a pull request, not on a line of code. */
export interface IssueComment {
    /** The GraphQL node ID. */
    id: string;
    author: GitHubUser | null;
    body: string;
    createdAt: string;
    url: string;
}

export interface PullRequest {
    id: string;
    number: number;
    title: string;
    body: string;
    url: string;
    state: PullRequestState;
    isDraft: boolean;
    /** MERGEABLE, CONFLICTING or UNKNOWN. */
    mergeable: string;
    /** For example CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE. */
    mergeStateStatus: string;
    reviewDecision: ReviewDecision;
    author: GitHubUser | null;
    baseRefName: string;
    headRefName: string;
    baseRefOid: string;
    headRefOid: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    createdAt: string;
    viewerDidAuthor: boolean;
    reviews: Review[];
    /** The newest 50 comments of the conversation, the oldest first. */
    issueComments: IssueComment[];
    threads: ReviewThread[];
    allowedMergeMethods: MergeMethod[];
    defaultMergeMethod: MergeMethod;
    /** The newest 100 commits, the oldest first. */
    commits: PullRequestCommit[];
    commitCount: number;
    /** The number of checks and statuses on the head commit. */
    checkCount: number;
    assignees: GitHubUser[];
    /** The users and teams that GitHub asks for a review and that did not review yet. */
    reviewRequests: RequestedReviewer[];
    labels: GitHubLabel[];
    /** True when the user can change the title and the description, can close or reopen the pull request, and can make it a draft or ready for review. */
    viewerCanUpdate: boolean;
    /** True when the user can change the assignees, the reviewers and the labels. This needs triage access or more. */
    viewerCanManage: boolean;
    /** True when the user can merge the pull request. This needs write access or more. Branch rules can still block the merge. */
    viewerCanMerge: boolean;
}

/** A label of a pull request. `color` is a hex color without "#". */
export interface GitHubLabel {
    name: string;
    color: string;
    description?: string | null;
}

/** A user or a team that GitHub asks for a review. A team has the slug of the team in `login`. */
export interface RequestedReviewer {
    kind: 'user' | 'team';
    login: string;
    /** The name of a team, for example "Platform". */
    name?: string;
}

/** The users and the labels that the user can add to the pull requests of a repository. */
export interface PullRequestCandidates {
    users: GitHubUser[];
    labels: GitHubLabel[];
}

/** One change to a pull request. */
export type PullRequestChange =
    | { kind: 'details'; title?: string; body?: string; state?: 'open' | 'closed' }
    /** `pullRequestId` is the node ID. True makes the pull request a draft. False marks it as ready for review. */
    | { kind: 'draft'; pullRequestId: string; draft: boolean }
    | { kind: 'assignee'; login: string; add: boolean }
    | { kind: 'reviewer'; reviewer: RequestedReviewer; add: boolean }
    | { kind: 'label'; name: string; add: boolean };

/** The permissions of a repository that let a user change the assignees, the reviewers and the labels. */
export function canManagePullRequests(permission: string | null | undefined): boolean {
    return ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE'].includes(permission ?? '');
}

/** The permissions of a repository that let a user merge a pull request. */
export function canMergePullRequests(permission: string | null | undefined): boolean {
    return ['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission ?? '');
}

export interface PullRequestCommit {
    oid: string;
    abbreviatedOid: string;
    messageHeadline: string;
    committedDate: string;
    url: string;
    /** The GitHub login of the author, else the name from git. */
    author: string | null;
}

export interface PullRequestFile {
    path: string;
    previousPath?: string;
    /** added, removed, modified, renamed, copied, changed or unchanged. */
    status: string;
    additions: number;
    deletions: number;
    /** True when the user marked the file as viewed, the same state as the "Viewed" box on GitHub. */
    viewed?: boolean;
    /** The "@@" hunks of the change. GitHub leaves them out for a large or binary file. */
    patch?: string;
}

/** The two versions of a file in a pull request. */
export interface FileVersions {
    base: string;
    head: string;
    /** True when a version is too large or is a binary file. */
    unavailable?: boolean;
}

/** A comment that the user wrote and that goes out with the next review. */
export interface PendingComment {
    path: string;
    line: number;
    side: DiffSide;
    body: string;
}

export type CheckStatus = 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'stale' | 'error' | null;

export interface CheckRun {
    /** For a GitHub Actions check, this is also the job ID. */
    id: number;
    name: string;
    status: CheckStatus;
    conclusion: CheckConclusion;
    startedAt: string | null;
    completedAt: string | null;
    url: string | null;
    /** The workflow run ID for a GitHub Actions job. It is undefined for other checks. */
    runId?: number;
    /** True for a GitHub Actions job. Only these have logs and can run again. */
    isActions: boolean;
    /** True for a commit status (the older status API), not a check run. */
    isStatus?: boolean;
}

/** A step of a GitHub Actions job. */
export interface JobStep {
    number: number;
    name: string;
    status: CheckStatus;
    conclusion: CheckConclusion;
    startedAt: string | null;
    completedAt: string | null;
}

/**
 * The live state of a GitHub Actions job: its steps. GitHub updates the steps while the job runs. The log comes only
 * when the job completes.
 */
export interface JobProgress {
    status: CheckStatus;
    conclusion: CheckConclusion;
    startedAt: string | null;
    completedAt: string | null;
    steps: JobStep[];
}

export interface Workflow {
    id: number;
    name: string;
    path: string;
    /** True when the workflow has a `workflow_dispatch` trigger, so the user can start it by hand. */
    dispatchable: boolean;
    /** The inputs of the `workflow_dispatch` trigger. */
    inputs: WorkflowInput[];
}

/** The GitHub state of one worktree. */
export interface BranchStatus {
    repo: RepoRef;
    branch: string;
    /** The commit that the checks belong to: the PR head, or the local HEAD when there is no PR. */
    sha: string;
    pullRequest: PullRequest | null;
}

/**
 * Parses a GitHub remote URL.
 * Accepts git@github.com:owner/name.git, ssh://git@github.com/owner/name and https://github.com/owner/name.git.
 */
export function parseGitHubRemote(url: string): RepoRef | undefined {
    const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
    return match ? { owner: match[1], name: match[2] } : undefined;
}

/** Finds the workflow run ID in the details URL of a GitHub Actions check: .../actions/runs/<run>/job/<job>. */
export function parseActionsRunId(url: string | null | undefined): number | undefined {
    const match = /\/actions\/runs\/(\d+)/.exec(url ?? '');
    return match ? Number(match[1]) : undefined;
}

/**
 * Keeps only the newest check of each name. GitHub returns one check run for each attempt,
 * so a job that ran again shows two times without this filter. A newer check run has a larger ID.
 */
export function latestChecks(checks: readonly CheckRun[]): CheckRun[] {
    const newest = new Map<string, CheckRun>();
    for (const check of checks) {
        const key = `${check.isStatus ? 'status' : 'check'}:${check.name}`;
        const current = newest.get(key);
        if (!current || check.id > current.id) {
            newest.set(key, check);
        }
    }
    return [...newest.values()];
}

/** The pull request and CI state of a branch, for the worktree list. */
export interface BranchSummary {
    number: number;
    title?: string;
    url: string;
    /** The head commit of the PR. */
    headSha?: string;
    isDraft: boolean;
    reviewDecision: ReviewDecision;
    /** The combined state of the checks of the PR head: SUCCESS, FAILURE, ERROR, PENDING or EXPECTED. Null without checks. */
    checks: string | null;
}

/** A summary of the checks of one commit. */
export type CheckSummary = 'success' | 'failure' | 'pending' | 'none';

export function summarizeChecks(checks: readonly CheckRun[]): CheckSummary {
    if (checks.length === 0) {
        return 'none';
    }
    if (checks.some(check => ['failure', 'timed_out', 'cancelled', 'action_required', 'error'].includes(check.conclusion ?? ''))) {
        return 'failure';
    }
    if (checks.some(check => check.status !== 'completed')) {
        return 'pending';
    }
    return 'success';
}

/**
 * Makes a GitHub Actions log easier to read.
 * It removes ANSI escape codes and the timestamp at the start of each line.
 */
export function cleanActionsLog(log: string): string {
    return log
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, ''))
        .join('\n');
}

/** Returns the last lines of a log. An agent prompt does not need the full log. */
export function tailLines(text: string, count: number): string {
    const lines = text.split('\n');
    return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

const ATTACHMENT_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Finds the signed image URLs in HTML that GitHub rendered, by attachment ID.
 * An image of a private repository is a `github.com/user-attachments` link, which works only with a GitHub
 * login session. The rendered HTML has a signed URL for the same image instead. It is valid for some minutes.
 */
export function signedImageUrls(html: string[]): Map<string, string> {
    const urls = new Map<string, string>();
    const pattern = new RegExp(`https://private-user-images\\.githubusercontent\\.com/[^"'\\s<>]*?-(${ATTACHMENT_ID})\\.[A-Za-z0-9]+\\?jwt=[^"'\\s<>]+`, 'g');
    for (const text of html) {
        for (const match of text.matchAll(pattern)) {
            urls.set(match[1], match[0].replace(/&amp;/g, '&'));
        }
    }
    return urls;
}

/** Replaces each `github.com/user-attachments/assets/<id>` link that has a signed URL with that URL. */
export function withSignedImages(text: string, urls: Map<string, string>): string {
    if (urls.size === 0) {
        return text;
    }
    return text.replace(new RegExp(`https://github\\.com/user-attachments/assets/(${ATTACHMENT_ID})`, 'g'), (link, id: string) => urls.get(id) ?? link);
}
