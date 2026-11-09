/**
 * The back and forward history of the app, as in a web browser. Each entry is one place in the app: a view, and in
 * the worktree view also the worktree and its active tab. ⌘[ goes back and ⌘] goes forward.
 */
export interface NavLocation {
    view: string;
    /** The selected worktree. Only for the worktree view. */
    worktree?: string;
    /** The active tab of the worktree. In a split tab, this is the focused pane. Only for the worktree view. */
    tab?: string;
    /** The repository of the commit graph. Only for the commit graph view. */
    repo?: string;
}

export interface NavHistory {
    entries: NavLocation[];
    /** The index of the current entry. It is -1 when the history is empty. */
    index: number;
}

/** The maximum number of entries. The history removes the oldest entry when it has more. */
export const NAV_HISTORY_LIMIT = 100;

export const EMPTY_NAV_HISTORY: NavHistory = { entries: [], index: -1 };

export function sameLocation(a: NavLocation | undefined, b: NavLocation | undefined): boolean {
    return !!a && !!b && a.view === b.view && a.worktree === b.worktree && a.tab === b.tab && a.repo === b.repo;
}

/**
 * Adds a location after the current entry, as a new page in a web browser. The forward entries are removed.
 * When the location is the current entry, the history does not change.
 */
export function recordLocation(history: NavHistory, location: NavLocation): NavHistory {
    if (sameLocation(history.entries[history.index], location)) return history;
    const entries = [...history.entries.slice(0, history.index + 1), location].slice(-NAV_HISTORY_LIMIT);
    return { entries, index: entries.length - 1 };
}

/**
 * Moves one step back (-1) or forward (1). The step skips each entry that `isValid` rejects, for example a closed tab,
 * and each entry that is the same as the current location. Returns undefined when no valid entry is in that direction.
 */
export function stepHistory(
    history: NavHistory,
    step: 1 | -1,
    isValid: (location: NavLocation) => boolean
): { history: NavHistory; location: NavLocation } | undefined {
    const current = history.entries[history.index];
    for (let index = history.index + step; index >= 0 && index < history.entries.length; index += step) {
        const location = history.entries[index];
        if (isValid(location) && !sameLocation(location, current)) {
            return { history: { ...history, index }, location };
        }
    }
    return undefined;
}
