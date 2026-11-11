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
export function isFindShortcut(event: KeyboardEvent): boolean {
    return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
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
