/**
 * Keeps the last loaded data of the views in memory for the session.
 * When a view opens again, it shows this data immediately. Then it loads new data in the background.
 */

/** The maximum number of entries. When the cache is full, the oldest entry goes out. */
const MAX_ENTRIES = 500;

const entries = new Map<string, unknown>();

/** Returns the cached value for the key, or undefined. */
export function cached<T>(key: string): T | undefined {
    return entries.get(key) as T | undefined;
}

/** Keeps the value for the key and returns the value. */
export function remember<T>(key: string, value: T): T {
    // A new insertion moves the key to the end, so the first key is always the oldest.
    entries.delete(key);
    entries.set(key, value);
    if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
    }
    return value;
}

/** Makes a cache key from its parts. */
export function cacheKey(...parts: Array<string | number | undefined | null>): string {
    return parts.map(part => part ?? '').join('\0');
}
