import { watch, type FSWatcher } from 'fs';
import * as path from 'path';
import { claudeDataRoots } from '../automations/token-counter';
import { transcriptPath } from './transcript-reader';

/** The time to collect the change events of one write. Claude Code writes several lines at a time. */
const DEBOUNCE_MS = 50;

interface Watch {
    watcher: FSWatcher;
    /** The number of chats that use this watch. */
    users: number;
    timer?: NodeJS.Timeout;
}

/**
 * Watches Claude Code transcripts, so that the chat of an agent tab shows a new message at once.
 * The watch is on the folder of the file, because Claude Code makes the file only at the first prompt.
 */
export class TranscriptWatcher {
    private readonly watches = new Map<string, Watch>();

    constructor(
        private readonly onChange: (file: string) => void,
        private readonly roots: readonly string[] = claudeDataRoots()
    ) {}

    /**
     * Starts to watch a transcript. Each call needs one call of `stop`. `file` is the path that the chat uses, and the
     * change events give the same path. Throws an error when the folder cannot be watched.
     */
    start(file: string): void {
        const existing = this.watches.get(file);
        if (existing) {
            existing.users++;
            return;
        }
        const resolved = transcriptPath(file, this.roots);
        const name = path.basename(resolved);
        const entry: Watch = { watcher: undefined as unknown as FSWatcher, users: 1 };
        entry.watcher = watch(path.dirname(resolved), (_event, changed) => {
            // Without a file name, the change can be in this file.
            if (changed && changed.toString() !== name) return;
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => this.onChange(file), DEBOUNCE_MS);
        });
        // An error (for example a removed folder) ends the watch. The chat still reads the file at each state change.
        entry.watcher.on('error', () => this.close(file));
        this.watches.set(file, entry);
    }

    /** Stops one use of the watch of a transcript. The watch closes after the last use. */
    stop(file: string): void {
        const entry = this.watches.get(file);
        if (!entry) return;
        entry.users--;
        if (entry.users <= 0) this.close(file);
    }

    /** Closes all watches. */
    dispose(): void {
        for (const file of [...this.watches.keys()]) this.close(file);
    }

    private close(file: string): void {
        const entry = this.watches.get(file);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.watcher.close();
        this.watches.delete(file);
    }
}
