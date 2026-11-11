import { normalizeGroups, type SplitGroups } from '@shared/panes';

/**
 * The workspace layout of one repository that ShipWarden keeps after a restart:
 * the selected worktree, the main view, the open files and the active tab of each worktree.
 * Terminal tabs are not in this layout, because their processes stop when the app quits.
 */
export interface SavedLayout {
    selectedPath?: string;
    mainView?: 'dashboard' | 'worktree' | 'tasks' | 'agents' | 'review' | 'pipelines' | 'notes' | 'automations' | 'plans';
    /** The open files of each worktree, as paths relative to the worktree. */
    openFiles: Record<string, string[]>;
    /** The active tab of each worktree. */
    activeTabs: Record<string, string>;
    /** The split tabs of each worktree. The panes of tabs that do not exist after a restart are removed when they show. */
    panes: Record<string, SplitGroups>;
}

const STORAGE_PREFIX = 'shipwarden.layout:';

function emptyLayout(): SavedLayout {
    return { openFiles: {}, activeTabs: {}, panes: {} };
}

/** Converts stored JSON to a layout. Values with a wrong type are ignored. */
export function parseLayout(text: string | null): SavedLayout {
    if (!text) {
        return emptyLayout();
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return emptyLayout();
    }
    if (!value || typeof value !== 'object') {
        return emptyLayout();
    }
    const raw = value as Record<string, unknown>;
    const layout = emptyLayout();
    if (typeof raw.selectedPath === 'string') {
        layout.selectedPath = raw.selectedPath;
    }
    if (
        raw.mainView === 'dashboard' ||
        raw.mainView === 'worktree' ||
        raw.mainView === 'tasks' ||
        raw.mainView === 'agents' ||
        raw.mainView === 'review' ||
        raw.mainView === 'pipelines' ||
        raw.mainView === 'notes' ||
        raw.mainView === 'automations' ||
        raw.mainView === 'plans'
    ) {
        layout.mainView = raw.mainView;
    }
    if (raw.openFiles && typeof raw.openFiles === 'object') {
        for (const [root, files] of Object.entries(raw.openFiles as Record<string, unknown>)) {
            if (Array.isArray(files)) {
                layout.openFiles[root] = files.filter((file): file is string => typeof file === 'string');
            }
        }
    }
    if (raw.activeTabs && typeof raw.activeTabs === 'object') {
        for (const [root, tab] of Object.entries(raw.activeTabs as Record<string, unknown>)) {
            if (typeof tab === 'string') {
                layout.activeTabs[root] = tab;
            }
        }
    }
    if (raw.panes && typeof raw.panes === 'object') {
        for (const [root, value] of Object.entries(raw.panes as Record<string, unknown>)) {
            const groups = normalizeGroups(value);
            if (groups.length > 0) {
                layout.panes[root] = groups;
            }
        }
    }
    return layout;
}

/**
 * Removes the worktrees that do not exist now.
 * Keeps only the active tabs that a restart can show again: files, and terminal sessions that are still in `sessionIds`.
 */
export function pruneLayout(layout: SavedLayout, worktreePaths: readonly string[], sessionIds: readonly string[] = []): SavedLayout {
    const worktrees = new Set(worktreePaths);
    const sessions = new Set(sessionIds);
    const openFiles: Record<string, string[]> = {};
    for (const [root, files] of Object.entries(layout.openFiles)) {
        if (worktrees.has(root) && files.length > 0) {
            openFiles[root] = [...new Set(files)];
        }
    }
    const activeTabs: Record<string, string> = {};
    for (const [root, tab] of Object.entries(layout.activeTabs)) {
        if (!worktrees.has(root)) {
            continue;
        }
        const restorable = (tab.startsWith('f:') && openFiles[root]?.includes(tab.slice(2))) || (tab.startsWith('t:') && sessions.has(tab.slice(2)));
        if (restorable) {
            activeTabs[root] = tab;
        }
    }
    const panes = Object.fromEntries(Object.entries(layout.panes).filter(([root]) => worktrees.has(root)));
    return {
        selectedPath: layout.selectedPath && worktrees.has(layout.selectedPath) ? layout.selectedPath : undefined,
        mainView: layout.mainView,
        openFiles,
        activeTabs,
        panes
    };
}

export function readLayout(repoPath: string): SavedLayout {
    try {
        return parseLayout(localStorage.getItem(STORAGE_PREFIX + repoPath));
    } catch {
        return emptyLayout();
    }
}

export function writeLayout(repoPath: string, layout: SavedLayout): void {
    try {
        localStorage.setItem(STORAGE_PREFIX + repoPath, JSON.stringify(layout));
    } catch {
        // The layout stays for this session only.
    }
}
