import type { MyPullRequestReason } from './dashboard';

/** The check results of the head commit of a pull request. */
export interface CheckSummary {
    /** The combined state from GitHub, for example SUCCESS, FAILURE or PENDING. Null when the commit has no checks. */
    state: string | null;
    /** The number of checks that failed. */
    failing: number;
    /** The number of checks that did not finish. */
    pending: number;
    /** The number of all checks. */
    total: number;
}

/** The last review of the viewer on a pull request. */
export interface ViewerReview {
    /** APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED. */
    state: string;
    submittedAt: string;
    /** The head commit when the viewer submitted the review. Null when GitHub does not know it. */
    commitOid: string | null;
}

/** The changes on a pull request after the last review of the viewer. */
export interface SinceReview {
    /** The number of new commits. Null when the commit of the review is not in the history (for example after a force push). */
    newCommits: number | null;
    /** The number of review threads that the viewer started. */
    threads: number;
    /** The number of these threads that are resolved. */
    resolved: number;
}

/** An open pull request of a repository, with the data that the Review view needs to sort it. */
export interface OpenPullRequest {
    /** The GraphQL node ID. */
    id: string;
    number: number;
    title: string;
    url: string;
    author: string | null;
    isDraft: boolean;
    createdAt: string;
    updatedAt: string;
    headRefName: string;
    baseRefName: string;
    headRefOid: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    comments: number;
    viewerDidAuthor: boolean;
    /** True when GitHub asks the viewer, or a team of the viewer, for a review. */
    reviewRequested: boolean;
    reviewDecision: string | null;
    checks: CheckSummary;
    viewerReview?: ViewerReview;
    sinceReview?: SinceReview;
    /** The reasons that the author must act. Only set for pull requests of the viewer. */
    actions: MyPullRequestReason[];
}

/** The open pull requests of one repository. */
export interface RepoPullRequests {
    /** The login of the viewer. */
    viewer: string;
    /** The number of open pull requests. It can be larger than the length of `pullRequests`. */
    openCount: number;
    pushedAt?: string;
    pullRequests: OpenPullRequest[];
}

/**
 * The group of an open pull request for the viewer.
 * - `new`: the viewer must review it and did not review it before.
 * - `re-review`: the viewer reviewed it before, and GitHub asks again. Or the viewer requested changes, and the head
 *   commit changed after that review.
 * - `waiting`: the viewer reviewed it and the head commit did not change since. The author must act.
 * - `mine`: the viewer is the author.
 * - `other`: the pull request does not need the viewer.
 */
export type ReviewGroup = 'new' | 're-review' | 'waiting' | 'mine' | 'other';

/** Returns the group of a pull request. A draft needs the viewer only when GitHub asks for a review. */
export function reviewGroup(pr: OpenPullRequest): ReviewGroup {
    if (pr.viewerDidAuthor) return 'mine';
    const reviewed = !!pr.viewerReview && pr.viewerReview.state !== 'PENDING';
    if (pr.reviewRequested) return reviewed ? 're-review' : 'new';
    if (!reviewed || pr.isDraft) return 'other';
    const review = pr.viewerReview!;
    const changed = !!review.commitOid && review.commitOid !== pr.headRefOid;
    if (!changed) return 'waiting';
    // A comment of long ago with new commits after it does not ask for a new review.
    return review.state === 'CHANGES_REQUESTED' ? 're-review' : 'other';
}

/** True when the pull request waits for a review of the viewer. */
export function needsReview(pr: OpenPullRequest): boolean {
    const group = reviewGroup(pr);
    return group === 'new' || group === 're-review';
}

/** True when the pull request is of the viewer and the viewer must act on it. */
export function needsAuthor(pr: OpenPullRequest): boolean {
    return pr.viewerDidAuthor && pr.actions.length > 0;
}

/** The check states that count as a failed check. */
const FAILED_STATES = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);
/** The check states that count as a check that did not finish. */
const PENDING_STATES = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

/** Makes a check summary from the counts by state of GitHub. */
export function checkSummary(state: string | null, counts: { state: string; count: number }[]): CheckSummary {
    let failing = 0;
    let pending = 0;
    let total = 0;
    for (const item of counts) {
        total += item.count;
        if (FAILED_STATES.has(item.state)) failing += item.count;
        if (PENDING_STATES.has(item.state)) pending += item.count;
    }
    // Some rollups have a state but no counts. Then the state gives one check.
    if (total === 0 && state) {
        total = 1;
        if (FAILED_STATES.has(state)) failing = 1;
        if (PENDING_STATES.has(state)) pending = 1;
    }
    return { state, failing, pending, total };
}

/** The checks of a pull request as one word, for the color and the icon. */
export type CheckLevel = 'failing' | 'running' | 'passing' | 'none';

export function checkLevel(checks: CheckSummary): CheckLevel {
    if (checks.failing > 0 || checks.state === 'FAILURE' || checks.state === 'ERROR') return 'failing';
    if (checks.pending > 0 || checks.state === 'PENDING' || checks.state === 'EXPECTED') return 'running';
    if (checks.total > 0 || checks.state === 'SUCCESS') return 'passing';
    return 'none';
}

/**
 * Returns the number of commits after `oid` in `history` (oldest first).
 * Returns null when `oid` is not in the history.
 */
