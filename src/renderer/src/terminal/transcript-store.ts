import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { addTranscriptLines, type ChatItem } from '@shared/agent-chat';

/** The chat of one transcript file. */
export interface TranscriptState {
    items: readonly ChatItem[];
    /** True when the chat does not show the start of a long transcript. */
    truncated: boolean;
    /** True until the first read is done. */
    loading: boolean;
    error?: string;
}

interface Entry {
    state: TranscriptState;
    /** The byte offset of the next read. -1 before the first read. */
    offset: number;
    /** The read in progress. A new read waits for it, so two reads never parse the same lines. */
    reading?: Promise<void>;
    /** True when a refresh came during a read. One more read then follows. */
    again: boolean;
}

const EMPTY: TranscriptState = { items: [], truncated: false, loading: true };
const NO_FILE: TranscriptState = { items: [], truncated: false, loading: false };

/**
 * The chat items of the Claude Code transcripts. The store keeps the items of each file and reads only the new end
 * of a file at the next refresh. A tab that opens again thus shows its chat at once.
 */
class TranscriptStore {
    private readonly entries = new Map<string, Entry>();
    private readonly listeners = new Set<() => void>();

    get(file: string): TranscriptState {
        return this.entries.get(file)?.state ?? EMPTY;
    }

    /** Reads the new lines of the file. */
    refresh(file: string): Promise<void> {
        let entry = this.entries.get(file);
        if (!entry) {
            entry = { state: EMPTY, offset: -1, again: false };
            this.entries.set(file, entry);
        }
        if (entry.reading) {
            entry.again = true;
            return entry.reading;
        }
        const current = entry;
        current.reading = (async () => {
            do {
                current.again = false;
                try {
                    const chunk = await window.shipwarden.terminals.readTranscript(file, current.offset);
                    const first = current.offset < 0;
                    current.offset = chunk.offset;
                    if (chunk.lines.length > 0 || current.state.loading || current.state.error) {
                        current.state = {
                            items: chunk.lines.length > 0 ? addTranscriptLines(current.state.items, chunk.lines) : current.state.items,
                            truncated: first ? chunk.truncated : current.state.truncated,
                            loading: false
                        };
                        this.emit();
                    }
                } catch (err) {
                    current.state = { ...current.state, loading: false, error: err instanceof Error ? err.message : String(err) };
                    this.emit();
                    return;
                }
            } while (current.again);
        })().finally(() => {
            current.reading = undefined;
        });
        return current.reading;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    private emit(): void {
        this.listeners.forEach(listener => listener());
    }
}

export const transcriptStore = new TranscriptStore();

/** How often the chat reads the transcript when the main process cannot watch the file. */
const FALLBACK_POLL_MS = 1000;

/** The transcript files that a chat shows. The store reads such a file again at each change event of the main process. */
const watched = new Map<string, number>();
window.shipwarden.terminals.onTranscriptChanged(file => {
    if (watched.has(file)) void transcriptStore.refresh(file);
});

/**
 * Returns the chat of a transcript file. The main process watches the file, and the hook reads the new lines at each
 * change. The hook also reads the file when `version` changes (for example at each state change of the agent).
 * When the watch fails, the hook reads the file each second while `live` is true.
 */
export function useTranscript(file: string, live: boolean, version: unknown): TranscriptState {
    const getSnapshot = useCallback(() => transcriptStore.get(file), [file]);
    const state = useSyncExternalStore(transcriptStore.subscribe, getSnapshot);
    const [watchFailed, setWatchFailed] = useState(false);

    // biome-ignore lint/correctness/useExhaustiveDependencies: A new version is the signal to read the file again.
    useEffect(() => {
        if (!file) return;
        void transcriptStore.refresh(file);
    }, [file, version]);

    useEffect(() => {
        if (!file) return;
        let current = true;
        setWatchFailed(false);
        watched.set(file, (watched.get(file) ?? 0) + 1);
        const started = window.shipwarden.terminals.watchTranscript(file).then(
            () => true,
            () => {
                if (current) setWatchFailed(true);
                return false;
            }
        );
        return () => {
            current = false;
            const users = (watched.get(file) ?? 1) - 1;
            if (users > 0) watched.set(file, users);
            else watched.delete(file);
            void started.then(ok => ok && window.shipwarden.terminals.unwatchTranscript(file));
        };
    }, [file]);

    useEffect(() => {
        if (!file || !watchFailed || !live) return;
        const timer = setInterval(() => void transcriptStore.refresh(file), FALLBACK_POLL_MS);
        return () => clearInterval(timer);
    }, [file, live, watchFailed]);

    // Before the agent reports its transcript, there is nothing to read.
    return file ? state : NO_FILE;
}
