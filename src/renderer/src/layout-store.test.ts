import { describe, expect, it } from 'vitest';
import type { PaneLayout } from '@shared/panes';
import { parseLayout, pruneLayout } from './layout-store';

const split: PaneLayout = {
    root: {
        kind: 'split',
        id: 's1',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', id: 'p1', tab: 'f:src/a.ts' },
        second: { kind: 'leaf', id: 'p2', tab: 't:x' }
    },
    focused: 'p1'
};

describe('parseLayout', () => {
    it('reads a stored layout and ignores values with a wrong type', () => {
        const text = JSON.stringify({
            selectedPath: '/wt/a',
            mainView: 'tasks',
            route: { page: 'task-1', query: { filter: 'mine', bad: 4 } },
            openFiles: { '/wt/a': ['src/a.ts', 3], '/wt/b': 'bad' },
            activeTabs: { '/wt/a': 'f:src/a.ts', '/wt/b': 5 },
            panes: { '/wt/a': [split], '/wt/b': { root: 'bad' } }
        });
        expect(parseLayout(text)).toEqual({
            selectedPath: '/wt/a',
            mainView: 'tasks',
            route: { page: 'task-1', query: { filter: 'mine' } },
            openFiles: { '/wt/a': ['src/a.ts'] },
            activeTabs: { '/wt/a': 'f:src/a.ts' },
            panes: { '/wt/a': [split] }
        });
    });

    it('ignores a route without a page or a query', () => {
        expect(parseLayout(JSON.stringify({ route: { page: 5, query: { a: 1 } } })).route).toBeUndefined();
        expect(parseLayout(JSON.stringify({ route: 'bad' })).route).toBeUndefined();
    });

    it('returns an empty layout for missing or bad JSON', () => {
        expect(parseLayout(null)).toEqual({ openFiles: {}, activeTabs: {}, panes: {} });
        expect(parseLayout('{bad')).toEqual({ openFiles: {}, activeTabs: {}, panes: {} });
        expect(parseLayout('"text"')).toEqual({ openFiles: {}, activeTabs: {}, panes: {} });
    });
});

describe('pruneLayout', () => {
    const layout = {
        selectedPath: '/wt/gone',
        mainView: 'worktree' as const,
        openFiles: { '/wt/a': ['a.ts', 'b.ts', 'a.ts'], '/wt/gone': ['x.ts'], '/wt/empty': [] },
        activeTabs: { '/wt/a': 'f:b.ts', '/wt/b': 't:old-session', '/wt/c': 't:live', '/wt/gone': 'f:x.ts', '/wt/d': 'f:closed.ts' },
        panes: { '/wt/a': [split], '/wt/gone': [split] }
    };

    it('removes worktrees that do not exist and tabs that a restart cannot show', () => {
        expect(pruneLayout(layout, ['/wt/a', '/wt/b', '/wt/c', '/wt/d', '/wt/empty'], ['live'])).toEqual({
            selectedPath: undefined,
            mainView: 'worktree',
            openFiles: { '/wt/a': ['a.ts', 'b.ts'] },
            activeTabs: { '/wt/a': 'f:b.ts', '/wt/c': 't:live' },
            panes: { '/wt/a': layout.panes['/wt/a'] }
        });
    });

    it('keeps the route of the main view', () => {
        expect(pruneLayout({ ...layout, mainView: 'review', route: { page: 'pr' } }, []).route).toEqual({ page: 'pr' });
    });

    it('keeps the selected worktree when it exists', () => {
        expect(pruneLayout({ ...layout, selectedPath: '/wt/a' }, ['/wt/a']).selectedPath).toBe('/wt/a');
    });
});