export function commitsAfter(history: string[], oid: string | null): number | null {
    if (!oid) return null;
    const index = history.lastIndexOf(oid);
    return index === -1 ? null : history.length - 1 - index;
}

/** The numbers of one repository on the entry page of the Review view. */
export interface RepoReviewSummary {
    /** The pull requests that the viewer did not review before. */
    toReview: number;
    /** The pull requests to review again. */
    reReview: number;
    /** The pull requests of the viewer that need an action of the viewer. */
    yourPrs: number;
    /** The creation time of the oldest pull request in the three groups. Undefined when the groups are empty. */
    oldest?: string;
    /** The number of pull requests in the three groups with failed checks. */
    failing: number;
    /** The number of pull requests in the three groups with checks that did not finish. */
    running: number;
    /** The number of pull requests in the three groups with passed checks. */
    passing: number;
    openCount: number;
    /** The time of the newest update of an open pull request, or of the last push. */
    lastActivity?: string;
}

export function summarizeRepo(data: RepoPullRequests): RepoReviewSummary {
    const summary: RepoReviewSummary = { toReview: 0, reReview: 0, yourPrs: 0, failing: 0, running: 0, passing: 0, openCount: data.openCount };
    for (const pr of data.pullRequests) {
        const group = reviewGroup(pr);
        if (group === 'new') summary.toReview++;
        else if (group === 're-review') summary.reReview++;
        else if (needsAuthor(pr)) summary.yourPrs++;
        else continue;
        if (!summary.oldest || pr.createdAt < summary.oldest) summary.oldest = pr.createdAt;
        const level = checkLevel(pr.checks);
        if (level === 'failing') summary.failing++;
        if (level === 'running') summary.running++;
        if (level === 'passing') summary.passing++;
    }
    const times = [data.pushedAt, ...data.pullRequests.map(pr => pr.updatedAt)].filter((value): value is string => !!value);
    summary.lastActivity = times.sort().at(-1);
    return summary;
}

/** True when the repository has something for the viewer. */
export function isWaiting(summary: RepoReviewSummary): boolean {
    return summary.toReview + summary.reReview + summary.yourPrs > 0;
}

/** The orders of the pull request list of a repository. */
export type PullRequestSort = 'waiting' | 'updated' | 'smallest';

export const PULL_REQUEST_SORTS: { id: PullRequestSort; label: string }[] = [
    { id: 'waiting', label: 'Longest waiting' },
    { id: 'updated', label: 'Recently updated' },
    { id: 'smallest', label: 'Smallest first' }
];

/** Returns a sorted copy of the pull requests. Equal items keep the newest number first. */
export function sortPullRequests<T extends Pick<OpenPullRequest, 'number' | 'createdAt' | 'updatedAt' | 'additions' | 'deletions'>>(prs: T[], sort: PullRequestSort): T[] {
    const compare: Record<PullRequestSort, (a: T, b: T) => number> = {
        waiting: (a, b) => a.createdAt.localeCompare(b.createdAt),
        updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
        smallest: (a, b) => (a.additions + a.deletions) - (b.additions + b.deletions)
    };
    return [...prs].sort((a, b) => compare[sort](a, b) || b.number - a.number);
}

/**
 * True when the pull request matches all words of the search. A word matches the title, the author, the branch,
 * or the number ("123" or "#123"). The match ignores case.
 */
export function matchesSearch(pr: Pick<OpenPullRequest, 'number' | 'title' | 'author' | 'headRefName'>, query: string): boolean {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const text = `${pr.title}\n${pr.author ?? ''}\n${pr.headRefName}`.toLowerCase();
    return words.every(word => {
        const number = /^#?(\d+)$/.exec(word);
        if (number && String(pr.number) === number[1]) return true;
        return text.includes(word);
    });
}

/** The size class of a diff: a small, a medium and a large change. */
export type DiffSize = 'small' | 'medium' | 'large';

/** Returns the size class and the bar fill (0 to 1) of a diff. The fill uses a log scale up to 2000 changed lines. */
export function diffSize(additions: number, deletions: number): { size: DiffSize; fill: number } {
    const lines = additions + deletions;
    const size: DiffSize = lines < 300 ? 'small' : lines < 1000 ? 'medium' : 'large';
    const fill = lines <= 0 ? 0 : Math.min(1, Math.log10(lines + 1) / Math.log10(2001));
    return { size, fill };
}

/** The age class of a waiting pull request: no color, a warning after 5 days, and an alert after 14 days. */
export function ageLevel(iso: string, now = Date.now()): 'fresh' | 'old' | 'stale' {
    const days = (now - Date.parse(iso)) / 86_400_000;
    return days >= 14 ? 'stale' : days >= 5 ? 'old' : 'fresh';
}

/** An item of the review queue: a pull request to review, in any repository. */
export interface QueueItem {
    /** "owner/name". */
    repo: string;
    number: number;
    createdAt: string;
}

/** Returns the review queue: the pull requests to review in all repositories, the oldest first. */
export function reviewQueue(repos: Map<string, RepoPullRequests>): QueueItem[] {
    const items: QueueItem[] = [];
    for (const [repo, data] of repos) {
        for (const pr of data.pullRequests) {
            if (needsReview(pr)) items.push({ repo, number: pr.number, createdAt: pr.createdAt });
        }
    }
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.repo.localeCompare(b.repo) || a.number - b.number);
}
