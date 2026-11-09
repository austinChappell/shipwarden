/**
 * A request to move the keyboard focus to the file explorer (⇧⌘E).
 * The explorer can be hidden when the request comes. The right panel then shows the Files tab, and the explorer
 * takes the request when it mounts. One request moves the focus one time only.
 */

let pending = false;
const listeners = new Set<() => void>();

/** Asks for the focus in the file explorer. */
export function requestExplorerFocus(): void {
    pending = true;
    for (const listener of listeners) {
        listener();
    }
}

/** Calls the listener for each request. Returns the function that removes the listener. */
export function onExplorerFocusRequest(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Returns true when a request waits. The request stays. */
export function hasExplorerFocusRequest(): boolean {
    return pending;
}

/** Returns true when a request waits, and removes the request. */
export function takeExplorerFocusRequest(): boolean {
    const was = pending;
    pending = false;
    return was;
}
