import { useEffect, useState } from 'react';
import {
    collapseStorageKey,
    isGroupCollapsed,
    parseCollapseState,
    parseViewMode,
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
 * The choices of the user that stay after a restart: the view mode and the collapsed groups of each plugin.
 */
export function useTaskViewPrefs(pluginId: string | undefined) {
    /** The list (grouped) or the board (a column for each status). */
    const [viewMode, setViewMode] = useState<ViewMode>(() => parseViewMode(readStorage(VIEW_STORAGE_KEY)));
    const [collapsed, setCollapsed] = useState<CollapseState>({});

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

    return { viewMode, changeViewMode, isCollapsed, toggleGroup };
}
