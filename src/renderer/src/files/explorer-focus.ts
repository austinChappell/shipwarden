/**
 * A request to move the keyboard focus to the file explorer (⇧⌘E), or to search the file contents (⇧⌘F).
 * The explorer can be hidden when the request comes. The right panel then shows the Files tab, and the explorer
 * takes the request when it mounts. One request moves the focus one time only.
 */

/** A request for the explorer. `search` selects the content search. `text` replaces the query when it is set. */
export interface ExplorerRequest {
    search?: boolean;
    text?: string;
}

let pending: ExplorerRequest | undefined;
const listeners = new Set<() => void>();

/** Asks for the focus in the file explorer. */
export function requestExplorerFocus(request: ExplorerRequest = {}): void {
    pending = request;
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
    return pending !== undefined;
}

/** Returns the request that waits, and removes it. Returns undefined when no request waits. */
export function takeExplorerFocusRequest(): ExplorerRequest | undefined {
    const was = pending;
    pending = undefined;
    return was;
}
