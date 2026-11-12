import { describe, expect, it } from 'vitest';
import { nextIndex, paletteSections, scoreItem, type PaletteItem } from './palette-model';

const item = (label: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id: label, label, group: 'Worktrees', ...extra });

describe('scoreItem', () => {
    it('gives 0 for an empty search', () => {
        expect(scoreItem(item('Create a worktree'), '  ')).toBe(0);
    });

    it('matches each word of the search, in any order', () => {
        expect(scoreItem(item('Create a worktree'), 'worktree create')).toBeDefined();
        expect(scoreItem(item('Create a worktree'), 'worktree delete')).toBeUndefined();
    });

    it('matches the characters of a word in order', () => {
        expect(scoreItem(item('Create a worktree'), 'wktr')).toBeDefined();
        expect(scoreItem(item('Create a worktree'), 'rtkw')).toBeUndefined();
    });

    it('matches the detail, the group, and the keywords', () => {
        expect(scoreItem(item('main', { detail: 'shipwarden' }), 'shipwarden')).toBeDefined();
        expect(scoreItem(item('Remove a worktree', { keywords: ['delete'] }), 'delete')).toBeDefined();
        expect(scoreItem(item('main', { group: 'Notes' }), 'notes')).toBeDefined();
    });

    it('scores a match in the label above a match in the keywords', () => {
        const inLabel = scoreItem(item('Open Settings'), 'settings') ?? 0;
        const inKeywords = scoreItem(item('Change the theme', { keywords: ['settings'] }), 'settings') ?? 0;
        expect(inLabel).toBeGreaterThan(inKeywords);
    });

    it('scores a match at the start of a word above a match in a word', () => {
        const start = scoreItem(item('Open Plans'), 'plan') ?? 0;
        const inside = scoreItem(item('Explanation'), 'plan') ?? 0;
        expect(start).toBeGreaterThan(inside);
    });
});

describe('paletteSections', () => {
    const items = [
        item('Open Notes', { group: 'Notes' }),
        item('Create a worktree'),
        item('feature/login', { searchOnly: true }),
        item('Open Settings', { group: 'Settings' })
    ];

    it('shows the commands in their groups, in the order of the groups, when the search is empty', () => {
        const sections = paletteSections(items, '');
        expect(sections.map(section => section.group)).toEqual(['Worktrees', 'Notes', 'Settings']);
        expect(sections[0].items.map(entry => entry.label)).toEqual(['Create a worktree']);
    });

    it('shows the search-only items in the results of a search', () => {
        const sections = paletteSections(items, 'login');
        expect(sections).toHaveLength(1);
        expect(sections[0].group).toBeUndefined();
        expect(sections[0].items.map(entry => entry.label)).toEqual(['feature/login']);
    });

    it('puts the best match first', () => {
        const [section] = paletteSections(items, 'open s');
        expect(section.items[0].label).toBe('Open Settings');
    });

    it('returns no sections when nothing matches', () => {
        expect(paletteSections(items, 'zzzz')).toEqual([]);
    });

    it('shows one section without a group for a page', () => {
        const sections = paletteSections(items, '', false);
        expect(sections).toHaveLength(1);
        expect(sections[0].group).toBeUndefined();
        expect(sections[0].items).toHaveLength(3);
    });
});

describe('nextIndex', () => {
    it('moves down and up, and wraps at the ends', () => {
        expect(nextIndex('ArrowDown', 0, 3)).toBe(1);
        expect(nextIndex('ArrowDown', 2, 3)).toBe(0);
        expect(nextIndex('ArrowUp', 0, 3)).toBe(2);
    });

    it('moves a page and stops at the ends', () => {
        expect(nextIndex('PageDown', 5, 10)).toBe(9);
        expect(nextIndex('PageUp', 5, 10)).toBe(0);
    });

    it('ignores other keys and empty lists', () => {
        expect(nextIndex('Home', 2, 3)).toBeUndefined();
        expect(nextIndex('ArrowDown', 0, 0)).toBeUndefined();
    });
});
