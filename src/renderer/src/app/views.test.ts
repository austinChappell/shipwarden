import { describe, expect, it } from 'vitest';
import { isNavValid, navLocationOf, startView, viewAfterProjectSwitch, viewToSave } from './views';

describe('viewToSave', () => {
    it('saves the view below the settings page', () => {
        expect(viewToSave('settings', 'review')).toBe('review');
    });

    it('saves the worktree view in place of the graph page', () => {
        expect(viewToSave('graph', 'dashboard')).toBe('worktree');
        expect(viewToSave('settings', 'graph')).toBe('worktree');
    });

    it('saves the Dashboard in place of the welcome page', () => {
        expect(viewToSave('welcome', 'review')).toBe('dashboard');
        expect(viewToSave('settings', 'welcome')).toBe('dashboard');
    });

    it('saves other views as they are', () => {
        expect(viewToSave('tasks', 'dashboard')).toBe('tasks');
    });
});

describe('navLocationOf', () => {
    it('gives the section of the settings page as its page', () => {
        expect(navLocationOf('settings', '/w', 't:1', 'repo', { page: 'network' })).toEqual({ view: 'settings', page: 'network' });
    });

    it('gives the worktree and the tab in the worktree view', () => {
        expect(navLocationOf('worktree', '/w', 't:1', undefined)).toEqual({ view: 'worktree', worktree: '/w', tab: 't:1', query: undefined });
        expect(navLocationOf('worktree', undefined, undefined, undefined)).toBeUndefined();
    });

    it('gives the repository of the graph page', () => {
        expect(navLocationOf('graph', '/w', 't:1', '/repo')).toEqual({ view: 'graph', repo: '/repo' });
    });

    it('gives the view, its page and its query for other views', () => {
        expect(navLocationOf('dashboard', '/w', 't:1', '/repo')).toEqual({ view: 'dashboard' });
        expect(navLocationOf('review', '/w', 't:1', '/repo', { page: 'owner/repo#4', query: { tab: 'files' } })).toEqual({
            view: 'review',
            page: 'owner/repo#4',
            query: { tab: 'files' }
        });
    });

    it('gives the query of the worktree view, without a page', () => {
        expect(navLocationOf('worktree', '/w', 't:1', undefined, { page: 'x', query: { panel: 'checks' } })).toEqual({
            view: 'worktree',
            worktree: '/w',
            tab: 't:1',
            query: { panel: 'checks' }
        });
    });

    it('gives the home folder and the tab in the Terminal view, without a query', () => {
        expect(navLocationOf('terminal', '/home', 't:2', '/repo', { query: { panel: 'checks' } })).toEqual({ view: 'terminal', worktree: '/home', tab: 't:2' });
        expect(navLocationOf('terminal', undefined, undefined, undefined)).toEqual({ view: 'terminal' });
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

    it('accepts a Terminal entry only when its tab exists', () => {
        expect(isNavValid({ view: 'terminal', worktree: '/w', tab: 't:1' }, [], [], tabsOf)).toBe(true);
        expect(isNavValid({ view: 'terminal', worktree: '/w', tab: 't:closed' }, [], [], tabsOf)).toBe(false);
        expect(isNavValid({ view: 'terminal' }, [], [], tabsOf)).toBe(true);
    });

    it('accepts all entries of other views', () => {
        expect(isNavValid({ view: 'dashboard' }, [], [], tabsOf)).toBe(true);
    });
});

describe('viewAfterProjectSwitch', () => {
    it('keeps the current view', () => {
        expect(viewAfterProjectSwitch('tasks')).toBe('tasks');
        expect(viewAfterProjectSwitch('review')).toBe('review');
        expect(viewAfterProjectSwitch('worktree')).toBe('worktree');
    });

    it('shows the worktree view in place of the graph of the old project', () => {
        expect(viewAfterProjectSwitch('graph')).toBe('worktree');
    });
});

describe('startView', () => {
    it('shows the saved view', () => {
        expect(startView('review', undefined)).toBe('review');
        expect(startView('worktree', '/wt/a')).toBe('worktree');
    });

    it('shows the Dashboard without a saved view or without a worktree for the worktree view', () => {
        expect(startView(undefined, '/wt/a')).toBe('dashboard');
        expect(startView('worktree', undefined)).toBe('dashboard');
    });
});
