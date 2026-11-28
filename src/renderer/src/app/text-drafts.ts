import { useCallback, useSyncExternalStore } from 'react';

/**
 * The text of boxes that the user did not send yet, by key. The text stays when the box closes, for example when the
 * user opens another page or another project. The text does not go to disk.
 */
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** True when the key has a draft. */
export function hasTextDraft(key: string): boolean {
    return drafts.has(key);
}

/** Sets the draft of a key. A text that is the same as the fallback removes the draft. */
export function setTextDraft(key: string, text: string, fallback = ''): void {
    if (text === fallback) drafts.delete(key);
    else drafts.set(key, text);
    for (const listener of listeners) listener();
}

/**
 * Returns the draft of a key and a setter. Without a draft, the text is the fallback. A text that is the same as the
 * fallback removes the draft.
 */
export function useTextDraft(key: string, fallback = ''): [string, (text: string) => void] {
    const text = useSyncExternalStore(
        subscribe,
        useCallback(() => drafts.get(key) ?? fallback, [key, fallback])
    );
    const setText = useCallback((next: string) => setTextDraft(key, next, fallback), [key, fallback]);
    return [text, setText];
}
