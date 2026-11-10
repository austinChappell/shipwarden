/**
 * Returns the new index of `key` after a move of `delta` places in `keys`.
 * Returns undefined when the list does not have the key, or when the move goes past an end.
 */
export function moveIndex(keys: readonly string[], key: string, delta: number): number | undefined {
    const from = keys.indexOf(key);
    if (from === -1) return undefined;
    const to = from + delta;
    return to >= 0 && to < keys.length && to !== from ? to : undefined;
}

/** Returns -1 for Alt+Up and 1 for Alt+Down. Returns undefined for all other keys. */
export function reorderKeyDelta(event: { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): number | undefined {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return undefined;
    return event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : undefined;
}
