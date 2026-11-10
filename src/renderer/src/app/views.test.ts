import { describe, expect, it } from 'vitest';
import { isNavValid, navLocationOf, viewToSave } from './views';

describe('viewToSave', () => {
    it('saves the view below the settings page', () => {
        expect(viewToSave('settings', 'review')).toBe('review');
    });

    it('saves the worktree view in place of the graph page', () => {
        expect(viewToSave('graph', 'dashboard')).toBe('worktree');
        expect(viewToSave('settings', 'graph')).toBe('worktree');
    });

    it('saves other views as they are', () => {
        expect(viewToSave('tasks', 'dashboard')).toBe('tasks');
    });
});

describe('navLocationOf', () => {
    it('gives no entry for the settings page', () => {
        expect(navLocationOf('settings', '/w', 't:1', 'repo')).toBeUndefined();
    });

    it('gives the worktree and the tab in the worktree view', () => {
        expect(navLocationOf('worktree', '/w', 't:1', undefined)).toEqual({ view: 'worktree', worktree: '/w', tab: 't:1' });
        expect(navLocationOf('worktree', undefined, undefined, undefined)).toBeUndefined();
    });

    it('gives the repository of the graph page', () => {
        expect(navLocationOf('graph', '/w', 't:1', '/repo')).toEqual({ view: 'graph', repo: '/repo' });
    });

    it('gives only the view for other views', () => {
        expect(navLocationOf('dashboard', '/w', 't:1', '/repo')).toEqual({ view: 'dashboard' });
    });
});

describe('isNavValid', () => {
    const tabsOf = (worktree: string) => (worktree === '/w' ? ['t:1', 'f:a.ts'] : []);

    it('accepts a graph entry only for a repository of the project', () => {
        expect(isNavValid({ view: 'graph', repo: '/repo' }, ['/repo'], [], tabsOf)).toBe(true);
        expect(isNavValid({ view: 'graph', repo: '/gone' }, ['/repo'], [], tabsOf)).toBe(false);
        expect(isNavValid({ view: 'graph' }, ['/repo'], [], tabsOf)).toBe(false);
    });

    it('accepts a worktree entry only when the worktree and the tab exist', () => {
        expect(isNavValid({ view: 'worktree', worktree: '/w', tab: 'f:a.ts' }, [], ['/w'], tabsOf)).toBe(true);
        expect(isNavValid({ view: 'worktree', worktree: '/w' }, [], ['/w'], tabsOf)).toBe(true);
        expect(isNavValid({ view: 'worktree', worktree: '/w', tab: 't:closed' }, [], ['/w'], tabsOf)).toBe(false);
        expect(isNavValid({ view: 'worktree', worktree: '/gone' }, [], ['/w'], tabsOf)).toBe(false);
    });

    it('accepts all entries of other views', () => {
        expect(isNavValid({ view: 'dashboard' }, [], [], tabsOf)).toBe(true);
    });
});
