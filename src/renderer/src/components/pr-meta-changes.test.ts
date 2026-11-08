import { describe, expect, it } from 'vitest';
import { applyMetaChanges, metaChangeKey } from './pr-meta-changes';

const pr = {
    reviewRequests: [{ kind: 'team' as const, login: 'platform', name: 'Platform' }],
    assignees: [{ login: 'ann' }],
    labels: [{ name: 'bug', color: 'ff0000' }]
};

describe('applyMetaChanges', () => {
    it('adds and removes items in order', () => {
        const result = applyMetaChanges(pr, [
            { kind: 'assignee', login: 'bob', add: true },
            { kind: 'assignee', login: 'ann', add: false },
            { kind: 'reviewer', reviewer: { kind: 'user', login: 'cat' }, add: true },
            { kind: 'reviewer', reviewer: { kind: 'team', login: 'platform' }, add: false },
            { kind: 'label', name: 'docs', add: true }
        ], [{ name: 'docs', color: '00ff00' }]);
        expect(result.assignees).toEqual([{ login: 'bob' }]);
        expect(result.reviewRequests).toEqual([{ kind: 'user', login: 'cat' }]);
        expect(result.labels).toEqual([{ name: 'bug', color: 'ff0000' }, { name: 'docs', color: '00ff00' }]);
    });

    it('uses the last change for the same item', () => {
        const result = applyMetaChanges(pr, [
            { kind: 'label', name: 'docs', add: true },
            { kind: 'label', name: 'docs', add: false }
        ]);
        expect(result.labels).toEqual(pr.labels);
    });

    it('does nothing when the pull request already has the change', () => {
        const result = applyMetaChanges(pr, [
            { kind: 'assignee', login: 'ann', add: true },
            { kind: 'label', name: 'docs', add: false }
        ]);
        expect(result.assignees).toEqual(pr.assignees);
        expect(result.labels).toEqual(pr.labels);
    });
});

describe('metaChangeKey', () => {
    it('gives the same key to changes of the same item', () => {
        expect(metaChangeKey({ kind: 'label', name: 'bug', add: true })).toBe(metaChangeKey({ kind: 'label', name: 'bug', add: false }));
        expect(metaChangeKey({ kind: 'reviewer', reviewer: { kind: 'user', login: 'x' }, add: true }))
            .not.toBe(metaChangeKey({ kind: 'reviewer', reviewer: { kind: 'team', login: 'x' }, add: true }));
    });
});
