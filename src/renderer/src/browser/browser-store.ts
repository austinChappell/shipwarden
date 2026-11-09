import { useSyncExternalStore } from 'react';
import type { BrowserState } from '@shared/browser';

/** The last state of each browser view, by view ID. The main process sends a new state after each change. */
class BrowserStore {
    private states = new Map<string, BrowserState>();
    private readonly listeners = new Set<() => void>();
    private started = false;

    private start(): void {
        if (this.started) return;
        this.started = true;
        window.shipwarden.browser.onState(state => this.set(state));
    }

    /** Sets the state of a view, for example the address of a new tab before the main process sends its first state. */
    set(state: BrowserState): void {
        this.states = new Map(this.states).set(state.id, state);
        this.listeners.forEach(listener => listener());
    }

    remove(id: string): void {
        if (!this.states.has(id)) return;
        const next = new Map(this.states);
        next.delete(id);
        this.states = next;
        this.listeners.forEach(listener => listener());
    }

    get(id: string): BrowserState | undefined {
        return this.states.get(id);
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.start();
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    readonly snapshot = (): ReadonlyMap<string, BrowserState> => this.states;
}

export const browserStore = new BrowserStore();

/** The states of all browser views. The component renders again after each change. */
export function useBrowserStates(): ReadonlyMap<string, BrowserState> {
    return useSyncExternalStore(browserStore.subscribe, browserStore.snapshot);
}
