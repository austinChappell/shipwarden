import { useSyncExternalStore } from 'react';

/** The key of the "show blame" choice in the local storage. */
const KEY = 'shipwarden.blame.visible';

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): boolean {
    try {
        return localStorage.getItem(KEY) === '1';
    } catch {
        return false;
    }
}

let visible = read();

/** Shows or hides the blame column in all editors. The choice stays after a restart. */
export function setBlameVisible(value: boolean): void {
    if (value === visible) return;
    visible = value;
    try {
        localStorage.setItem(KEY, value ? '1' : '0');
    } catch {
        // The choice stays for this session only.
    }
    listeners.forEach(listener => listener());
}

export function toggleBlame(): void {
    setBlameVisible(!visible);
}

function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Returns true when the editors show the blame column. */
export function useBlameVisible(): boolean {
    return useSyncExternalStore(subscribe, () => visible);
}
