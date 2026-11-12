/**
 * The formats of ages, times, and counts in the UI. The rules come from docs/design (board 4, "Ages and times").
 * Use these helpers on every page, so that each page shows the same format and the same colors.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** An age under this number of days shows in the muted color. */
export const AGE_WARNING_DAYS = 7;
/** An age of this number of days or more shows in the danger color. It is the same limit as the "Stale 30d+" tile. */
export const AGE_DANGER_DAYS = 30;

/**
 * Returns a short age for a column: "now", "12m", "7h", "2d", "12d", or "4w". There is no space between the number and
 * the unit. Days show until 13 days. Weeks show from 14 days.
 */
export function formatAge(iso: string, now = Date.now()): string {
    const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / MINUTE_MS));
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d`;
    return `${Math.floor(days / 7)}w`;
}

/** Returns an age for a sentence or a meta line: "just now", "12m ago", "7h ago", or "4w ago". */
export function formatAgo(iso: string, now = Date.now()): string {
    const age = formatAge(iso, now);
    return age === 'now' ? 'just now' : `${age} ago`;
}

/** The color of an age. */
export type AgeTone = 'muted' | 'warning' | 'danger';

/** Returns the color of an age: muted under 7 days, warning from 7 to 29 days, and danger from 30 days. */
export function ageTone(iso: string, now = Date.now()): AgeTone {
    const days = (now - Date.parse(iso)) / DAY_MS;
    if (days >= AGE_DANGER_DAYS) return 'danger';
    if (days >= AGE_WARNING_DAYS) return 'warning';
    return 'muted';
}

/**
 * Returns a count and a noun with the correct number, for example "1 pull request" or "2 pull requests".
 * The plural is the noun with "s" when `many` is not given.
 */
export function pluralize(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}
