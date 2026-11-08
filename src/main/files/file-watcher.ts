import { watch, type FSWatcher } from 'fs';
import type { FilesChangedEvent } from '@shared/files';
import { parentPath } from '@shared/files';

const DEBOUNCE_MS = 150;

interface Watch {
    watcher: FSWatcher;
    /** The number of views that use this watch. */
    users: number;
    pending: Set<string>;
    timer?: NodeJS.Timeout;
}

/**
 * Watches worktree folders for changes. Agents change files all the time, so the explorer must update itself.
 * On macOS, a recursive fs.watch uses FSEvents. One watch covers the full tree.
 */
export class FileWatcher {
    private readonly watches = new Map<string, Watch>();

    constructor(private readonly onChange: (event: FilesChangedEvent) => void) {}

    start(root: string): void {
        const existing = this.watches.get(root);
        if (existing) {
            existing.users++;
            return;
        }
        const entry: Watch = { watcher: undefined as unknown as FSWatcher, users: 1, pending: new Set() };
        entry.watcher = watch(root, { recursive: true }, (_event, filename) => {
            if (!filename) {
                entry.pending.add('');
            } else {
                const file = filename.toString().split('\\').join('/');
                // Changes in the .git folder do not change the file tree.
                if (file === '.git' || file.startsWith('.git/')) {
                    return;
                }
                entry.pending.add(parentPath(file));
            }
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
                const directories = [...entry.pending];
                entry.pending.clear();
                this.onChange({ root, directories });
            }, DEBOUNCE_MS);
        });
        entry.watcher.on('error', () => this.stopAll(root));
        this.watches.set(root, entry);
    }

    stop(root: string): void {
        const entry = this.watches.get(root);
        if (entry && --entry.users <= 0) {
            this.stopAll(root);
        }
    }

    dispose(): void {
        for (const root of [...this.watches.keys()]) {
            this.stopAll(root);
        }
    }

    private stopAll(root: string): void {
        const entry = this.watches.get(root);
        if (entry) {
            clearTimeout(entry.timer);
            entry.watcher.close();
            this.watches.delete(root);
        }
    }
}
