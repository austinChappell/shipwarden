import { describe, expect, it, vi } from 'vitest';
import type { Worktree } from '@shared/worktrees';
import { DEFAULT_APPEARANCE } from '@shared/themes';
import { paletteItems, type PaletteActions, type PaletteContext } from './palette-commands';
import type { PaletteItem } from './palette-model';

const worktree = (path: string, branch: string, isMain = false): Worktree => ({
    path,
    branch,
    head: 'abc1234',
    isMain,
    isBare: false,
    locked: false,
    prunable: false,
    createdAt: 0
});

function context(change: Partial<PaletteContext> = {}): PaletteContext {
    const actions = new Proxy({} as PaletteActions, {
        get: (target, name) => {
            const key = name as keyof PaletteActions;
            if (!target[key]) (target as unknown as Record<string, unknown>)[key] = vi.fn();
            return target[key];
        }
    });
    return {
        repos: ['/repos/app'],
        worktreesByRepo: { '/repos/app': [worktree('/repos/app', 'main', true), worktree('/wt/login', 'feature/login')] },
        worktreeNames: undefined,
        repoLabel: repo => repo.split('/').pop() ?? repo,
        selectedRepo: '/repos/app',
        selectedPath: undefined,
        links: {},
        tasksAvailable: true,
        hasProject: true,
        plans: [],
        notes: [],
        automations: [],
        reviewQueue: [],
        reviewAvailable: true,
        appearance: DEFAULT_APPEARANCE,
        mode: 'dark',
        settingsSections: [{ id: 'appearance', label: 'Appearance' }],
        actions,
        ...change
    };
}

const byId = (items: PaletteItem[], id: string) => {
    const found = items.find(item => item.id === id);
    if (!found) throw new Error(`No item "${id}".`);
    return found;
};

describe('paletteItems', () => {
    it('has a command for each area of the app', () => {
        const ids = paletteItems(context()).map(item => item.id);
        for (const id of [
            'new-worktree',
            'go-worktree',
            'remove-worktree',
            'view-review',
            'review-pr',
            'view-tasks',
            'new-task',
            'new-plan',
            'open-plan',
            'new-note',
            'open-note',
            'new-automation',
            'edit-automation',
            'settings',
            'theme',
            'updates'
        ]) {
            expect(ids).toContain(id);
        }
    });

    it('creates a worktree in the only repository at once', () => {
        const ctx = context();
        const item = byId(paletteItems(ctx), 'new-worktree');
        expect(item.page).toBeUndefined();
        item.run?.();
        expect(ctx.actions.newWorktree).toHaveBeenCalledWith('/repos/app');
    });

    it('asks for the repository when the project has more than one', () => {
        const ctx = context({ repos: ['/repos/app', '/repos/api'], worktreesByRepo: {} });
        const page = byId(paletteItems(ctx), 'new-worktree').page?.();
        expect(page?.items).toHaveLength(2);
    });

    it('does not offer to remove the main worktree', () => {
        const page = byId(paletteItems(context()), 'remove-worktree').page?.();
        const items = page?.items as PaletteItem[];
        expect(items.map(item => item.label)).toEqual(['feature/login']);
        expect(items[0].danger).toBe(true);
    });

    it('shows the worktrees only in the results of a search', () => {
        const items = paletteItems(context());
        expect(byId(items, 'worktree:/wt/login').searchOnly).toBe(true);
    });

    it('changes the theme of the current mode', () => {
        const ctx = context({ mode: 'light' });
        const page = byId(paletteItems(ctx), 'theme').page?.();
        const items = page?.items as PaletteItem[];
        items[1].run?.();
        expect(ctx.actions.setAppearance).toHaveBeenCalledWith({ lightTheme: items[1].id });
        expect(items.find(item => item.current)?.id).toBe(DEFAULT_APPEARANCE.lightTheme);
    });

    it('hides Tasks and Plans when the project cannot use them', () => {
        const ids = paletteItems(context({ tasksAvailable: false, hasProject: false })).map(item => item.id);
        expect(ids).not.toContain('new-task');
        expect(ids).not.toContain('new-plan');
    });

    it('hides the review queue without a review provider', () => {
        const ids = paletteItems(context({ reviewAvailable: false })).map(item => item.id);
        expect(ids).toContain('view-review');
        expect(ids).not.toContain('review-pr');
    });

    it('gives each item a unique ID in its group', () => {
        const keys = paletteItems(context()).map(item => `${item.group}:${item.id}`);
        expect(new Set(keys).size).toBe(keys.length);
    });
});
