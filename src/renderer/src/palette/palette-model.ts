import type { LucideIcon } from 'lucide-react';

/** The groups of the command palette, in the order of the list. */
export const PALETTE_GROUPS = ['Worktrees', 'Review', 'Tasks', 'Plans', 'Notes', 'Automations', 'Views', 'Settings', 'Help'] as const;

export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** One row of the command palette. */
export interface PaletteItem {
    /** A unique ID in its page. */
    id: string;
    label: string;
    group: PaletteGroup;
    /** The text at the right of the label, for example the repository of a worktree. */
    detail?: string;
    /** More words that find the item. The palette does not show them. */
    keywords?: readonly string[];
    icon?: LucideIcon;
    /** The key combination of the same action, for example "⌘N". */
    keys?: string;
    /** True for an item that removes or deletes something. The label shows in the danger color. */
    danger?: boolean;
    /** True for an item that marks the current value, for example the current theme. */
    current?: boolean;
    /**
     * True for an item that shows only when the user types a search text. The rows of worktrees, notes and plans use
     * it, so the first list shows only the commands.
     */
    searchOnly?: boolean;
    /** The action. The palette closes before the action starts. */
    run?(): void | Promise<void>;
    /** A page of more items, for example the worktrees to remove. The palette shows the page in place of the list. */
    page?(): PalettePage;
}

/** A page of the command palette after the user selects an item with `page`. */
export interface PalettePage {
    id: string;
    /** The name of the page, at the left of the search field. */
    title: string;
    placeholder: string;
    /** The items. A promise shows a loading row until it resolves. */
    items: PaletteItem[] | Promise<PaletteItem[]>;
    /** The text when the page has no items. */
    empty: string;
}

/** Returns the start index of each word in a text. A word starts after a space or a punctuation mark. */
function wordStarts(text: string): Set<number> {
    const starts = new Set<number>();
    for (let index = 0; index < text.length; index++) {
        if (index === 0 || /[\s/\-_.:#(]/.test(text[index - 1])) starts.add(index);
    }
    return starts;
}

/**
 * Scores one search word against a text in lower case. Returns undefined when the word does not match.
 * A match at the start of a word is best. A match in a word is second. The characters in order, with gaps, is last.
 * The last kind of match applies only when `fuzzy` is true.
 */
function scoreWord(text: string, starts: Set<number>, word: string, fuzzy: boolean): number | undefined {
    let best: number | undefined;
    for (let found = text.indexOf(word); found !== -1; found = text.indexOf(word, found + 1)) {
        const score = starts.has(found) ? 30 + (found === 0 ? 10 : 0) : 15;
        if (best === undefined || score > best) best = score;
    }
    if (best !== undefined) return best + word.length;
    if (!fuzzy) return undefined;
    // The characters of the word in order, for example "nwt" in "new worktree".
    let score = 0;
    let position = -1;
    for (const char of word) {
        const found = text.indexOf(char, position + 1);
        if (found === -1) return undefined;
        score += starts.has(found) ? 3 : found === position + 1 ? 2 : 0;
        position = found;
    }
    return score;
}

/** The text that the search reads for an item: the label, the detail, the group and the keywords. */
function searchText(item: PaletteItem): string {
    return [item.label, item.detail, item.group, ...(item.keywords ?? [])].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Scores an item against a search text. Each word of the search must match. Returns undefined when the item does not
 * match. A higher score is a better match. An empty search gives 0.
 */
export function scoreItem(item: PaletteItem, query: string): number | undefined {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return 0;
    const label = item.label.toLowerCase();
    const labelStarts = wordStarts(label);
    const all = searchText(item);
    const allStarts = wordStarts(all);
    let total = 0;
    for (const word of words) {
        // A match in the label counts more than a match in the other text. The other text must contain the word, so a
        // match with gaps cannot join parts of different words.
        const inLabel = scoreWord(label, labelStarts, word, true);
        const score = inLabel !== undefined ? inLabel * 2 : scoreWord(all, allStarts, word, false);
        if (score === undefined) return undefined;
        total += score;
    }
    if (label.startsWith(query.trim().toLowerCase())) total += 25;
    return total;
}

/** A section of the list: a group with its items. */
export interface PaletteSection {
    /** The group name. A list of search results has one section without a name. */
    group?: PaletteGroup;
    items: PaletteItem[];
}

/**
 * Returns the sections that the palette shows for a search text.
 * - An empty search shows the items without `searchOnly`, in their groups, in the order of PALETTE_GROUPS.
 * - A search shows all items that match, best match first, in one section. Equal scores keep the order of the input.
 */
export function paletteSections(items: readonly PaletteItem[], query: string, grouped = true): PaletteSection[] {
    if (!query.trim()) {
        const shown = items.filter(item => !item.searchOnly);
        if (!grouped) return shown.length ? [{ items: shown }] : [];
        return PALETTE_GROUPS.map(group => ({ group, items: shown.filter(item => item.group === group) })).filter(section => section.items.length > 0);
    }
    const scored: { item: PaletteItem; score: number; index: number }[] = [];
    items.forEach((item, index) => {
        const score = scoreItem(item, query);
        if (score !== undefined) scored.push({ item, score, index });
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.length ? [{ items: scored.map(entry => entry.item) }] : [];
}

/**
 * Returns the index of the next selected row after a key, or undefined for other keys. Up and Down wrap at the ends of
 * the list. Home and End stay with the search field, so they move the text cursor.
 */
export function nextIndex(key: string, index: number, count: number): number | undefined {
    if (count === 0) return undefined;
    if (key === 'ArrowDown') return (index + 1) % count;
    if (key === 'ArrowUp') return (index - 1 + count) % count;
    if (key === 'PageDown') return Math.min(index + 8, count - 1);
    if (key === 'PageUp') return Math.max(index - 8, 0);
    return undefined;
}
