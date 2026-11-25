import { useCallback, useSyncExternalStore } from 'react';

/**
 * The text of prompt boxes that the user did not send yet, by key. The text stays when the box closes, for example
 * when the user opens another page or another project. The text does not go to disk.
 */
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Returns the draft of a key and a setter. An empty text removes the draft. */
export function useTextDraft(key: string): [string, (text: string) => void] {
    const text = useSyncExternalStore(
        subscribe,
        useCallback(() => drafts.get(key) ?? '', [key])
    );
    const setText = useCallback(
        (next: string) => {
            if (next) drafts.set(key, next);
            else drafts.delete(key);
            for (const listener of listeners) listener();
        },
        [key]
    );
    return [text, setText];
}
