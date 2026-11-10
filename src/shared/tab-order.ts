/**
 * The order of the tabs in the tab strip of a worktree. The user can move a tab with ⌃⇧← and ⌃⇧→.
 * Without a saved order, the tabs show in the order that the app gives.
 */

/**
 * Returns the tab keys in the saved order. The keys that are not in the saved order come after the others,
 * in their given order. A new tab thus shows at the end.
 */
export function orderTabs(keys: readonly string[], order: readonly string[] | undefined): string[] {
    if (!order?.length) return [...keys];
    const rank = new Map(order.map((key, index) => [key, index]));
    const known = keys.filter(key => rank.has(key)).sort((a, b) => rank.get(a)! - rank.get(b)!);
    return [...known, ...keys.filter(key => !rank.has(key))];
}

/**
 * Moves one entry of the tab strip one step to the left (-1) or to the right (1). An entry is a tab, or a split tab
 * with the keys of all its panes. Returns the new order of all tab keys. Returns undefined when the entry is at the
 * end of the strip.
 */
export function moveStripEntry(entries: readonly (readonly string[])[], index: number, step: 1 | -1): string[] | undefined {
    const target = index + step;
    if (index < 0 || index >= entries.length || target < 0 || target >= entries.length) return undefined;
    const next = [...entries];
    [next[index], next[target]] = [next[target], next[index]];
    return next.flat();
}
