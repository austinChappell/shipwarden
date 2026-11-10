import { describe, expect, it } from 'vitest';
import type { PullRequest } from '@shared/github';
import { buildTimeline } from './pr-timeline';

const at = (minute: number) => `2026-11-09T15:${String(minute).padStart(2, '0')}:00Z`;
const commit = (oid: string, minute: number) => ({ oid, abbreviatedOid: oid, messageHeadline: oid, committedDate: at(minute), url: '', author: 'ann' });

function pr(parts: Partial<PullRequest>): PullRequest {
    return { issueComments: [], reviews: [], commits: [], ...parts } as PullRequest;
}

describe('buildTimeline', () => {
    it('sorts all items by time and groups commits that follow each other', () => {
        const items = buildTimeline(
            pr({
                commits: [commit('c1', 1), commit('c2', 2), commit('c3', 6)],
                issueComments: [{ id: 'i1', author: null, body: 'hi', createdAt: at(4), url: '' }],
                reviews: [{ id: 'r1', author: null, state: 'APPROVED', body: '', submittedAt: at(5), url: '' }],
                timeline: [{ id: 'e1', createdAt: at(3), actor: 'ann', kind: 'labeled', label: { name: 'bug', color: 'ff0000' } }]
            })
        );
        expect(items.map(item => (item.type === 'commits' ? item.commits.map(c => c.oid).join('+') : item.id))).toEqual(['c1+c2', 'e1', 'i1', 'r1', 'c3']);
    });

    it('leaves out a review without text and without a decision', () => {
        const items = buildTimeline(
            pr({
                reviews: [
                    { id: 'empty', author: null, state: 'COMMENTED', body: ' ', submittedAt: at(1), url: '' },
                    { id: 'text', author: null, state: 'COMMENTED', body: 'Looks fine', submittedAt: at(2), url: '' }
                ]
            })
        );
        expect(items.map(item => item.id)).toEqual(['text']);
    });

    it('works without a timeline', () => {
        expect(buildTimeline(pr({ timeline: undefined }))).toEqual([]);
    });
});
