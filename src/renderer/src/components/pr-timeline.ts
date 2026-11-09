import type { IssueComment, PullRequest, PullRequestCommit, Review, TimelineEvent } from '@shared/github';

/** One row of the activity timeline on the Overview tab. */
export type TimelineItem =
    | { type: 'comment'; id: string; createdAt: string; comment: IssueComment }
    | { type: 'review'; id: string; createdAt: string; review: Review }
    /** Commits that follow each other in the timeline. GitHub shows them as one group. */
    | { type: 'commits'; id: string; createdAt: string; commits: PullRequestCommit[] }
    | { type: 'event'; id: string; createdAt: string; event: TimelineEvent };

/**
 * Merges the comments, the reviews, the commits and the events of a pull request into one list, the oldest first.
 * A review without text and without a decision is left out, because its comments show in the review threads.
 */
export function buildTimeline(pr: PullRequest): TimelineItem[] {
    const items: TimelineItem[] = [
        ...pr.issueComments.map((comment): TimelineItem => ({ type: 'comment', id: comment.id, createdAt: comment.createdAt, comment })),
        ...pr.reviews
            .filter(review => review.body.trim() || (review.state !== 'COMMENTED' && review.state !== 'DISMISSED'))
            .map((review): TimelineItem => ({ type: 'review', id: review.id, createdAt: review.submittedAt ?? '', review })),
        ...pr.commits.map((commit): TimelineItem => ({ type: 'commits', id: commit.oid, createdAt: commit.committedDate, commits: [commit] })),
        ...(pr.timeline ?? []).map((event): TimelineItem => ({ type: 'event', id: event.id, createdAt: event.createdAt, event }))
    ];
    // A stable sort keeps the order of items with the same time.
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const merged: TimelineItem[] = [];
    for (const item of items) {
        const last = merged[merged.length - 1];
        if (item.type === 'commits' && last?.type === 'commits') {
            merged[merged.length - 1] = { ...last, commits: [...last.commits, ...item.commits] };
        } else {
            merged.push(item);
        }
    }
    return merged;
}
