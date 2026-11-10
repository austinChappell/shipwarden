import { hostLabel, undecidedCount, type PendingComment, type PullRequest, type PullRequestFile, type ReviewEvent, type ReviewThread } from '@shared/github';

/** The review events of GitHub, in the order of the buttons. */
export const GITHUB_REVIEW_EVENTS: ReviewEvent[] = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];

/** The text of each review event in the confirmation and on its button. */
export const REVIEW_EVENT_TEXT: Record<ReviewEvent, { confirm: string; button: string }> = {
    COMMENT: { confirm: 'comment on', button: 'Comment' },
    REQUEST_CHANGES: { confirm: 'request changes on', button: 'Request changes' },
    APPROVE: { confirm: 'approve', button: 'Approve' },
    APPROVE_WITH_SUGGESTIONS: { confirm: 'approve with suggestions', button: 'Approve with suggestions' },
    WAIT_FOR_AUTHOR: { confirm: 'wait for the author on', button: 'Wait for author' },
    REJECT: { confirm: 'reject', button: 'Reject' }
};

/**
 * Returns the review events that the user can send, in the order of the buttons.
 * The author of a pull request can only comment on it.
 */
export function reviewEvents(pr: PullRequest): ReviewEvent[] {
    return (pr.reviewEvents ?? GITHUB_REVIEW_EVENTS).filter(event => event === 'COMMENT' || !pr.viewerDidAuthor);
}

/**
 * Returns the events that show as buttons. The Overview tab shows only the decisions.
 * A comment then needs ⌘↵, unless it is the only choice.
 */
export function decisionEvents(events: ReviewEvent[], overview: boolean): ReviewEvent[] {
    return overview && events.some(event => event !== 'COMMENT') ? events.filter(event => event !== 'COMMENT') : events;
}

/** The input for the state of the review buttons. */
export interface ReviewInput {
    events: ReviewEvent[];
    /** The text of the review. */
    body: string;
    pending: PendingComment[];
    /** True while an action runs. */
    busy: boolean;
}

/** The state of the review buttons. */
export interface ReviewButtons {
    /** The count of agent comments that the user did not accept or remove. */
    undecided: number;
    /** True when the "Comment" button is on. A comment needs text or a pending comment. */
    canComment: boolean;
    /** True when the decision buttons are on, for example "Approve". */
    canDecide: boolean;
}

/** Returns which review buttons are on. An agent comment without a decision stops all reviews. */
export function reviewButtons({ events, body, pending, busy }: ReviewInput): ReviewButtons {
    const undecided = undecidedCount(pending);
    const canComment = events.includes('COMMENT') && !busy && undecided === 0 && (!!body.trim() || pending.length > 0);
    return { undecided, canComment, canDecide: !busy && undecided === 0 };
}

/** Returns the first agent comment without a decision, and its file in the loaded file list. */
export function firstUndecided(
    pending: PendingComment[],
    files: PullRequestFile[] | undefined
): { comment: PendingComment; file: PullRequestFile | undefined } | undefined {
    const comment = pending.find(item => item.needsDecision);
    return comment && { comment, file: files?.find(file => file.path === comment.path) };
}

/** A pending comment in the list that the ↑ and ↓ buttons go through. */
export interface PendingStop {
    comment: PendingComment;
    /** The count of pending comments before this comment on the same line and side. */
    nth: number;
}

/**
 * Returns the pending comments in the order of the files and then of the lines.
 * A comment on a file that is not in the list goes to the end.
 * Comments on the same line keep their order.
 */
export function pendingOrder(pending: PendingComment[], files: PullRequestFile[] | undefined): PendingStop[] {
    const fileIndex = new Map((files ?? []).map((file, index) => [file.path, index]));
    const position = (comment: PendingComment) => fileIndex.get(comment.path) ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...pending].sort((a, b) => position(a) - position(b) || a.path.localeCompare(b.path) || a.line - b.line);
    const seen = new Map<string, number>();
    return sorted.map(comment => {
        const key = `${comment.path}\n${comment.side}\n${comment.line}`;
        const nth = seen.get(key) ?? 0;
        seen.set(key, nth + 1);
        return { comment, nth };
    });
}

/**
 * Returns the index of the next or the previous pending comment. The list wraps at the two ends.
 * Without a current index, ↓ goes to the first comment and ↑ goes to the last comment.
 */
export function nextPendingIndex(index: number | undefined, count: number, step: 1 | -1): number {
    if (index === undefined) return step === 1 ? 0 : count - 1;
    return (Math.min(index, count - 1) + step + count) % count;
}

/** The question before the user submits a review. */
export function reviewConfirmTitle(pr: PullRequest, event: ReviewEvent, pendingCount: number): string {
    const pending = pendingCount ? ` with ${pendingCount} inline comment(s)` : '';
    return `Submit a review to ${hostLabel(pr.host)}: ${REVIEW_EVENT_TEXT[event].confirm} pull request #${pr.number}${pending}?`;
}

/** The text of the label that counts the pending comments. */
export function pendingText(count: number): string {
    return `${count} pending comment${count === 1 ? '' : 's'}`;
}

/** The note that tells the user to decide on the agent comments. */
export function undecidedText(count: number): string {
    return `Accept or remove the ${count} agent comment${count === 1 ? '' : 's'} that you did not check yet. Then you can submit your review.`;
}

/** Returns the count of open threads and pending comments on a file. */
export function openCommentCount(threads: ReviewThread[], pending: PendingComment[], path: string): number {
    return threads.filter(thread => thread.path === path && !thread.isResolved).length + pending.filter(comment => comment.path === path).length;
}

/** Returns the threads that the panel shows. A resolved thread shows only when `showResolved` is true. */
export function visibleThreads(threads: ReviewThread[], showResolved: boolean): ReviewThread[] {
    return threads.filter(thread => showResolved || !thread.isResolved);
}

/** Returns the IDs of the comments, reviews and visible thread comments of a pull request. The panel marks them as seen. */
export function shownCommentIds(pr: PullRequest, showResolved: boolean): string[] {
    return [
        ...pr.issueComments.map(comment => comment.id),
        ...pr.reviews.map(item => item.id),
        ...visibleThreads(pr.threads, showResolved).flatMap(thread => thread.comments.map(comment => comment.id))
    ];
}

export interface ConversationItem {
    id: string;
    author: string | null;
    body: string;
    createdAt: string;
    state?: string;
}

/** The comments and reviews of the conversation, the oldest first. A review without text or decision is left out. */
export function conversationOf(pr: PullRequest): ConversationItem[] {
    return [
        ...pr.issueComments.map(comment => ({ id: comment.id, author: comment.author?.login ?? null, body: comment.body, createdAt: comment.createdAt })),
        ...pr.reviews
            .filter(review => review.body.trim() || (review.state !== 'COMMENTED' && review.state !== 'DISMISSED'))
            .map(review => ({
                id: review.id,
                author: review.author?.login ?? null,
                body: review.body,
                createdAt: review.submittedAt ?? '',
                state: review.state
            }))
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
