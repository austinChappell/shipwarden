import { describe, expect, it } from 'vitest';
import type { PaneLayout } from '@shared/panes';
import {
    activeLayout,
    browserIds,
    fileKey,
    isStripItemActive,
    isTabSelectAction,
    keepOpenFileTabs,
    nearestSide,
    pickActiveTab,
    stripEntries,
    stripItemsOf,
    stripTargetIndex,
    upsertTab,
    withGroup,
    withoutKey,
    worktreeOfBrowser,
    worktreeTabKeys,
    type ExtraTab
} from './tabs';

/** A split of two panes: "t:a" at the left and "f:b" at the right, with the focus on the right pane. */
const group: PaneLayout = {
    root: {
        kind: 'split',
        id: 's1',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', id: 'p1', tab: 't:a' },
        second: { kind: 'leaf', id: 'p2', tab: 'f:b' }
    },
    focused: 'p2'
};

const browser = (id: string): ExtraTab => ({ key: `b:${id}`, kind: 'browser', id });

describe('fileKey', () => {
    it('makes a different key for the same path in two worktrees', () => {
        expect(fileKey('/one', 'a.ts')).not.toBe(fileKey('/two', 'a.ts'));
        expect(fileKey('/one', 'a.ts')).toBe(fileKey('/one', 'a.ts'));
    });
});

describe('worktreeTabKeys', () => {
    it('puts the terminals first, then the files, then the other tabs', () => {
        expect(worktreeTabKeys(['1', '2'], ['src/a.ts'], [{ key: 'c:all', kind: 'changes' }])).toEqual(['t:1', 't:2', 'f:src/a.ts', 'c:all']);
    });

    it('returns an empty list for a worktree without tabs', () => {
        expect(worktreeTabKeys([], [], [])).toEqual([]);
    });
});

describe('pickActiveTab', () => {
    it('keeps the requested tab when it exists', () => {
        expect(pickActiveTab(['t:1', 'f:a'], 'f:a')).toBe('f:a');
    });

    it('selects the first tab when the requested tab closed or no tab is requested', () => {
        expect(pickActiveTab(['t:1', 'f:a'], 'f:gone')).toBe('t:1');
        expect(pickActiveTab(['t:1'], undefined)).toBe('t:1');
    });

    it('returns undefined when the worktree has no tabs', () => {
        expect(pickActiveTab([], 't:1')).toBeUndefined();
    });
});

describe('activeLayout', () => {
    it('returns undefined without an active tab', () => {
        expect(activeLayout([group], undefined)).toBeUndefined();
    });

    it('returns one pane with a fixed ID for a tab that is in no split', () => {
        expect(activeLayout([group], 't:c')).toEqual({ root: { kind: 'leaf', id: 'main', tab: 't:c' }, focused: 'main' });
    });

    it('returns the split with the focus on the pane of the active tab', () => {
        const layout = activeLayout([group], 't:a');
        expect(layout?.root).toBe(group.root);
        expect(layout?.focused).toBe('p1');
    });
});

describe('stripItemsOf', () => {
    it('shows a split as one entry at the place of its first pane', () => {
        const items = stripItemsOf(['t:x', 't:a', 'f:b', 'f:y'], [group], 't:x');
        expect(items.map(item => item.key)).toEqual(['t:x', 'f:b', 'f:y']);
        expect(items[1].group).toBe(group);
    });

    it('shows the active tab as the title of its split', () => {
        const items = stripItemsOf(['t:a', 'f:b'], [group], 't:a');
        expect(items).toEqual([{ key: 't:a', group }]);
    });
});

describe('isStripItemActive', () => {
    it('is true for the active tab and for a split with the active tab', () => {
        expect(isStripItemActive({ key: 't:x' }, 't:x')).toBe(true);
        expect(isStripItemActive({ key: 'f:b', group }, 't:a')).toBe(true);
    });

    it('is false for other entries', () => {
        expect(isStripItemActive({ key: 't:x' }, 't:y')).toBe(false);
        expect(isStripItemActive({ key: 'f:b', group }, 't:x')).toBe(false);
        expect(isStripItemActive({ key: 'f:b', group }, undefined)).toBe(false);
    });
});

