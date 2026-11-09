import { describe, expect, it } from 'vitest';
import { mapTimeline, type GraphQlTimelineNode } from './timeline';

const at = (minute: number) => `2026-11-09T15:${String(minute).padStart(2, '0')}:00Z`;

describe('mapTimeline', () => {
    it('maps the events and sorts them, the oldest first', () => {
        const nodes: GraphQlTimelineNode[] = [
            { __typename: 'LabeledEvent', id: 'l', createdAt: at(3), actor: { login: 'ann' }, label: { name: 'bug', color: 'd73a4a' } },
            { __typename: 'ReviewRequestedEvent', id: 'r', createdAt: at(1), actor: { login: 'ann' }, requestedReviewer: { login: 'bob' } },
            { __typename: 'ReviewRequestedEvent', id: 't', createdAt: at(2), actor: { login: 'ann' }, requestedReviewer: { slug: 'core', name: 'Core' } },
            { __typename: 'AssignedEvent', id: 'a', createdAt: at(4), actor: null, assignee: { login: 'cat' } }
        ];
        expect(mapTimeline(nodes)).toEqual([
            { id: 'r', createdAt: at(1), actor: 'ann', kind: 'reviewRequested', reviewer: 'bob' },
            { id: 't', createdAt: at(2), actor: 'ann', kind: 'reviewRequested', reviewer: 'core' },
            { id: 'l', createdAt: at(3), actor: 'ann', kind: 'labeled', label: { name: 'bug', color: 'd73a4a' } },
            { id: 'a', createdAt: at(4), actor: null, kind: 'assigned', user: 'cat' }
        ]);
    });

    it('removes the "closed" event of a merge', () => {
        const nodes: GraphQlTimelineNode[] = [
            { __typename: 'MergedEvent', id: 'm', createdAt: at(5), actor: { login: 'ann' }, mergeRefName: 'main', commit: { abbreviatedOid: 'abc1234', url: 'u' } },
            { __typename: 'ClosedEvent', id: 'c', createdAt: at(5), actor: { login: 'ann' } },
            { __typename: 'ClosedEvent', id: 'c2', createdAt: at(1), actor: { login: 'bob' } }
        ];
        expect(mapTimeline(nodes).map(event => event.id)).toEqual(['c2', 'm']);
    });

    it('skips unknown types, null nodes and events without a subject', () => {
        const nodes: (GraphQlTimelineNode | null)[] = [
            null,
            { __typename: 'SomeNewEvent', id: 'x', createdAt: at(1) },
            { __typename: 'AssignedEvent', id: 'a', createdAt: at(2), assignee: null },
            { __typename: 'CrossReferencedEvent', id: 'c', createdAt: at(3), source: {} },
            { __typename: 'ReadyForReviewEvent', id: 'r', createdAt: at(4), actor: { login: 'ann' } }
        ];
        expect(mapTimeline(nodes)).toEqual([{ id: 'r', createdAt: at(4), actor: 'ann', kind: 'readyForReview' }]);
    });
});
