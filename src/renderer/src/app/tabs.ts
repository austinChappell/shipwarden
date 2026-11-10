import type { CheckRun, PullRequest, PullRequestFile } from '@shared/github';
import type { ChangeSide, FileChange } from '@shared/git';
import { focusedTab, groupOf, leafOfTab, leaves, setGroup, type PaneLayout, type SplitGroups, type SplitSide } from '@shared/panes';

/**
 * A tab is a terminal session ("t:<id>"), a file ("f:<relative path>"),
 * a pull request diff ("d:<relative path>"), a CI job log ("l:<job id>") or an in-app browser tab ("b:<view id>").
 */
export type TabKey = string;

/** A diff tab, a log tab or a browser tab. */
export type ExtraTab =
    | { key: TabKey; kind: 'diff'; pr: PullRequest; file: PullRequestFile; line?: number; nonce?: number }
    | { key: TabKey; kind: 'log'; check: CheckRun }
    | { key: TabKey; kind: 'change'; change: FileChange; side: ChangeSide }
    | { key: TabKey; kind: 'changes' }
    | { key: TabKey; kind: 'browser'; id: string };

/** An entry of the tab strip: a tab, or a split tab with its panes. */
export interface StripItem {
    key: TabKey;
    group?: PaneLayout;
}

/** The key of a set of dirty files. One key identifies one file in one worktree. */
export function fileKey(root: string, path: string): string {
    return `${root}\0${path}`;
}

/** Returns the tab keys of a worktree, in the order of its tab strip: terminals, then files, then the other tabs. */
export function worktreeTabKeys(sessionIds: readonly string[], files: readonly string[], extras: readonly ExtraTab[]): TabKey[] {
    return [...sessionIds.map(id => `t:${id}`), ...files.map(path => `f:${path}`), ...extras.map(tab => tab.key)];
}

/** Returns the requested tab when it exists. Else returns the first tab. */
export function pickActiveTab(tabKeys: readonly TabKey[], requested: TabKey | undefined): TabKey | undefined {
    return requested && tabKeys.includes(requested) ? requested : tabKeys[0];
}

/**
 * Returns the panes of the active tab: its split, with the focus on the pane of the active tab, or one pane.
 * The single pane has a fixed ID, so a change of the tab does not make a new pane.
 */
export function activeLayout(groups: SplitGroups, activeTab: TabKey | undefined): PaneLayout | undefined {
    if (!activeTab) return undefined;
    const group = groupOf(groups, activeTab);
    return group ? { ...group, focused: leafOfTab(group, activeTab)!.id } : { root: { kind: 'leaf', id: 'main', tab: activeTab }, focused: 'main' };
}

/**
 * Returns the entries of the tab strip, in the order of the tabs: a tab, or a split tab at the place of its first pane.
 * A split tab shows the title of its focused pane.
 */
export function stripItemsOf(tabKeys: readonly TabKey[], groups: SplitGroups, activeTab: TabKey | undefined): StripItem[] {
    const items: StripItem[] = [];
    for (const key of tabKeys) {
        const group = groupOf(groups, key);
        if (!group) {
            items.push({ key });
        } else if (!items.some(item => item.group === group)) {
            const shown = leafOfTab(group, activeTab ?? '') ? activeTab! : (focusedTab(group) ?? key);
            items.push({ key: shown, group });
        }
    }
    return items;
}

/** True when the entry is the active tab, or when it is a split tab with the active tab in it. */
export function isStripItemActive(item: StripItem, activeTab: TabKey | undefined): boolean {
    return item.group ? !!activeTab && !!leafOfTab(item.group, activeTab) : item.key === activeTab;
}

/** Returns the tabs of each entry of the tab strip. A split tab gives the tabs of all its panes. */
export function stripEntries(items: readonly StripItem[]): TabKey[][] {
    return items.map(item => (item.group ? leaves(item.group.root).map(leaf => leaf.tab) : [item.key]));
}

/**
 * Returns the index of the strip entry that a tab shortcut selects. "previousTab" and "nextTab" wrap at the ends.
 * "selectTab3" gives index 2. The index can be outside the list, for example for "selectTab9" with 2 entries.
 */
export function stripTargetIndex(action: string, current: number, length: number): number {
    if (action === 'previousTab') return (current - 1 + length) % length;
    if (action === 'nextTab') return (current + 1) % length;
    if (action === 'selectLastTab') return length - 1;
    return Number(action.slice('selectTab'.length)) - 1;
}

/** True for the shortcut actions that select a tab of the tab strip. */
export function isTabSelectAction(action: string): boolean {
    return action === 'previousTab' || action === 'nextTab' || action === 'selectLastTab' || action.startsWith('selectTab');
}

/** Adds a tab at the end of the list. A tab with the same key gets the new value at its old place. */
export function upsertTab(list: readonly ExtraTab[], tab: ExtraTab): ExtraTab[] {
    const index = list.findIndex(item => item.key === tab.key);
    return index === -1 ? [...list, tab] : list.map(item => (item.key === tab.key ? tab : item));
}

/**
 * Saves the split of the tab `anchor` in the splits of a worktree. An undefined layout ends the split.
 * A worktree without splits has no entry in the map.
 */
export function withGroup(map: Record<string, SplitGroups>, path: string, anchor: TabKey, next: PaneLayout | undefined): Record<string, SplitGroups> {
    const groups = setGroup(map[path] ?? [], anchor, next);
    const copy = { ...map };
    if (groups.length > 0) copy[path] = groups;
    else delete copy[path];
    return copy;
}

/** Returns a copy of the map without the key. */
export function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
    const next = { ...map };
    delete next[key];
    return next;
}

/**
 * Returns the pane side that is nearest to a point. `x` and `y` are the position in the pane, from 0 to 1.
 * The dropped tab goes to that side.
 */
export function nearestSide(x: number, y: number): SplitSide {
    const edges: [SplitSide, number][] = [
        ['left', x],
        ['right', 1 - x],
        ['up', y],
        ['down', 1 - y]
    ];
    return edges.reduce((best, item) => (item[1] < best[1] ? item : best))[0];
}

/** Returns the IDs of all browser tabs of all worktrees. */
export function browserIds(extraTabs: Record<string, readonly ExtraTab[]>): Set<string> {
    return new Set(
        Object.values(extraTabs)
            .flat()
            .flatMap(tab => (tab.kind === 'browser' ? [tab.id] : []))
    );
}

/** Returns the worktree that has the browser tab with this ID. */
export function worktreeOfBrowser(extraTabs: Record<string, readonly ExtraTab[]>, id: string): string | undefined {
    return Object.entries(extraTabs).find(([, tabs]) => tabs.some(tab => tab.kind === 'browser' && tab.id === id))?.[0];
}

/** Removes from the active tabs each file tab whose file is not open. Other tabs stay. */
export function keepOpenFileTabs(activeTabs: Record<string, TabKey>, openFiles: Record<string, string[]>): Record<string, TabKey> {
    return Object.fromEntries(Object.entries(activeTabs).filter(([root, tab]) => !tab.startsWith('f:') || openFiles[root]?.includes(tab.slice(2))));
}
