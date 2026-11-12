import type { MergeMethod, RepoRef } from './github';
import type { HiddenCommentRule } from './settings';
import { formatAge } from './format';

/** The Dashboard shows comments from this number of days. Older comments do not count as new. */
export const DASHBOARD_WINDOW_DAYS = 7;

/**
 * A pull request that waits for a review of the user. GitHub asks the user, or a team of the user, for a review.
 * Or the user reviewed it before, and it has new activity after that review.
 */
export interface ReviewRequestItem {
    repo: RepoRef;
    number: number;
    title: string;
    url: string;
    author: string | null;
    updatedAt: string;
    createdAt: string;
    /** Set when the item shows because of new activity after the review of the user, and not because of a request. */
    activity?: ReviewActivity;
}

/** The new activity on a pull request after the last review of the user. */
export interface ReviewActivity {
    /** The state of the last review of the user, for example COMMENTED or APPROVED. */
    reviewState: string;
    reviewedAt: string;
    /** True when the head commit changed after the review. */
    newCommits: boolean;
    /** The time of the newest comment or review from another person after the review. */
    lastCommentAt?: string;
    /** The key that "Mark as seen" records. New activity gives a new key. */
    seenKey: string;
}

export type MyPullRequestReason = 'changes-requested' | 'ci-failing' | 'conflicts' | 'ready-to-merge';

/** An open pull request of the user that needs an action from the user. */
export interface MyPullRequestItem {
    repo: RepoRef;
    number: number;
    title: string;
    url: string;
    updatedAt: string;
    createdAt?: string;
    reasons: MyPullRequestReason[];
    /** The head commit. A merge from the Dashboard sends it, so GitHub refuses the merge after a new push. */
    headSha?: string;
    /** The merge method that the user used last in the repository. */
    mergeMethod?: MergeMethod;
    /** The number of review threads that are not resolved. */
    unresolvedThreads?: number;
}

/** A comment or a review on a pull request, from another person. */
export interface PullRequestCommentItem {
    /** The GraphQL node ID of the comment or review. */
    id: string;
    repo: RepoRef;
    number: number;
    prTitle: string;
    prUrl: string;
    author: string;
    /** The comment as plain text, for the short preview. */
    text: string;
    /** The comment as HTML that GitHub rendered. It has signed URLs for images. */
    html: string;
    createdAt: string;
    url: string;
    /** The file of a review comment. */
    path?: string;
    /** The state of a review, for example APPROVED or CHANGES_REQUESTED. */
    reviewState?: string;
    /** The state of the pull request: OPEN, CLOSED or MERGED. */
    prState?: string;
}

/** Returns true when the item approves a pull request that is merged. The user does not need to see it. */
export function isMergedApproval(item: Pick<PullRequestCommentItem, 'reviewState' | 'prState'>): boolean {
    return item.reviewState === 'APPROVED' && item.prState === 'MERGED';
}

/** The pull requests of the Dashboard. They load fast, so the Dashboard shows them before the comments. */
export interface DashboardPullRequests {
    reviewRequests: ReviewRequestItem[];
    myPullRequests: MyPullRequestItem[];
}

/** A comment on a task, from another person. A task plugin returns it from "activity/list". */
export interface TaskCommentItem {
    id: string;
    taskId: string;
    taskKey?: string;
    taskTitle: string;
    taskUrl?: string;
    author?: string;
    body: string;
    createdAt: string;
}

/** The state of the pull request that `myPullRequestReasons` reads. */
export interface PullRequestActionState {
    isDraft: boolean;
    reviewDecision: string | null;
    mergeable: string;
    mergeStateStatus: string;
    checks: string | null;
}

/**
 * Returns the reasons that the user must act on their own pull request.
 * A pull request without a reason waits for other people, so the Dashboard does not show it.
 */
