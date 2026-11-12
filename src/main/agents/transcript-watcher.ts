import { existsSync, watch, type FSWatcher } from 'fs';
import * as path from 'path';
import { claudeDataRoots } from '../automations/token-counter';
import { transcriptPath } from './transcript-reader';

/** The time to collect the change events of one write. Claude Code writes several lines at a time. */
const DEBOUNCE_MS = 50;

interface Watch {
    watcher?: FSWatcher;
    /** The number of chats that use this watch. */
    users: number;
    timer?: NodeJS.Timeout;
}

/** Returns true when the error tells that the path does not exist. */
function isMissing(err: unknown): boolean {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Watches Claude Code transcripts, so that the chat of an agent tab shows a new message at once.
 * The watch is on the folder of the file, because Claude Code makes the file only at the first prompt.
 * Claude Code also makes the folder of a new project only at the first prompt. Until then, the watch is on the parent
 * folder. When the folder of the file comes, the watch moves to it.
 */
export class TranscriptWatcher {
    private readonly watches = new Map<string, Watch>();

    constructor(
        private readonly onChange: (file: string) => void,
        private readonly roots: readonly string[] = claudeDataRoots()
    ) {}

    /**
     * Starts to watch a transcript. Each call needs one call of `stop`. `file` is the path that the chat uses, and the
     * change events give the same path. Throws an error when the folder and its parent folder cannot be watched.
     */
    start(file: string): void {
        const existing = this.watches.get(file);
        if (existing) {
            existing.users++;
            return;
        }
        const resolved = transcriptPath(file, this.roots);
        const entry: Watch = { users: 1 };
        this.watches.set(file, entry);
        try {
            try {
                this.watchFolder(file, entry, resolved);
            } catch (err) {
                if (!isMissing(err)) throw err;
                this.watchParent(file, entry, resolved);
            }
        } catch (err) {
            this.close(file);
            throw err;
        }
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

    /** Watches the folder of the transcript. Throws an error when the folder cannot be watched. */
    private watchFolder(file: string, entry: Watch, resolved: string): void {
        const name = path.basename(resolved);
        const watcher = watch(path.dirname(resolved), (_event, changed) => {
            // Without a file name, the change can be in this file.
            if (changed && changed.toString() !== name) return;
            this.report(file, entry);
        });
        // An error (for example a removed folder) ends the watch. The chat still reads the file at each state change.
        watcher.on('error', () => this.close(file));
        entry.watcher = watcher;
    }

    /**
     * Watches the parent folder until the folder of the transcript comes. Then watches the folder of the transcript.
     * Throws an error when the parent folder cannot be watched.
     */
    private watchParent(file: string, entry: Watch, resolved: string): void {
        const folder = path.dirname(resolved);
        const folderName = path.basename(folder);
        const moveWatch = () => {
            if (entry.watcher !== watcher || !existsSync(folder)) return;
            watcher.close();
            try {
                this.watchFolder(file, entry, resolved);
            } catch {
                this.close(file);
                return;
            }
            // Claude Code can write the file before the new watch starts.
            this.report(file, entry);
        };
        const watcher = watch(path.dirname(folder), (_event, changed) => {
            if (changed && changed.toString() !== folderName) return;
            moveWatch();
        });
        watcher.on('error', () => this.close(file));
        entry.watcher = watcher;
        // The folder can come after the first watch failed and before this watch started.
        moveWatch();
    }

    /** Reports a change after the debounce time. */
    private report(file: string, entry: Watch): void {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.onChange(file), DEBOUNCE_MS);
    }

    private close(file: string): void {
        const entry = this.watches.get(file);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.watcher?.close();
        this.watches.delete(file);
    }
}
