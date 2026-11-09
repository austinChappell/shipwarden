import { describe, expect, it } from 'vitest';
import { branchFromName, normalizeWorktreeSort, sortWorktrees, localNameOfRemote, worktreeLabel, type Worktree } from './worktrees';

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

describe('sortWorktrees', () => {
    const tree = (path: string, branch: string, createdAt?: number, updatedAt?: number, isMain = false): Worktree =>
        ({ path, branch, head: 'abc', isMain, isBare: false, locked: false, prunable: false, createdAt, updatedAt });
    const list = [
        tree('/main', 'main', 1, 50, true),
        tree('/b', 'beta', 30, 10),
        tree('/a', 'alpha', 20, 40),
        tree('/c', 'item-10', undefined, undefined),
        tree('/d', 'item-9', 10, 30)
    ];
    const paths = (items: Worktree[]) => items.map(item => item.path);

    it('keeps the main worktree first', () => {
        expect(sortWorktrees(list, { by: 'name', direction: 'desc' })[0].path).toBe('/main');
    });

    it('sorts by name with numbers in order, and uses display names', () => {
        expect(paths(sortWorktrees(list, { by: 'name', direction: 'asc' }))).toEqual(['/main', '/a', '/b', '/d', '/c']);
        expect(paths(sortWorktrees(list, { by: 'name', direction: 'asc' }, { '/b': 'Aaa' }))).toEqual(['/main', '/b', '/a', '/d', '/c']);
    });

    it('sorts by date and puts a worktree without a date last', () => {
        expect(paths(sortWorktrees(list, { by: 'created', direction: 'asc' }))).toEqual(['/main', '/d', '/a', '/b', '/c']);
        expect(paths(sortWorktrees(list, { by: 'created', direction: 'desc' }))).toEqual(['/main', '/b', '/a', '/d', '/c']);
        expect(paths(sortWorktrees(list, { by: 'updated', direction: 'desc' }))).toEqual(['/main', '/a', '/d', '/b', '/c']);
    });

    it('gives a wrong stored value the default', () => {
        expect(normalizeWorktreeSort({ by: 'size', direction: 'up' })).toEqual({ by: 'created', direction: 'asc' });
        expect(normalizeWorktreeSort({ by: 'updated', direction: 'desc' })).toEqual({ by: 'updated', direction: 'desc' });
    });
});

describe('localNameOfRemote', () => {
    it('removes the remote name', () => {
        expect(localNameOfRemote('origin/feature/login', ['origin'])).toBe('feature/login');
    });

    it('uses the longest remote name that matches', () => {
        expect(localNameOfRemote('team/a/fix', ['team', 'team/a'])).toBe('fix');
    });

    it('returns undefined when no remote matches', () => {
        expect(localNameOfRemote('upstream/main', ['origin'])).toBeUndefined();
        expect(localNameOfRemote('origin/', ['origin'])).toBeUndefined();
    });
});
