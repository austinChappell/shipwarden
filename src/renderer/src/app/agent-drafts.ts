import { useCallback, useSyncExternalStore } from 'react';
import type { DraftRequest } from '@shared/drafts';
import { errorText } from '../util';
import { setTextDraft } from './text-drafts';

/**
 * The ✨ drafts that the agent writes now, by the key of their text box in `text-drafts`. A draft continues when its
 * box closes, for example when the user opens another page. At the end, the draft goes into the text draft of the key.
 * The box then shows the draft when it opens again.
 */
interface DraftRun {
    /** The ID of the run. `ask.cancel` uses it. Undefined when the run is not active. */
    id?: string;
    /** The error of the last run. The box shows it one time. */
    error?: string;
}

const api = window.shipwarden.ask;
const runs = new Map<string, DraftRun>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function update(key: string, run: DraftRun | undefined): void {
    if (run?.id || run?.error) runs.set(key, run);
    else runs.delete(key);
    for (const listener of listeners) listener();
}

/** True while the agent writes a draft for the key. */
export function isDraftRunning(key: string): boolean {
    return !!runs.get(key)?.id;
}

/**
 * Asks the agent for a draft of the box with the key. The draft goes into the text draft of the key. `fallback` is the
 * fallback text of the box (see `setTextDraft`).
 */
export async function startDraft(key: string, request: Omit<DraftRequest, 'id'>, fallback = ''): Promise<void> {
    stopDraft(key);
    const id = `draft-${crypto.randomUUID()}`;
    update(key, { id });
    try {
        const result = await api.draft({ id, ...request });
        if (runs.get(key)?.id !== id) return;
        setTextDraft(key, result.text, fallback);
        update(key, undefined);
    } catch (err) {
        // A stop by the user is not an error. A stopped run is not the current run of the key.
        if (runs.get(key)?.id === id) update(key, { error: errorText(err) });
    }
}

/** Stops the draft of the key. */
export function stopDraft(key: string): void {
    const id = runs.get(key)?.id;
    if (id) void api.cancel(id);
    update(key, undefined);
}

/** Removes the error of the key, after the box shows it. */
export function clearDraftError(key: string): void {
    const run = runs.get(key);
    if (run?.error) update(key, { ...run, error: undefined });
}

/** Returns the state of the draft of the key: true while it runs, and the error of the last run. */
export function useDraftRun(key: string): { running: boolean; error?: string } {
    const running = useSyncExternalStore(
        subscribe,
        useCallback(() => !!runs.get(key)?.id, [key])
    );
    const error = useSyncExternalStore(
        subscribe,
        useCallback(() => runs.get(key)?.error, [key])
    );
    return { running, error };
}
