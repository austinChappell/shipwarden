import { describe, expect, it } from 'vitest';
import { localWorkWarnings } from './local-work';

const clean = { upstream: 'origin/feat', ahead: 0, staged: [], unstaged: [], conflicted: [] };

describe('localWorkWarnings', () => {
    it('returns no warning when the remote has all the work', () => {
        expect(localWorkWarnings(clean)).toEqual([]);
    });

    it('counts the commits that are not pushed', () => {
        expect(localWorkWarnings({ ...clean, ahead: 1 })).toEqual(['1 commit is not pushed to origin/feat.']);
        expect(localWorkWarnings({ ...clean, ahead: 3 })).toEqual(['3 commits are not pushed to origin/feat.']);
    });

    it('does not count commits without an upstream branch on the remote', () => {
        expect(localWorkWarnings({ ...clean, upstream: undefined, ahead: 2 })).toEqual([]);
        expect(localWorkWarnings({ ...clean, upstreamGone: true, ahead: 2 })).toEqual([]);
    });

    it('counts a file with staged and unstaged changes one time', () => {
        const file = { path: 'a.ts', kind: 'modified' as const };
        expect(localWorkWarnings({ ...clean, staged: [file], unstaged: [file] })).toEqual(['1 file has changes that are not committed.']);
        expect(localWorkWarnings({ ...clean, ahead: 1, unstaged: [file, { path: 'b.ts', kind: 'untracked' as const }] })).toEqual([
            '1 commit is not pushed to origin/feat.',
            '2 files have changes that are not committed.'
        ]);
    });
});
