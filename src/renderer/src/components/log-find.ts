/**
 * ⌘F in a CI log. The log that the user opened or clicked last owns ⌘F. Other ⌘F handlers (the search of the changes
 * and the search of a pull request) call openLogFind first. When it returns true, they do nothing.
 */

/** A log that can own ⌘F. open returns false when the log cannot show its search bar now. */
export interface LogFindOwner {
    open(): boolean;
}

let owner: LogFindOwner | undefined;

/** Makes the log the owner of ⌘F. */
export function claimLogFind(log: LogFindOwner): void {
    owner = log;
}

/** Removes the log as the owner of ⌘F. A different owner stays. */
export function releaseLogFind(log: LogFindOwner): void {
    if (owner === log) owner = undefined;
}

/** True for ⌘F with no other modifier key. */
export function isFindKey(event: KeyboardEvent): boolean {
    return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
}

/** True when the key comes from an element in a view that has its own ⌘F. Such a view has the attribute `data-own-find`. */
function inOwnFind(event: KeyboardEvent): boolean {
    const target = event.target as { closest?(selector: string): unknown } | null;
    return typeof target?.closest === 'function' && !!target.closest('[data-own-find]');
}

/**
 * True for ⌘F that a page-level handler can use. False for a key from a view that has its own ⌘F.
 * That view uses isFindKey.
 */
export function isFindShortcut(event: KeyboardEvent): boolean {
    return isFindKey(event) && !inOwnFind(event);
}

/**
 * Opens the search bar of the log that owns ⌘F. Returns true when a search bar opens. Then the caller must stop the key.
 * A key that a different handler stopped first returns true too, so that one key opens one search bar only.
 */
export function openLogFind(event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return true;
    if (!owner?.open()) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
}
