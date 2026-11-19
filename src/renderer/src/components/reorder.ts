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

/**
 * Returns a copy of `list` with the item that has `key` at index `to`. Only the items with a key in `among` move: they
 * change places with each other, and all other items stay at their index. Without `among`, all items can move.
 * Returns the same list when the key is not in the list, or when the item is at `to` already.
 */
export function moveKeyTo<T>(list: readonly T[], keyOf: (item: T) => string, key: string, to: number, among?: readonly string[]): readonly T[] {
    const keys = among ?? list.map(keyOf);
    const from = keys.indexOf(key);
    if (from === -1 || to < 0 || to >= keys.length || to === from) return list;
    const order = [...keys];
    order.splice(from, 1);
    order.splice(to, 0, key);
    const byKey = new Map(list.map(item => [keyOf(item), item]));
    const moving = new Set(keys);
    let next = 0;
    return list.map(item => (moving.has(keyOf(item)) ? (byKey.get(order[next++]) ?? item) : item));
}
