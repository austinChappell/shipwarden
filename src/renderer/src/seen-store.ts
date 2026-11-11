import { useEffect, useMemo, useSyncExternalStore } from 'react';

/**
 * The comments that the user saw in ShipWarden, by key (see `gitHubSeenKey` and `taskSeenKey`).
 * The main process keeps the record in a file. This store keeps a copy, so that the views can update at once.
 */
class SeenStore {
    private keys = new Set<string>();
    private version = 0;
    private loaded: Promise<void> | undefined;
    private readonly listeners = new Set<() => void>();

    load(): Promise<void> {
        this.loaded ??= window.shipwarden.seen.keys().then(
            keys => {
                keys.forEach(key => this.keys.add(key));
                this.changed();
            },
            () => {
                // Without the record, all comments show as new. The next mark adds them.
            }
        );
        return this.loaded;
    }

    has(key: string): boolean {
        return this.keys.has(key);
    }

    /** Records that the user saw the items. Keys that the store has already are ignored. */
    mark(keys: string[]): void {
        const fresh = keys.filter(key => !this.keys.has(key));
        if (fresh.length === 0) {
            return;
        }
        fresh.forEach(key => this.keys.add(key));
        this.changed();
        window.shipwarden.seen.mark(fresh).catch(() => {
            // The record stays in memory for this session.
        });
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    private changed(): void {
        this.version += 1;
        this.listeners.forEach(listener => listener());
    }
}

export const seenStore = new SeenStore();

/** Renders again when the record of seen items changes. Returns a number that changes with the record. */
export function useSeenVersion(): number {
    return useSyncExternalStore(seenStore.subscribe, seenStore.getVersion);
}

const isSeen = (key: string): boolean => seenStore.has(key);

/**
 * Returns a function that tells if the user saw an item. The function changes when the record changes, so that memos
 * that use it update. The hook loads the record when it is not loaded.
 */
export function useIsSeen(): (key: string) => boolean {
    const version = useSeenVersion();
    useEffect(() => {
        void seenStore.load();
    }, []);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The version changes when the record changes. A new function then makes the memos update.
    return useMemo(() => (key: string) => isSeen(key), [version]);
}
