import { describe, expect, it } from 'vitest';
import { changeCount, changePathError, diffTotals, hasDiverged, hasUncommittedChanges, parseNumstat, parseStatus } from './git';

describe('parseNumstat', () => {
    it('reads changed, binary, and renamed files', () => {
        const output = ['3\t1\tsrc/a.ts', '-\t-\timg/logo.png', '2\t0\t', 'old/b.ts', 'new/b.ts', '0\t4\tsrc/with\ttab.ts', ''].join('\0');
        expect(parseNumstat(output)).toEqual([
            { path: 'src/a.ts', added: 3, removed: 1, binary: false },
            { path: 'img/logo.png', added: 0, removed: 0, binary: true },
            { path: 'new/b.ts', oldPath: 'old/b.ts', added: 2, removed: 0, binary: false },
            { path: 'src/with\ttab.ts', added: 0, removed: 4, binary: false }
        ]);
    });

    it('returns no files for empty output', () => {
        expect(parseNumstat('')).toEqual([]);
    });

    it('adds the totals', () => {
        expect(diffTotals(parseNumstat(['3\t1\ta', '5\t2\tb', ''].join('\0')))).toEqual({ files: 2, added: 8, removed: 3 });
    });
});

const z = (...fields: string[]) => `${fields.join('\0')}\0`;

describe('parseStatus', () => {
    it('reads the branch, the upstream and the ahead and behind counts', () => {
        const status = parseStatus(z('# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1'));
        expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, unborn: false });
        expect(parseStatus(z('# branch.oid (initial)', '# branch.head main')).unborn).toBe(true);
        expect(parseStatus(z('# branch.oid abc', '# branch.head (detached)')).branch).toBeUndefined();
    });

    it('marks an upstream branch that is not on the remote', () => {
        // Git writes no "branch.ab" line when the commit of the upstream branch is not present.
        const gone = parseStatus(z('# branch.oid abc', '# branch.head feat', '# branch.upstream origin/feat'));
        expect(gone).toMatchObject({ upstream: 'origin/feat', upstreamGone: true, ahead: 0, behind: 0 });
        expect(parseStatus(z('# branch.oid abc', '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +0 -0')).upstreamGone).toBeUndefined();
        expect(parseStatus(z('# branch.oid abc', '# branch.head feat')).upstreamGone).toBeUndefined();
    });

    it('puts staged, unstaged, untracked and conflicted files in their lists', () => {
        const status = parseStatus(
            z(
                '1 M. N... 100644 100644 100644 aaa bbb src/staged.ts',
                '1 .M N... 100644 100644 100644 aaa aaa src/changed.ts',
                '1 MM N... 100644 100644 100644 aaa bbb both.ts',
                '1 A. N... 000000 100644 100644 000 bbb new file.ts',
                '1 .D N... 100644 100644 000000 aaa aaa gone.ts',
                '2 R. N... 100644 100644 100644 aaa aaa R100 renamed.ts',
                'old name.ts',
                'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
                '? notes/todo.md'
            )
        );
        expect(status.staged).toEqual([
            { path: 'both.ts', kind: 'modified' },
            { path: 'new file.ts', kind: 'added' },
            { path: 'renamed.ts', oldPath: 'old name.ts', kind: 'renamed' },
            { path: 'src/staged.ts', kind: 'modified' }
        ]);
        expect(status.unstaged).toEqual([
            { path: 'both.ts', kind: 'modified' },
            { path: 'gone.ts', kind: 'deleted' },
            { path: 'notes/todo.md', kind: 'untracked' },
            { path: 'src/changed.ts', kind: 'modified' }
        ]);
        expect(status.conflicted).toEqual([{ path: 'conflict.ts', kind: 'conflicted' }]);
        expect(changeCount(status)).toBe(8);
    });
});

describe('changePathError', () => {
    it('accepts relative paths and refuses paths that leave the worktree', () => {
        expect(changePathError('src/a.ts')).toBeUndefined();
        expect(changePathError('../secret')).toMatch(/not a path/);
        expect(changePathError('/etc/passwd')).toMatch(/not a path/);
        expect(changePathError('a//b')).toMatch(/not a path/);
    });
});

describe('hasUncommittedChanges', () => {
    const none = { staged: [], unstaged: [], conflicted: [] };
    it('counts staged, unstaged, and conflicted files, but not new files', () => {
        expect(hasUncommittedChanges(none)).toBe(false);
        expect(hasUncommittedChanges({ ...none, unstaged: [{ path: 'n.txt', kind: 'untracked' }] })).toBe(false);
        expect(hasUncommittedChanges({ ...none, unstaged: [{ path: 'a.txt', kind: 'modified' }] })).toBe(true);
        expect(hasUncommittedChanges({ ...none, staged: [{ path: 'a.txt', kind: 'added' }] })).toBe(true);
        expect(hasUncommittedChanges({ ...none, conflicted: [{ path: 'a.txt', kind: 'conflicted' }] })).toBe(true);
    });
});

describe('hasDiverged', () => {
    it('is true only when the branch and its upstream both have new commits', () => {
        expect(hasDiverged({ upstream: 'origin/f', ahead: 2, behind: 1 })).toBe(true);
        expect(hasDiverged({ upstream: 'origin/f', ahead: 2, behind: 0 })).toBe(false);
        expect(hasDiverged({ upstream: 'origin/f', ahead: 0, behind: 1 })).toBe(false);
        expect(hasDiverged({ ahead: 2, behind: 1 })).toBe(false);
    });
});
