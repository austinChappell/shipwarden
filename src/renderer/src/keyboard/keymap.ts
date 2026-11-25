import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { keymapOf, type KeybindingChange, type KeybindingsState } from '@shared/keybindings';
import { DEFAULT_KEYMAP, keyLabel, remapKeyText, type KeyCommandId, type Keymap } from '@shared/shortcuts';
import { keyRoots, queryClient } from '../query-client';

/** The API of the main process. It is a function, so a test can import this module without the preload. */
const api = () => window.shipwarden.keybindings;

/** The query of the keybindings file. The data changes only when the file changes, and the main process tells the page. */
export const keybindingsQuery = {
    queryKey: keyRoots.keybindings,
    queryFn: () => api().get(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false as const
};

/**
 * Loads the keybindings one time and keeps the cache up to date. Call it one time at the start of the page. The main
 * process sends each new state, also after a change from a text editor.
 */
export function startKeybindings(): void {
    void queryClient.prefetchQuery(keybindingsQuery);
    api().onChanged(state => queryClient.setQueryData(keybindingsQuery.queryKey, state));
}

/** The keymap of the cache, for key handlers outside React. Before the first load, it has the default keys. */
export function currentKeymap(): Keymap {
    const state = queryClient.getQueryData<KeybindingsState>(keybindingsQuery.queryKey);
    return state ? keymapOf(state.overrides) : DEFAULT_KEYMAP;
}

/** The keybindings state and its keymap. The component renders again when the keys change. */
export function useKeybindings(): { state: KeybindingsState | undefined; keymap: Keymap } {
    const { data } = useQuery(keybindingsQuery);
    return { state: data, keymap: data ? keymapOf(data.overrides) : DEFAULT_KEYMAP };
}

/** The keymap of the user. The component renders again when the keys change. */
export function useKeymap(): Keymap {
    return useKeybindings().keymap;
}

/**
 * Returns a function that replaces the default keys in a help text with the keys of the user, for example in a tooltip
 * "Show the sidebar (⌘B)".
 */
export function useKeyText(): (text: string) => string {
    const keymap = useKeymap();
    return useCallback((text: string) => remapKeyText(text, keymap), [keymap]);
}

/** Returns the first key of a command in the form of the UI, or undefined for a command without a key. */
export function useKeyLabel(id: KeyCommandId): string | undefined {
    return keyLabel(useKeymap(), id);
}

let recording = false;

/**
 * Starts or stops the record mode of Settings › Keyboard. While a field records a key, the shortcuts of ShipWarden
 * do not run, so the field gets each key. ⌘Q and ⌘H still work.
 */
export function setRecordingKeys(on: boolean): void {
    recording = on;
    api().record(on);
}

/** Returns true while a field of Settings › Keyboard records a key. */
export function recordingKeys(): boolean {
    return recording;
}

/** Writes changes to the keybindings file and puts the new state in the cache. */
export async function updateKeybindings(changes: KeybindingChange[]): Promise<void> {
    queryClient.setQueryData(keybindingsQuery.queryKey, await api().update(changes));
}

/** Gives all commands their default keys and puts the new state in the cache. */
export async function resetAllKeybindings(): Promise<void> {
    queryClient.setQueryData(keybindingsQuery.queryKey, await api().resetAll());
}

/** Calls `listener` after each change of the keymap in the cache. Returns a function that stops the calls. */
export function onKeymapChange(listener: (keymap: Keymap) => void): () => void {
    let last = currentKeymap();
    return queryClient.getQueryCache().subscribe(event => {
        if (event.query.queryKey[0] !== keyRoots.keybindings[0]) return;
        const next = currentKeymap();
        if (next === last) return;
        last = next;
        listener(next);
    });
}