export function myPullRequestReasons(pr: PullRequestActionState): MyPullRequestReason[] {
    const reasons: MyPullRequestReason[] = [];
    if (pr.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes-requested');
    if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') reasons.push('ci-failing');
    if (pr.mergeable === 'CONFLICTING') reasons.push('conflicts');
    const checksOk = pr.checks === null || pr.checks === 'SUCCESS';
    if (!pr.isDraft && pr.reviewDecision === 'APPROVED' && checksOk && pr.mergeable === 'MERGEABLE' && reasons.length === 0) {
        reasons.push('ready-to-merge');
    }
    return reasons;
}

export const MY_PULL_REQUEST_REASON_LABELS: Record<MyPullRequestReason, string> = {
    'changes-requested': 'Changes requested',
    'ci-failing': 'CI failing',
    conflicts: 'Merge conflicts',
    'ready-to-merge': 'Ready to merge'
};

/** The search qualifiers for the owners of Settings > Code review. No qualifier means all owners. */
export function ownerQualifiers(owners: string[] | 'all' | undefined): string {
    return Array.isArray(owners) ? owners.map(owner => `user:${owner}`).join(' ') : '';
}

/** The settings that hide comments on the Dashboard. */
export interface CommentFilter {
    hiddenAuthors?: string[];
    hiddenRules?: HiddenCommentRule[];
}

/** Returns the regular expression of a rule, or an error message when the expression is not valid. */
export function ruleRegex(text: string): RegExp | string {
    try {
        return new RegExp(text, 'i');
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/** True when a comment matches a rule. Leading and trailing space of the comment is ignored. */
export function matchesRule(rule: HiddenCommentRule, author: string | undefined, text: string): boolean {
    if (rule.author && rule.author.toLowerCase() !== (author ?? '').toLowerCase()) {
        return false;
    }
    const body = text.trim().toLowerCase();
    const wanted = rule.text.trim().toLowerCase();
    switch (rule.match) {
        case 'startsWith':
            return body.startsWith(wanted);
        case 'contains':
            return body.includes(wanted);
        case 'regex': {
            const regex = ruleRegex(rule.text);
            return typeof regex !== 'string' && regex.test(text.trim());
        }
    }
}

/** True when the Dashboard must not show the comment: its author is hidden, or it matches a rule. */
export function isHiddenComment(author: string | undefined, text: string, filter: CommentFilter): boolean {
    return isHiddenAuthor(author, filter.hiddenAuthors) || (filter.hiddenRules ?? []).some(rule => matchesRule(rule, author, text));
}

/** True when the Dashboard must not show comments from this author (Settings > Dashboard). */
export function isHiddenAuthor(author: string | undefined, hidden: string[] | undefined): boolean {
    if (!author || !hidden?.length) return false;
    const name = author.toLowerCase();
    return hidden.some(item => item.toLowerCase() === name);
}

/** The key of a GitHub comment or review in the record of seen items. */
export function gitHubSeenKey(id: string): string {
    return `gh:${id}`;
}

/** The key of a task comment in the record of seen items. */
export function taskSeenKey(connectionId: string, commentId: string): string {
    return `task:${connectionId}:${commentId}`;
}

/** A comment of a pull request, for the filter `newComments`. */
export interface RawComment {
    id: string;
    author: string | null;
    isBot: boolean;
    createdAt: string;
}

/**
 * Returns the comments that are new for the viewer: from other people (not bots), newer than `since`,
 * and newer than the last comment or review of the viewer on the same pull request. A reply shows that the
 * viewer saw the comments before it.
 */
export function newComments<T extends RawComment>(comments: T[], viewer: string, since: Date): T[] {
    const viewerName = viewer.toLowerCase();
    let lastOwn = 0;
    for (const comment of comments) {
        if (comment.author?.toLowerCase() === viewerName) {
            lastOwn = Math.max(lastOwn, Date.parse(comment.createdAt));
        }
    }
    const after = Math.max(since.getTime(), lastOwn);
    return comments.filter(
        comment => !comment.isBot && !!comment.author && comment.author.toLowerCase() !== viewerName && Date.parse(comment.createdAt) > after
    );
}

/** The order of the groups of the user's pull requests: the most urgent action first. */
export const MY_PULL_REQUEST_GROUP_ORDER: readonly MyPullRequestReason[] = ['changes-requested', 'conflicts', 'ci-failing', 'ready-to-merge'];

/** Returns the group of a pull request: its most urgent reason. */
export function myPullRequestGroup(reasons: MyPullRequestReason[]): MyPullRequestReason {
    return MY_PULL_REQUEST_GROUP_ORDER.find(reason => reasons.includes(reason)) ?? 'ready-to-merge';
}

/** A pull request title, split for a list that is easy to scan. */
export interface ParsedTitle {
    /** The ticket ID, in capitals, for example "ABC-1201" or "CU-12ABC3X". */
    ticket?: string;
    /** The title without the commit type ("fix:") and without the ticket. */
    text: string;
}

const TYPE_PREFIX = /^(feat|fix|chore|refactor|docs|test|tests|perf|build|ci|style|revert|hotfix)(\([^)]*\))?!?\s*:\s*/i;
const TICKET = '(?:[A-Z][A-Z0-9]+-\\d+|CU-[a-z0-9]+)';
const SEPARATOR = '\\s*[:—–|-]\\s*';

/**
 * Splits a title into its ticket ID and its text, for one column of ticket IDs. The commit type ("fix:", "feat(api):")
 * is removed. The ticket is taken from the start ("ENG-1: text", "eng-1 — text") or from brackets anywhere ("text
 * (ENG-1)", "text [CU-abc]"). A ticket in the middle of the text stays in the text.
 */
export function parsePullRequestTitle(title: string): ParsedTitle {
    let text = title.trim().replace(TYPE_PREFIX, '');
    const leading = new RegExp(`^\\[?(${TICKET})\\]?(?:${SEPARATOR}|\\s+)`, 'i').exec(text);
    if (leading) {
        return { ticket: leading[1].toUpperCase(), text: text.slice(leading[0].length).trim() || text };
    }
    const bracketed = new RegExp(`\\s*[([](${TICKET})[)\\]]`, 'i').exec(text);
    if (bracketed) {
        text = (text.slice(0, bracketed.index) + text.slice(bracketed.index + bracketed[0].length)).trim();
        return { ticket: bracketed[1].toUpperCase(), text };
    }
    return { text };
}

/** A short age for a column: "5m", "3h", "2d", "6w". It is `formatAge` of shared/format.ts. */
export function shortAge(iso: string, now = Date.now()): string {
    return formatAge(iso, now);
}

/** A pull request of the user with no update in this number of days is stale. */
export const DASHBOARD_STALE_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;

/** True when the pull request has no update in `DASHBOARD_STALE_DAYS` days. */
export function isStalePullRequest(pr: Pick<MyPullRequestItem, 'updatedAt'>, now = Date.now()): boolean {
    return now - Date.parse(pr.updatedAt) >= DASHBOARD_STALE_DAYS * DAY_MS;
}

/** The cards of the user's pull requests on the Dashboard. */
export interface MyPullRequestBuckets {
    ready: MyPullRequestItem[];
    changes: MyPullRequestItem[];
    /** CI fails or the branch has merge conflicts. */
    blocked: MyPullRequestItem[];
    stale: MyPullRequestItem[];
}

/**
 * Puts each pull request of the user in one card. A stale pull request goes to `stale`, whatever its reasons.
 * The other pull requests go to the card of their most urgent reason.
 */
export function bucketMyPullRequests(prs: MyPullRequestItem[], now = Date.now()): MyPullRequestBuckets {
    const buckets: MyPullRequestBuckets = { ready: [], changes: [], blocked: [], stale: [] };
    for (const pr of prs) {
        if (isStalePullRequest(pr, now)) {
            buckets.stale.push(pr);
            continue;
        }
        const group = myPullRequestGroup(pr.reasons);
        if (group === 'ready-to-merge') buckets.ready.push(pr);
        else if (group === 'changes-requested') buckets.changes.push(pr);
        else buckets.blocked.push(pr);
    }
    // The newest update first in the active cards. The oldest first in the stale card.
    const newest = (a: MyPullRequestItem, b: MyPullRequestItem) => b.updatedAt.localeCompare(a.updatedAt);
    buckets.ready.sort(newest);
    buckets.changes.sort(newest);
    buckets.blocked.sort(newest);
    buckets.stale.sort((a, b) => -newest(a, b));
    return buckets;
}

/** The urgency of an age, for its color: "fresh" under 7 days, "aging" under 21 days, "old" after. */
export function ageLevel(iso: string, now = Date.now()): 'fresh' | 'aging' | 'old' {
    const days = (now - Date.parse(iso)) / DAY_MS;
    if (days < 7) return 'fresh';
    if (days < 21) return 'aging';
    return 'old';
}

/** The fields that the Dashboard filter compares with the query. */
export interface FilterablePullRequest {
    title: string;
    repo: RepoRef;
    number: number;
    author?: string | null;
}

/**
 * True when the pull request matches the filter text of the Dashboard. Each word of the query must be in the title,
 * the ticket, the repository, the number ("#12") or the author. The comparison ignores case.
 */
export function matchesDashboardQuery(pr: FilterablePullRequest, query: string): boolean {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const ticket = parsePullRequestTitle(pr.title).ticket ?? '';
    const haystack = [pr.title, ticket, pr.repo.owner, pr.repo.name, `#${pr.number}`, pr.author ?? ''].join(' ').toLowerCase();
    return words.every(word => haystack.includes(word));
}

export type ReviewSort = 'author' | 'oldest' | 'repo';

/** A group of review requests: an author or a repository. A list without groups has one group with an empty key. */
export interface ReviewGroup<T> {
    key: string;
    items: T[];
}

/**
 * Sorts the review requests for the Dashboard. "author" and "repo" make groups, the largest group first, and the
 * newest item first in each group. "oldest" makes one list, the oldest item first. The age is the creation time.
 */
export function groupReviewRequests<T extends { author: string | null; repo: RepoRef; createdAt: string }>(items: T[], sort: ReviewSort): ReviewGroup<T>[] {
    const oldest = (a: T, b: T) => a.createdAt.localeCompare(b.createdAt);
    if (sort === 'oldest') return items.length ? [{ key: '', items: [...items].sort(oldest) }] : [];
    const keyOf = (item: T) => (sort === 'author' ? (item.author ?? 'unknown') : item.repo.name);
    const groups = new Map<string, T[]>();
    for (const item of items) {
        groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
    }
    return [...groups.entries()]
        .map(([key, list]) => ({ key, items: list.sort((a, b) => -oldest(a, b)) }))
        .sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
}