describe('stripEntries', () => {
    it('gives the tabs of all panes of a split', () => {
        expect(stripEntries([{ key: 't:x' }, { key: 'f:b', group }])).toEqual([['t:x'], ['t:a', 'f:b']]);
    });
});

describe('stripTargetIndex', () => {
    it('wraps at the ends for the previous and the next tab', () => {
        expect(stripTargetIndex('previousTab', 0, 3)).toBe(2);
        expect(stripTargetIndex('nextTab', 2, 3)).toBe(0);
        expect(stripTargetIndex('nextTab', 0, 3)).toBe(1);
    });

    it('selects the last tab and the tab of a number key', () => {
        expect(stripTargetIndex('selectLastTab', 0, 4)).toBe(3);
        expect(stripTargetIndex('selectTab1', 2, 4)).toBe(0);
        expect(stripTargetIndex('selectTab9', 0, 2)).toBe(8);
    });
});

describe('isTabSelectAction', () => {
    it('accepts only the shortcuts that select a tab', () => {
        expect(['previousTab', 'nextTab', 'selectLastTab', 'selectTab4'].every(isTabSelectAction)).toBe(true);
        expect(isTabSelectAction('close')).toBe(false);
        expect(isTabSelectAction('newTab')).toBe(false);
    });
});

describe('upsertTab', () => {
    it('adds a new tab at the end', () => {
        expect(upsertTab([browser('1')], browser('2')).map(tab => tab.key)).toEqual(['b:1', 'b:2']);
    });

    it('replaces a tab with the same key at its old place', () => {
        const list: ExtraTab[] = [{ key: 'c:all', kind: 'changes' }, browser('1')];
        const next = upsertTab(list, { key: 'c:all', kind: 'changes' });
        expect(next).toHaveLength(2);
        expect(next[0]).not.toBe(list[0]);
        expect(next[1]).toBe(list[1]);
    });
});

describe('withGroup', () => {
    it('saves a split of a worktree', () => {
        expect(withGroup({}, '/w', 't:a', group)).toEqual({ '/w': [group] });
    });

    it('removes the entry of the worktree when its last split ends', () => {
        const map = { '/w': [group], '/other': [group] };
        expect(withGroup(map, '/w', 't:a', undefined)).toEqual({ '/other': [group] });
        expect(map['/w']).toEqual([group]);
    });
});

describe('withoutKey', () => {
    it('returns a copy without the key', () => {
        const map = { a: 1, b: 2 };
        expect(withoutKey(map, 'a')).toEqual({ b: 2 });
        expect(map).toEqual({ a: 1, b: 2 });
    });
});

describe('nearestSide', () => {
    it('returns the side of the nearest edge', () => {
        expect(nearestSide(0.1, 0.5)).toBe('left');
        expect(nearestSide(0.9, 0.5)).toBe('right');
        expect(nearestSide(0.5, 0.1)).toBe('up');
        expect(nearestSide(0.5, 0.95)).toBe('down');
    });

    it('selects the first side in the order left, right, up, down when two edges have the same distance', () => {
        expect(nearestSide(0.5, 0.5)).toBe('left');
    });
});

describe('browserIds and worktreeOfBrowser', () => {
    const extraTabs: Record<string, ExtraTab[]> = {
        '/one': [browser('1'), { key: 'c:all', kind: 'changes' }],
        '/two': [browser('2')]
    };

    it('collects the IDs of all browser tabs', () => {
        expect([...browserIds(extraTabs)].sort()).toEqual(['1', '2']);
    });

    it('finds the worktree of a browser tab', () => {
        expect(worktreeOfBrowser(extraTabs, '2')).toBe('/two');
        expect(worktreeOfBrowser(extraTabs, '3')).toBeUndefined();
    });
});

describe('keepOpenFileTabs', () => {
    it('removes a file tab whose file is not open, and keeps the other tabs', () => {
        const active = { '/a': 'f:gone.ts', '/b': 'f:open.ts', '/c': 't:1' };
        expect(keepOpenFileTabs(active, { '/b': ['open.ts'] })).toEqual({ '/b': 'f:open.ts', '/c': 't:1' });
    });
});
