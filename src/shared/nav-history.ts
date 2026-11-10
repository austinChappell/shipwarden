/**
 * The back and forward history of the app, as in a web browser. Each entry is one page of the app. ⌘[ goes back and
 * ⌘] goes forward.
 *
 * A location has two parts, as a web address:
 * - The page: the view, the worktree, the tab, the repository and the `page` of the view. A different page adds an entry.
 * - The query: the selections in the page, for example the tab of the right panel. A change of the query replaces the
 *   current entry, so it adds no entry. A step back shows the page with the query that it had last.
 */
export interface NavLocation {
    view: string;
    /** The selected worktree. Only for the worktree view. */
    worktree?: string;
    /** The active tab of the worktree. In a split tab, this is the focused pane. Only for the worktree view. */
    tab?: string;
    /** The repository of the commit graph. Only for the commit graph view. */
    repo?: string;
    /** The page in the view, for example one pull request in the Review view. Undefined is the entry page of the view. */
    page?: string;
    /** The selections in the page. */
    query?: NavQuery;
}

/** The selections in a page, as the query of a web address. An empty value is the same as no value. */
export type NavQuery = Readonly<Record<string, string | undefined>>;

/** The page and the query of one view. */
export interface ViewRoute {
    page?: string;
    query?: NavQuery;
}

export interface NavHistory {
    entries: NavLocation[];
    /** The index of the current entry. It is -1 when the history is empty. */
    index: number;
}

/** The maximum number of entries. The history removes the oldest entry when it has more. */
export const NAV_HISTORY_LIMIT = 100;

export const EMPTY_NAV_HISTORY: NavHistory = { entries: [], index: -1 };

/** True when the two locations are the same page. The query can be different. */
export function samePage(a: NavLocation | undefined, b: NavLocation | undefined): boolean {
    return !!a && !!b && a.view === b.view && a.worktree === b.worktree && a.tab === b.tab && a.repo === b.repo && a.page === b.page;
}

/** Returns the query without the empty values, so that two queries with the same values have the same key. */
function cleanQuery(query: NavQuery | undefined): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const key of Object.keys(query ?? {}).sort()) {
        const value = query?.[key];
        if (value) clean[key] = value;
    }
    return clean;
}

/** A text that is the same for two queries with the same values. */
export function queryKey(query: NavQuery | undefined): string {
    return JSON.stringify(cleanQuery(query));
}

export function sameLocation(a: NavLocation | undefined, b: NavLocation | undefined): boolean {
    return samePage(a, b) && queryKey(a?.query) === queryKey(b?.query);
}

/**
 * Adds a location after the current entry, as a new page in a web browser. The forward entries are removed.
 * When the location is the page of the current entry, the location replaces the current entry.
 */
export function recordLocation(history: NavHistory, location: NavLocation): NavHistory {
    const current = history.entries[history.index];
    if (sameLocation(current, location)) return history;
    if (samePage(current, location)) {
        const entries = [...history.entries];
        entries[history.index] = location;
        return { ...history, entries };
    }
    const entries = [...history.entries.slice(0, history.index + 1), location].slice(-NAV_HISTORY_LIMIT);
    return { entries, index: entries.length - 1 };
}

/**
 * Moves one step back (-1) or forward (1). The step skips each entry that `isValid` rejects, for example a closed tab,
 * and each entry that is the same page as the current location. Returns undefined when no valid entry is in that direction.
 */
export function stepHistory(
    history: NavHistory,
    step: 1 | -1,
    isValid: (location: NavLocation) => boolean
): { history: NavHistory; location: NavLocation } | undefined {
    const current = history.entries[history.index];
    for (let index = history.index + step; index >= 0 && index < history.entries.length; index += step) {
        const location = history.entries[index];
        if (isValid(location) && !samePage(location, current)) {
            return { history: { ...history, index }, location };
        }
    }
    return undefined;
}
