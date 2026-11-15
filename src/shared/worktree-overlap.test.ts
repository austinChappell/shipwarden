import { describe, expect, it } from 'vitest';
import {
    findOverlaps,
    MAX_WORKTREE_FILES,
    overlapChipText,
    overlapHash,
    overlapTooltip,
    worktreeFileList,
    worktreeName,
    type WorktreeFiles
} from './worktree-overlap';

const a: WorktreeFiles = { path: '/wt/a', branch: 'feat-a', files: ['src/app.ts', 'src/login.ts', 'README.md'] };
const b: WorktreeFiles = { path: '/wt/b', branch: 'feat-b', files: ['src/login.ts', 'src/app.ts', 'docs/x.md'] };
const c: WorktreeFiles = { path: '/wt/c', files: ['README.md'] };
const d: WorktreeFiles = { path: '/wt/d', branch: 'feat-d', files: ['other.ts'] };

describe('findOverlaps', () => {
    it('finds the files that two worktrees change, for both worktrees', () => {
        const overlaps = findOverlaps([a, b, d]);
        expect(Object.keys(overlaps).sort()).toEqual(['/wt/a', '/wt/b']);
        expect(overlaps['/wt/a']).toEqual({
            path: '/wt/a',
            branch: 'feat-a',
            files: ['src/app.ts', 'src/login.ts'],
            peers: [{ path: '/wt/b', branch: 'feat-b', files: ['src/app.ts', 'src/login.ts'] }]
        });
        expect(overlaps['/wt/b'].peers).toEqual([{ path: '/wt/a', branch: 'feat-a', files: ['src/app.ts', 'src/login.ts'] }]);
    });

    it('gives each peer its own files, and the union of the files', () => {
        const overlaps = findOverlaps([a, b, c]);
        expect(overlaps['/wt/a'].files).toEqual(['README.md', 'src/app.ts', 'src/login.ts']);
        expect(overlaps['/wt/a'].peers.map(peer => [worktreeName(peer), peer.files])).toEqual([
            ['c', ['README.md']],
            ['feat-b', ['src/app.ts', 'src/login.ts']]
        ]);
        expect(overlaps['/wt/c']).toMatchObject({ files: ['README.md'], peers: [{ path: '/wt/a' }] });
        expect(overlaps['/wt/c'].branch).toBeUndefined();
    });

    it('finds nothing for one worktree, for worktrees without shared files, and for a file that shows two times', () => {
        expect(findOverlaps([])).toEqual({});
        expect(findOverlaps([a])).toEqual({});
        expect(findOverlaps([a, d])).toEqual({});
        expect(findOverlaps([{ path: '/wt/e', files: ['x', 'x'] }])).toEqual({});
    });
});

describe('overlapHash', () => {
    it('is the same for the same overlap in a different order', () => {
        const one = findOverlaps([a, b, c])['/wt/a'];
        const two = findOverlaps([c, { ...b, files: [...b.files].reverse() }, a])['/wt/a'];
        expect(overlapHash(one)).toBe(overlapHash(two));
    });

    it('changes for a new shared file or a new peer', () => {
        const base = overlapHash(findOverlaps([a, b])['/wt/a']);
        expect(overlapHash(findOverlaps([a, { ...b, files: [...b.files, 'README.md'] }])['/wt/a'])).not.toBe(base);
        expect(overlapHash(findOverlaps([a, b, c])['/wt/a'])).not.toBe(base);
    });
});

describe('worktreeFileList', () => {
    it('merges the committed files and the status, with the old path of a rename', () => {
        const files = worktreeFileList(['src/a.ts', 'src/b.ts', ''], {
            staged: [{ path: 'src/new.ts', oldPath: 'src/old.ts', kind: 'renamed' }],
            unstaged: [
                { path: 'src/a.ts', kind: 'modified' },
                { path: 'notes.txt', kind: 'untracked' }
            ],
            conflicted: []
        });
        expect(files).toEqual(['notes.txt', 'src/a.ts', 'src/b.ts', 'src/new.ts', 'src/old.ts']);
    });

    it('keeps at most the limit of files', () => {
        const many = Array.from({ length: MAX_WORKTREE_FILES + 10 }, (_, index) => `f${index}`);
        expect(worktreeFileList(many, { staged: [], unstaged: [], conflicted: [] })).toHaveLength(MAX_WORKTREE_FILES);
    });
});

describe('texts', () => {
    it('names a worktree by its branch, else by its folder', () => {
        expect(worktreeName({ path: '/wt/a', branch: 'feat-a' })).toBe('feat-a');
        expect(worktreeName({ path: '/wt/c/' })).toBe('c');
    });

    it('gives the chip text with the first peer and a count of the others', () => {
        expect(overlapChipText(findOverlaps([a, b])['/wt/a'])).toBe('Also changed in feat-b');
        expect(overlapChipText(findOverlaps([a, b, c])['/wt/a'])).toBe('Also changed in c and 1 more');
        expect(overlapChipText({ peers: [] })).toBe('');
    });

    it('lists the files of each peer in the tooltip, with a limit', () => {
        const overlap = findOverlaps([a, b, c])['/wt/a'];
        expect(overlapTooltip(overlap)).toBe('c:\n  README.md\nfeat-b:\n  src/app.ts\n  src/login.ts');
        expect(overlapTooltip(overlap, 1)).toBe('c:\n  README.md\nfeat-b:\n  src/app.ts\n  and 1 more');
    });
});
