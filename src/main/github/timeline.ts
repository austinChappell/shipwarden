import type { GitHubLabel, TimelineEvent } from '@shared/github';

/**
 * The events of a pull request. The query is separate from the pull request query.
 * If an older GitHub Enterprise server does not know an event type, only the timeline fails.
 */
export const TIMELINE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(last: 100, itemTypes: [
        ASSIGNED_EVENT, UNASSIGNED_EVENT, LABELED_EVENT, UNLABELED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT,
        CLOSED_EVENT, REOPENED_EVENT, MERGED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, RENAMED_TITLE_EVENT,
        HEAD_REF_FORCE_PUSHED_EVENT, HEAD_REF_DELETED_EVENT, HEAD_REF_RESTORED_EVENT, BASE_REF_CHANGED_EVENT,
        AUTO_MERGE_ENABLED_EVENT, AUTO_MERGE_DISABLED_EVENT, REVIEW_DISMISSED_EVENT, CROSS_REFERENCED_EVENT
      ]) {
        nodes {
          __typename
          ... on Node { id }
          ... on AssignedEvent { createdAt actor { login } assignee { ... on Actor { login } } }
          ... on UnassignedEvent { createdAt actor { login } assignee { ... on Actor { login } } }
          ... on LabeledEvent { createdAt actor { login } label { name color } }
          ... on UnlabeledEvent { createdAt actor { login } label { name color } }
          ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on Actor { login } ... on Team { slug name } } }
          ... on ReviewRequestRemovedEvent { createdAt actor { login } requestedReviewer { ... on Actor { login } ... on Team { slug name } } }
          ... on ClosedEvent { createdAt actor { login } }
          ... on ReopenedEvent { createdAt actor { login } }
          ... on MergedEvent { createdAt actor { login } mergeRefName commit { abbreviatedOid url } }
          ... on ReadyForReviewEvent { createdAt actor { login } }
          ... on ConvertToDraftEvent { createdAt actor { login } }
          ... on RenamedTitleEvent { createdAt actor { login } previousTitle currentTitle }
          ... on HeadRefForcePushedEvent { createdAt actor { login } beforeCommit { abbreviatedOid } afterCommit { abbreviatedOid } }
          ... on HeadRefDeletedEvent { createdAt actor { login } headRefName }
          ... on HeadRefRestoredEvent { createdAt actor { login } }
          ... on BaseRefChangedEvent { createdAt actor { login } previousRefName currentRefName }
          ... on AutoMergeEnabledEvent { createdAt actor { login } }
          ... on AutoMergeDisabledEvent { createdAt actor { login } }
          ... on ReviewDismissedEvent { createdAt actor { login } dismissalMessage review { author { login } } }
          ... on CrossReferencedEvent {
            createdAt actor { login }
            source { ... on Issue { number title url repository { nameWithOwner } } ... on PullRequest { number title url repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

/** One node of `timelineItems`. Each event type has only some of the fields. */
export interface GraphQlTimelineNode {
    __typename: string;
    id: string;
    createdAt: string;
    actor?: { login: string } | null;
    assignee?: { login?: string } | null;
    label?: GitHubLabel | null;
    requestedReviewer?: { login?: string; slug?: string; name?: string } | null;
    mergeRefName?: string;
    commit?: { abbreviatedOid: string; url: string } | null;
    previousTitle?: string;
    currentTitle?: string;
    beforeCommit?: { abbreviatedOid: string } | null;
    afterCommit?: { abbreviatedOid: string } | null;
    headRefName?: string;
    previousRefName?: string;
    currentRefName?: string;
    dismissalMessage?: string | null;
    review?: { author: { login: string } | null } | null;
    source?: { number?: number; title?: string; url?: string; repository?: { nameWithOwner: string } } | null;
}

export interface GraphQlTimeline {
    repository: { pullRequest: { timelineItems: { nodes: (GraphQlTimelineNode | null)[] } } | null };
}

const SIMPLE_KINDS: Record<string, TimelineEvent['kind']> = {
    ClosedEvent: 'closed',
    ReopenedEvent: 'reopened',
    ReadyForReviewEvent: 'readyForReview',
    ConvertToDraftEvent: 'convertToDraft',
    AutoMergeEnabledEvent: 'autoMergeEnabled',
    AutoMergeDisabledEvent: 'autoMergeDisabled',
    HeadRefRestoredEvent: 'headRefRestored'
};

/** Converts one GraphQL node to an event. Returns null for a node that the UI cannot show. */
function mapNode(node: GraphQlTimelineNode): TimelineEvent | null {
    const base = { id: node.id, createdAt: node.createdAt, actor: node.actor?.login ?? null };
    const reviewer = node.requestedReviewer?.login ?? node.requestedReviewer?.slug;
    switch (node.__typename) {
        case 'AssignedEvent':
        case 'UnassignedEvent':
            return node.assignee?.login ? { ...base, kind: node.__typename === 'AssignedEvent' ? 'assigned' : 'unassigned', user: node.assignee.login } : null;
        case 'LabeledEvent':
        case 'UnlabeledEvent':
            return node.label ? { ...base, kind: node.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled', label: node.label } : null;
        case 'ReviewRequestedEvent':
        case 'ReviewRequestRemovedEvent':
            return reviewer ? { ...base, kind: node.__typename === 'ReviewRequestedEvent' ? 'reviewRequested' : 'reviewRequestRemoved', reviewer } : null;
        case 'MergedEvent':
            return { ...base, kind: 'merged', commit: node.commit?.abbreviatedOid ?? null, commitUrl: node.commit?.url ?? null, base: node.mergeRefName ?? '' };
        case 'RenamedTitleEvent':
            return { ...base, kind: 'renamed', from: node.previousTitle ?? '', to: node.currentTitle ?? '' };
        case 'HeadRefForcePushedEvent':
            return { ...base, kind: 'forcePushed', before: node.beforeCommit?.abbreviatedOid ?? null, after: node.afterCommit?.abbreviatedOid ?? null };
        case 'HeadRefDeletedEvent':
            return { ...base, kind: 'headRefDeleted', branch: node.headRefName ?? '' };
        case 'BaseRefChangedEvent':
            return { ...base, kind: 'baseChanged', from: node.previousRefName ?? '', to: node.currentRefName ?? '' };
        case 'ReviewDismissedEvent':
            return { ...base, kind: 'reviewDismissed', reviewer: node.review?.author?.login ?? null, message: node.dismissalMessage ?? null };
        case 'CrossReferencedEvent': {
            const source = node.source;
            if (!source?.url || source.number === undefined || !source.repository) return null;
            return { ...base, kind: 'referenced', repo: source.repository.nameWithOwner, number: source.number, title: source.title ?? '', url: source.url };
        }
        default: {
            const kind = SIMPLE_KINDS[node.__typename];
            return kind ? { ...base, kind } as TimelineEvent : null;
        }
    }
}

/**
 * Converts the timeline nodes of GitHub to events, the oldest first.
 * GitHub records a "closed" event at the same time as each "merged" event. The result does not have that "closed" event.
 */
export function mapTimeline(nodes: readonly (GraphQlTimelineNode | null)[]): TimelineEvent[] {
    const events = nodes.flatMap(node => {
        const event = node ? mapNode(node) : null;
        return event ? [event] : [];
    });
    const mergedAt = new Set(events.filter(event => event.kind === 'merged').map(event => event.createdAt));
    return events
        .filter(event => !(event.kind === 'closed' && mergedAt.has(event.createdAt)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
