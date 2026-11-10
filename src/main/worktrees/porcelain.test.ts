import { describe, expect, it } from 'vitest';
import { branchToFolderName, parseWorktreePorcelain } from './porcelain';

describe('parseWorktreePorcelain', () => {
    it('parses the main worktree, a branch worktree and a detached worktree', () => {
        const output = [
            'worktree /repo',
            'HEAD 1111111111111111111111111111111111111111',
            'branch refs/heads/main',
            '',
            'worktree /wt/feature-login',
            'HEAD 2222222222222222222222222222222222222222',
            'branch refs/heads/feature/login',
            'locked agent is busy',
            '',
            'worktree /wt/detached',
            'HEAD 3333333333333333333333333333333333333333',
            'detached',
            'prunable gitdir file points to non-existent location',
            ''
        ].join('\n');

        const worktrees = parseWorktreePorcelain(output);

        expect(worktrees).toEqual([
            { path: '/repo', head: '1111111111111111111111111111111111111111', branch: 'main', isMain: true, isBare: false, locked: false, prunable: false },
            {
                path: '/wt/feature-login',
                head: '2222222222222222222222222222222222222222',
                branch: 'feature/login',
                isMain: false,
                isBare: false,
                locked: true,
                prunable: false
            },
            { path: '/wt/detached', head: '3333333333333333333333333333333333333333', isMain: false, isBare: false, locked: false, prunable: true }
        ]);
    });

    it('parses a bare repository', () => {
        const worktrees = parseWorktreePorcelain('worktree /repo.git\nbare\n');
        expect(worktrees).toEqual([{ path: '/repo.git', head: '', isMain: true, isBare: true, locked: false, prunable: false }]);
    });

    it('returns an empty list for empty output', () => {
        expect(parseWorktreePorcelain('')).toEqual([]);
    });
});

describe('branchToFolderName', () => {
    it.each([
        ['main', 'main'],
        ['feature/login', 'feature-login'],
        ['ENG-123/fix bug!', 'ENG-123-fix-bug'],
        ['/.hidden/', 'hidden'],
        ['///', 'worktree']
    ])('converts %p to %p', (branch, folder) => {
        expect(branchToFolderName(branch)).toBe(folder);
    });
});
