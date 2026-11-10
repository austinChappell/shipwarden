import { useEffect, useState } from 'react';
import {
    collapseStorageKey,
    isGroupCollapsed,
    parseCollapseState,
    parseViewMode,
    startRepoKey,
    toggleCollapse,
    VIEW_STORAGE_KEY,
    type CollapseState,
    type ViewMode
} from './task-view-logic';

function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

/** Writes the value. When the storage fails, the value stays for this session only. */
function writeStorage(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // The value stays for this session only.
    }
}

/**
 * The choices of the user that stay after a restart: the view mode, the collapsed groups of each plugin,
 * and the repository for "Start in worktree" in each project.
 */
export function useTaskViewPrefs(projectId: string, pluginId: string | undefined) {
    /** The list (grouped) or the board (a column for each status). */
    const [viewMode, setViewMode] = useState<ViewMode>(() => parseViewMode(readStorage(VIEW_STORAGE_KEY)));
    const [collapsed, setCollapsed] = useState<CollapseState>({});
    /** The repository for "Start in worktree", when the project has several. */
    const [startRepo, setStartRepo] = useState<string>(() => readStorage(startRepoKey(projectId)) ?? '');

    useEffect(() => {
        setCollapsed(pluginId ? parseCollapseState(readStorage(collapseStorageKey(pluginId))) : {});
    }, [pluginId]);

    const changeViewMode = (value: ViewMode) => {
        setViewMode(value);
        writeStorage(VIEW_STORAGE_KEY, value);
    };

    /** `key` identifies the group: the status key, or "board:<status key>" for a board column. */
    const isCollapsed = (key: string, byDefault: boolean) => isGroupCollapsed(collapsed, key, byDefault);

    const toggleGroup = (key: string, byDefault: boolean) => {
        if (!pluginId) return;
        const next = toggleCollapse(collapsed, key, byDefault);
        setCollapsed(next);
        writeStorage(collapseStorageKey(pluginId), JSON.stringify(next));
    };

    const chooseStartRepo = (repo: string) => {
        setStartRepo(repo);
        writeStorage(startRepoKey(projectId), repo);
    };

    return { viewMode, changeViewMode, isCollapsed, toggleGroup, startRepo, chooseStartRepo };
}
