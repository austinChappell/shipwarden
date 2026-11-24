import { randomBytes } from 'crypto';
import { promises as fs, watch, type FSWatcher } from 'fs';
import * as path from 'path';
import {
    applyKeybindingChanges,
    keymapOf,
    parseKeybindingsFile,
    type KeybindingChange,
    type KeybindingOverrides,
    type KeybindingsState
} from '@shared/keybindings';
import type { Keymap } from '@shared/shortcuts';

/** The file is not valid JSON, so a change from the app would remove the text of the user. */
export class KeybindingsFileError extends Error {}

/**
 * Keeps the keybindings of the user in ~/.shipwarden/keybindings.json. The store reads the file at the start and
 * watches it, so a change from a text editor applies at once. A file that is not valid never stops the app: the store
 * ignores the bad entries and keeps a message for each one.
 */
export class KeybindingStore {
    private current: KeybindingsState;
    private watcher: FSWatcher | undefined;
    private timer: NodeJS.Timeout | undefined;
    private readonly listeners = new Set<(state: KeybindingsState) => void>();

    constructor(readonly file: string) {
        this.current = { file, overrides: {}, problems: [] };
    }

    /** The last state that the store read. */
    state(): KeybindingsState {
        return this.current;
    }

    /** The keymap of the last state. */
    keymap(): Keymap {
        return keymapOf(this.current.overrides);
    }

    /** Reads the file again. Calls the listeners when the state changed. */
    async load(): Promise<KeybindingsState> {
        const next = await this.read();
        if (JSON.stringify(next) !== JSON.stringify(this.current)) {
            this.current = next;
            for (const listener of this.listeners) listener(next);
        }
        return this.current;
    }

    /** Applies the changes to the file and returns the new state. Throws when the file is not a valid JSON object. */
    async update(changes: readonly KeybindingChange[]): Promise<KeybindingsState> {
        const data = await this.readObject();
        await this.write(applyKeybindingChanges(data, changes));
        return this.load();
    }

    /** Writes an empty object, so all commands get their default keys. This also replaces a file that is not valid. */
    async resetAll(): Promise<KeybindingsState> {
        await this.write({});
        return this.load();
    }

    /** Calls `listener` with each new state. Returns a function that stops the calls. */
    subscribe(listener: (state: KeybindingsState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Watches the folder of the file, so a change from another app loads at once. */
    async watch(): Promise<void> {
        const folder = path.dirname(this.file);
        const name = path.basename(this.file);
        await fs.mkdir(folder, { recursive: true });
        this.watcher?.close();
        this.watcher = watch(folder, (_event, changed) => {
            // A rename of a temporary file gives the name of the file. Some systems give no name.
            if (changed && changed.toString() !== name) return;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                void this.load().catch(error => console.warn(`[keybindings] The file was not read: ${errorText(error)}`));
            }, 100);
        });
        this.watcher.on('error', error => console.warn(`[keybindings] The folder is not watched: ${errorText(error)}`));
    }

    close(): void {
        clearTimeout(this.timer);
        this.watcher?.close();
        this.watcher = undefined;
    }

    private async read(): Promise<KeybindingsState> {
        let text: string;
        try {
            text = await fs.readFile(this.file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: this.file, overrides: {}, problems: [] };
            return { file: this.file, overrides: {}, problems: [`ShipWarden could not read the file: ${errorText(error)}`] };
        }
        const parsed = parseKeybindingsFile(text);
        return { file: this.file, overrides: parsed.overrides as KeybindingOverrides, problems: parsed.problems };
    }

    /** Returns the object of the file, or an empty object without a file. */
    private async readObject(): Promise<Record<string, unknown>> {
        let text: string;
        try {
            text = await fs.readFile(this.file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
            throw error;
        }
        if (!text.trim()) return {};
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch {
            data = undefined;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new KeybindingsFileError(`${this.file} is not a valid JSON object. Correct the file, or click "Reset all" to replace it.`);
        }
        return data as Record<string, unknown>;
    }

    private async write(data: Record<string, unknown>): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        try {
            await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
            await fs.rename(temp, this.file);
        } catch (error) {
            await fs.rm(temp, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
