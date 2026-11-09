/**
 * The split view of a worktree: a tree of panes. Each leaf pane shows one tab. A split shows two panes
 * next to each other ("row") or one above the other ("column"), like the splits of Ghostty.
 */
export type PaneNode =
    | { kind: 'leaf'; id: string; tab: string }
    | { kind: 'split'; id: string; direction: 'row' | 'column'; ratio: number; first: PaneNode; second: PaneNode };

export interface PaneLayout {
    root: PaneNode;
    /** The ID of the leaf that has the focus. The tab strip shows its tab as the active tab. */
    focused: string;
}

/** The side of a pane that gets a new pane. */
export type SplitSide = 'left' | 'right' | 'up' | 'down';

let counter = 0;

/** Makes a new pane ID. The prefix keeps IDs from older sessions different. */
export function newPaneId(): string {
    counter += 1;
    return `p${Date.now().toString(36)}${counter}`;
}

export function singlePane(tab: string): PaneLayout {
    const id = newPaneId();
    return { root: { kind: 'leaf', id, tab }, focused: id };
}

/** Returns the leaves from left to right and from top to bottom. */
export function leaves(node: PaneNode): Extract<PaneNode, { kind: 'leaf' }>[] {
    return node.kind === 'leaf' ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

export function findLeaf(layout: PaneLayout, id: string): Extract<PaneNode, { kind: 'leaf' }> | undefined {
    return leaves(layout.root).find(leaf => leaf.id === id);
}

/** Returns the leaf that shows a tab. */
export function leafOfTab(layout: PaneLayout, tab: string): Extract<PaneNode, { kind: 'leaf' }> | undefined {
    return leaves(layout.root).find(leaf => leaf.tab === tab);
}

export function focusedTab(layout: PaneLayout): string | undefined {
    return findLeaf(layout, layout.focused)?.tab;
}

function mapNode(node: PaneNode, change: (node: PaneNode) => PaneNode | undefined): PaneNode {
    const changed = change(node);
    if (changed) return changed;
    if (node.kind === 'split') {
        return { ...node, first: mapNode(node.first, change), second: mapNode(node.second, change) };
    }
    return node;
}

/** Removes a leaf. Its sibling takes the space of the split. Returns undefined when the layout has no leaf after it. */
function removeNode(node: PaneNode, id: string): PaneNode | undefined {
    if (node.kind === 'leaf') return node.id === id ? undefined : node;
    const first = removeNode(node.first, id);
    const second = removeNode(node.second, id);
    if (!first) return second;
    if (!second) return first;
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Shows a tab in a leaf. */
export function showTab(layout: PaneLayout, leafId: string, tab: string): PaneLayout {
    return { ...layout, root: mapNode(layout.root, node => (node.kind === 'leaf' && node.id === leafId ? { ...node, tab } : undefined)) };
}

/**
 * Shows a tab in the focused pane, like a click on the tab. When another pane shows the tab already, that pane
 * gets the focus instead, because a tab can be in only one pane.
 */
export function activateTab(layout: PaneLayout, tab: string): PaneLayout {
    const shown = leafOfTab(layout, tab);
    if (shown) return { ...layout, focused: shown.id };
    return showTab(layout, layout.focused, tab);
}

/**
 * Splits a leaf and shows `tab` in the new pane at `side`. When another pane shows the tab, that pane closes first.
 * The new pane gets the focus.
 */
export function splitPane(layout: PaneLayout, leafId: string, tab: string, side: SplitSide): PaneLayout {
    let base = layout;
    const shown = leafOfTab(layout, tab);
    if (shown) {
        // Dropping a tab on its own pane does nothing.
        if (shown.id === leafId) return layout;
        base = closePane(layout, shown.id) ?? layout;
    }
    const target = findLeaf(base, leafId);
    if (!target) return layout;
    const id = newPaneId();
    const created: PaneNode = { kind: 'leaf', id, tab };
    const direction = side === 'left' || side === 'right' ? 'row' : 'column';
    const before = side === 'left' || side === 'up';
    const root = mapNode(base.root, node => (node.kind === 'leaf' && node.id === leafId
        ? { kind: 'split', id: newPaneId(), direction, ratio: 0.5, first: before ? created : node, second: before ? node : created }
        : undefined));
    return { root, focused: id };
}

/** Closes a pane. The focus goes to the first remaining pane when the closed pane had it. Undefined: no pane remains. */
export function closePane(layout: PaneLayout, leafId: string): PaneLayout | undefined {
    const root = removeNode(layout.root, leafId);
    if (!root) return undefined;
    const focused = layout.focused === leafId || !leaves(root).some(leaf => leaf.id === layout.focused) ? leaves(root)[0].id : layout.focused;
    return { root, focused };
}

/** Changes the size of the first pane of a split, between 10% and 90%. */
export function resizeSplit(layout: PaneLayout, splitId: string, ratio: number): PaneLayout {
    const clamped = Math.min(0.9, Math.max(0.1, ratio));
    return { ...layout, root: mapNode(layout.root, node => (node.kind === 'split' && node.id === splitId ? { ...node, ratio: clamped } : undefined)) };
}

interface PaneRect {
    id: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Returns the area of each leaf, as parts of the full area (0 to 1). */
function paneRects(node: PaneNode, left = 0, top = 0, right = 1, bottom = 1): PaneRect[] {
    if (node.kind === 'leaf') return [{ id: node.id, left, top, right, bottom }];
    if (node.direction === 'row') {
        const middle = left + (right - left) * node.ratio;
        return [...paneRects(node.first, left, top, middle, bottom), ...paneRects(node.second, middle, top, right, bottom)];
    }
    const middle = top + (bottom - top) * node.ratio;
    return [...paneRects(node.first, left, top, right, middle), ...paneRects(node.second, left, middle, right, bottom)];
}

const EDGE_TOLERANCE = 1e-6;

/**
 * Moves the focus to the nearest pane at `side` of the focused pane, as ⌥⌘ and the arrow keys in Ghostty.
 * A pane must be next to the focused pane and share part of its edge. When two panes do this, the pane nearer to
 * the middle of the focused pane gets the focus. When no pane is at that side, the layout does not change.
 */
export function focusSide(layout: PaneLayout, side: SplitSide): PaneLayout {
    const rects = paneRects(layout.root);
    const current = rects.find(rect => rect.id === layout.focused);
    if (!current) return layout;
    const horizontal = side === 'left' || side === 'right';
    const middle = horizontal ? (current.top + current.bottom) / 2 : (current.left + current.right) / 2;
    let best: { id: string; distance: number; offset: number } | undefined;
    for (const rect of rects) {
        if (rect.id === current.id) continue;
        const distance = side === 'left' ? current.left - rect.right
            : side === 'right' ? rect.left - current.right
                : side === 'up' ? current.top - rect.bottom
                    : rect.top - current.bottom;
        if (distance < -EDGE_TOLERANCE) continue;
        const [start, end] = horizontal ? [rect.top, rect.bottom] : [rect.left, rect.right];
        const [currentStart, currentEnd] = horizontal ? [current.top, current.bottom] : [current.left, current.right];
        if (Math.min(end, currentEnd) - Math.max(start, currentStart) <= EDGE_TOLERANCE) continue;
        const offset = middle < start ? start - middle : middle > end ? middle - end : 0;
        if (!best || distance < best.distance - EDGE_TOLERANCE || (Math.abs(distance - best.distance) <= EDGE_TOLERANCE && offset < best.offset)) {
            best = { id: rect.id, distance, offset };
        }
    }
    return best ? { ...layout, focused: best.id } : layout;
}

/**
 * Removes the panes whose tab does not exist any more, for example a closed terminal.
 * `fallback` gives a tab for the last pane when all panes are removed. Undefined: no tab exists.
 */
export function pruneLayout(layout: PaneLayout, tabs: string[], fallback?: string): PaneLayout | undefined {
    let current: PaneLayout | undefined = layout;
    for (const leaf of leaves(layout.root)) {
        if (!tabs.includes(leaf.tab) && current) {
            const next: PaneLayout | undefined = closePane(current, leaf.id);
            if (!next) {
                return fallback ? showTab(current, leaf.id, fallback) : undefined;
            }
            current = next;
        }
    }
    return current;
}

/** Converts a stored value to a valid layout, or undefined. */
export function normalizeLayout(value: unknown): PaneLayout | undefined {
    const node = (raw: unknown, depth: number): PaneNode | undefined => {
        if (!raw || typeof raw !== 'object' || depth > 12) return undefined;
        const item = raw as Record<string, unknown>;
        if (typeof item.id !== 'string') return undefined;
        if (item.kind === 'leaf' && typeof item.tab === 'string') return { kind: 'leaf', id: item.id, tab: item.tab };
        if (item.kind === 'split' && (item.direction === 'row' || item.direction === 'column')) {
            const first = node(item.first, depth + 1);
            const second = node(item.second, depth + 1);
            const ratio = typeof item.ratio === 'number' && item.ratio >= 0.1 && item.ratio <= 0.9 ? item.ratio : 0.5;
            if (first && second) return { kind: 'split', id: item.id, direction: item.direction, ratio, first, second };
        }
        return undefined;
    };
    const raw = value as { root?: unknown; focused?: unknown } | undefined;
    const root = node(raw?.root, 0);
    if (!root) return undefined;
    const ids = leaves(root).map(leaf => leaf.id);
    return { root, focused: typeof raw?.focused === 'string' && ids.includes(raw.focused) ? raw.focused : ids[0] };
}

/** The leaf to focus in a node: its first leaf. */
function firstLeaf(node: PaneNode): Extract<PaneNode, { kind: 'leaf' }> {
    return leaves(node)[0];
}

/**
 * Puts a node (one pane, or the whole split of another tab) at a side of a leaf. The leaves of `node` must not be in
 * the layout. The focus goes to `focus` (a leaf of `node`), else to its first leaf.
 */
export function insertNode(layout: PaneLayout, leafId: string, node: PaneNode, side: SplitSide, focus?: string): PaneLayout {
    if (!findLeaf(layout, leafId)) return layout;
    const direction = side === 'left' || side === 'right' ? 'row' : 'column';
    const before = side === 'left' || side === 'up';
    const root = mapNode(layout.root, item => (item.kind === 'leaf' && item.id === leafId
        ? { kind: 'split', id: newPaneId(), direction, ratio: 0.5, first: before ? node : item, second: before ? item : node }
        : undefined));
    const ids = leaves(node).map(leaf => leaf.id);
    return { root, focused: focus && ids.includes(focus) ? focus : firstLeaf(node).id };
}

/**
 * The split tabs of a worktree. Each group is one tab in the tab strip with two or more panes.
 * A tab that is in no group is a normal tab with one view.
 */
export type SplitGroups = PaneLayout[];

/** Returns the group that has a tab in one of its panes. */
export function groupOf(groups: SplitGroups, tab: string): PaneLayout | undefined {
    return groups.find(group => !!leafOfTab(group, tab));
}

/** A layout of one tab, for a tab that is in no group yet. */
export function tabLayout(groups: SplitGroups, tab: string): PaneLayout {
    const group = groupOf(groups, tab);
    if (!group) {
        const id = newPaneId();
        return { root: { kind: 'leaf', id, tab }, focused: id };
    }
    // The focus is on the pane of the tab.
    return { ...group, focused: leafOfTab(group, tab)!.id };
}

/** Replaces the group of `tab` (or adds a group). A layout with one pane is no group, so it is removed. */
export function setGroup(groups: SplitGroups, tab: string, layout: PaneLayout | undefined): SplitGroups {
    const others = groups.filter(group => !leafOfTab(group, tab) && (!layout || !leaves(layout.root).some(leaf => leafOfTab(group, leaf.tab))));
    return layout && layout.root.kind === 'split' ? [...others, layout] : others;
}

/** Removes the panes of tabs that do not exist, and the groups with fewer than two panes after that. */
export function pruneGroups(groups: SplitGroups, tabs: string[]): SplitGroups {
    return groups
        .map(group => pruneLayout(group, tabs))
        .filter((group): group is PaneLayout => !!group && group.root.kind === 'split');
}

export function normalizeGroups(value: unknown): SplitGroups {
    // The first version kept one layout for each worktree, not a list.
    const list = Array.isArray(value) ? value : value ? [value] : [];
    const seen = new Set<string>();
    const groups: SplitGroups = [];
    for (const item of list) {
        const layout = normalizeLayout(item);
        if (!layout || layout.root.kind !== 'split') continue;
        const tabs = leaves(layout.root).map(leaf => leaf.tab);
        if (tabs.some(tab => seen.has(tab))) continue;
        tabs.forEach(tab => seen.add(tab));
        groups.push(layout);
    }
    return groups;
}
