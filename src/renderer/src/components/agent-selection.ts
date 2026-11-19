/**
 * Gives the selection after a click on the checkbox of an item.
 *
 * - A click without Shift toggles the item.
 * - A click with Shift sets all items from the anchor to the item, as in a mail app. The items get the new state of
 *   the clicked item. Without an anchor in `order`, the click toggles the item only.
 *
 * `order` is the order of the items on the screen.
 */
export function clickSelection(selected: ReadonlySet<string>, order: readonly string[], id: string, anchor: string | undefined, shift: boolean): Set<string> {
    const next = new Set(selected);
    const on = !selected.has(id);
    const from = anchor === undefined ? -1 : order.indexOf(anchor);
    const to = order.indexOf(id);
    const range = shift && from >= 0 && to >= 0 ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
    for (const item of range) {
        if (on) next.add(item);
        else next.delete(item);
    }
    return next;
}

/** Selects all `ids` when one or more of them are not selected. Else clears all `ids`. */
export function toggleAll(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
    const next = new Set(selected);
    const all = ids.every(id => selected.has(id));
    for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
    }
    return next;
}
