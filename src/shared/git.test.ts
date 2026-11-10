import { describe, expect, it } from 'vitest';
import { changeCount, changePathError, parseStatus } from './git';

const z = (...fields: string[]) => `${fields.join('\0')}\0`;

describe('parseStatus', () => {
    it('reads the branch, the upstream and the ahead and behind counts', () => {
        const status = parseStatus(z('# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1'));
        expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, unborn: false });
        expect(parseStatus(z('# branch.oid (initial)', '# branch.head main')).unborn).toBe(true);
        expect(parseStatus(z('# branch.oid abc', '# branch.head (detached)')).branch).toBeUndefined();
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
