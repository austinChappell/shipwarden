import { describe, expect, it } from 'vitest';
import { branchFromName, worktreeLabel, type Worktree } from './worktrees';

describe('branchFromName', () => {
    it('makes a branch name from a display name', () => {
        expect(branchFromName('Fix the login page!')).toBe('fix-the-login-page');
        expect(branchFromName('  Café — résumé upload  ')).toBe('cafe-resume-upload');
        expect(branchFromName('feature/New Thing')).toBe('feature/new-thing');
        expect(branchFromName('--.hidden..')).toBe('hidden');
        expect(branchFromName('a'.repeat(80))).toHaveLength(60);
    });
});

describe('worktreeLabel', () => {
    const worktree: Worktree = { path: '/w/a', branch: 'feat/a', head: 'abcdef1234', isMain: false, isBare: false, locked: false, prunable: false };

    it('uses the display name, then the branch, then the commit', () => {
        expect(worktreeLabel(worktree, { '/w/a': 'Login rework' })).toBe('Login rework');
        expect(worktreeLabel(worktree, undefined)).toBe('feat/a');
        expect(worktreeLabel({ ...worktree, branch: undefined }, {})).toBe('detached abcdef1');
    });
});
