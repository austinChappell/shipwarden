import { describe, expect, it } from 'vitest';
import {
    activateTab,
    closePane,
    cycleFocus,
    focusedTab,
    groupOf,
    insertNode,
    leaves,
    normalizeGroups,
    pruneGroups,
    setGroup,
    tabLayout,
    normalizeLayout,
    pruneLayout,
    resizeSplit,
    singlePane,
    splitPane,
    type PaneLayout
} from './panes';

const tabsOf = (layout: PaneLayout | undefined) => (layout ? leaves(layout.root).map(leaf => leaf.tab) : []);

describe('panes', () => {
    it('splits a pane to each side and focuses the new pane', () => {
        const one = singlePane('t:a');
        const right = splitPane(one, one.focused, 't:b', 'right');
        expect(tabsOf(right)).toEqual(['t:a', 't:b']);
        expect(focusedTab(right)).toBe('t:b');
        expect(right.root).toMatchObject({ kind: 'split', direction: 'row', ratio: 0.5 });

        const up = splitPane(one, one.focused, 't:b', 'up');
        expect(tabsOf(up)).toEqual(['t:b', 't:a']);
        expect(up.root).toMatchObject({ direction: 'column' });
    });

    it('moves a tab that another pane shows, and ignores a drop on its own pane', () => {
        const one = singlePane('t:a');
        const two = splitPane(one, one.focused, 't:b', 'right');
        const leftId = leaves(two.root)[0].id;
        const bId = leaves(two.root)[1].id;
        // Drag "b" below "a": the right pane closes, and "a" splits down.
        const moved = splitPane(two, leftId, 't:b', 'down');
        expect(tabsOf(moved)).toEqual(['t:a', 't:b']);
        expect(moved.root).toMatchObject({ direction: 'column' });
        expect(splitPane(two, bId, 't:b', 'left')).toBe(two);
    });

    it('activates a tab in the focused pane, or focuses the pane that shows it', () => {
        const one = singlePane('t:a');
        const layout = splitPane(one, one.focused, 't:b', 'right');
        expect(focusedTab(activateTab(layout, 'f:x'))).toBe('f:x');
        expect(tabsOf(activateTab(layout, 'f:x'))).toEqual(['t:a', 'f:x']);
        const focusA = activateTab(layout, 't:a');
        expect(focusedTab(focusA)).toBe('t:a');
        expect(tabsOf(focusA)).toEqual(['t:a', 't:b']);
    });

    it('ignores a split of a pane that does not exist', () => {
        const one = singlePane('t:a');
        expect(splitPane(one, 'missing', 't:b', 'right')).toBe(one);
    });

    it('closes a pane, and the sibling takes the space', () => {
        const one = singlePane('t:a');
        const three = splitPane(splitPane(one, one.focused, 't:b', 'right'), one.focused, 't:c', 'down');
        expect(tabsOf(three)).toEqual(['t:a', 't:c', 't:b']);
        const closed = closePane(three, three.focused);
        expect(tabsOf(closed)).toEqual(['t:a', 't:b']);
        expect(closePane(one, one.focused)).toBeUndefined();
    });

    it('removes panes of closed tabs, with a fallback for the last pane', () => {
        const one = singlePane('t:a');
        const two = splitPane(one, one.focused, 't:b', 'right');
        expect(tabsOf(pruneLayout(two, ['t:a']))).toEqual(['t:a']);
        expect(tabsOf(pruneLayout(two, ['f:x'], 'f:x'))).toEqual(['f:x']);
        expect(pruneLayout(two, [])).toBeUndefined();
    });

    it('resizes within limits and cycles the focus', () => {
        const one = singlePane('t:a');
        const two = splitPane(one, one.focused, 't:b', 'right');
        expect(resizeSplit(two, two.root.id, 0.02).root).toMatchObject({ ratio: 0.1 });
        expect(focusedTab(cycleFocus(two, 1))).toBe('t:a');
        expect(focusedTab(cycleFocus(cycleFocus(two, 1), -1))).toBe('t:b');
    });

    it('reads a stored layout and refuses a bad one', () => {
        const one = singlePane('t:a');
        const two = splitPane(one, one.focused, 't:b', 'right');
        expect(normalizeLayout(JSON.parse(JSON.stringify(two)))).toEqual(two);
        expect(normalizeLayout({ root: { kind: 'split', id: 'x', direction: 'row', first: { kind: 'leaf', id: 'a', tab: 't:a' } } })).toBeUndefined();
        expect(normalizeLayout({ root: { kind: 'leaf', id: 'a', tab: 't:a' }, focused: 'gone' })?.focused).toBe('a');
    });
});

describe('split groups', () => {
    it('makes a group from a tab and a new pane, and removes it with one pane left', () => {
        const base = tabLayout([], 't:a');
        const layout = splitPane(base, base.focused, 't:b', 'right');
        const groups = setGroup([], 't:a', layout);
        expect(groups).toHaveLength(1);
        expect(groupOf(groups, 't:b')).toBe(layout);
        expect(tabLayout(groups, 't:a').focused).toBe(leaves(layout.root)[0].id);
        expect(pruneGroups(groups, ['t:a', 'f:x'])).toEqual([]);
        expect(setGroup(groups, 't:a', closePane(layout, layout.focused))).toEqual([]);
    });

    it('puts the split of another tab at a side of a pane', () => {
        const one = tabLayout([], 't:a');
        const b = tabLayout([], 't:b');
        const other = splitPane(b, b.focused, 't:c', 'down');
        const otherWithFocus = { ...other, focused: leaves(other.root)[1].id };
        const merged = insertNode(one, one.focused, otherWithFocus.root, 'right', otherWithFocus.focused);
        expect(tabsOf(merged)).toEqual(['t:a', 't:b', 't:c']);
        expect(focusedTab(merged)).toBe('t:c');
        expect(merged.root).toMatchObject({ direction: 'row', second: { direction: 'column' } });
    });

    it('reads stored groups, also the single layout of the first version', () => {
        const one = tabLayout([], 't:a');
        const layout = splitPane(one, one.focused, 't:b', 'right');
        const stored = JSON.parse(JSON.stringify(layout));
        expect(normalizeGroups(stored)).toEqual([layout]);
        expect(normalizeGroups([stored, stored])).toEqual([layout]);
        expect(normalizeGroups([{ root: { kind: 'leaf', id: 'x', tab: 't:z' }, focused: 'x' }])).toEqual([]);
    });
});
