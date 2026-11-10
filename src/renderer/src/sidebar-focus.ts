/**
 * A request to move the keyboard focus to the sidebar (⇧⌘B).
 * The sidebar can be hidden when the request comes. The sidebar then shows, and takes the request when it mounts.
 * One request moves the focus one time only.
 */

let pending = false;
const listeners = new Set<() => void>();

/** Asks for the focus in the sidebar. */
export function requestSidebarFocus(): void {
    pending = true;
    for (const listener of listeners) {
        listener();
    }
}

/** Calls the listener for each request. Returns the function that removes the listener. */
export function onSidebarFocusRequest(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Returns true when a request waits, and removes the request. */
export function takeSidebarFocusRequest(): boolean {
    const was = pending;
    pending = false;
    return was;
}
