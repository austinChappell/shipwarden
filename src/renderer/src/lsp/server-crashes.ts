import { useSyncExternalStore } from 'react';
import { lspLanguageId, type LspServerCrash } from '@shared/lsp';

function entryKey(root: string, languageId: string): string {
    return `${root}\0${languageId}`;
}

/**
 * Keeps the language servers that stopped without a request from ShipWarden, for each worktree and language.
 * While a crash is in the store, the bridge does not start the server again. "Try again" removes the crash.
 * "Not now" hides the banner of a server until the app restarts. The server stays stopped.
 */
export class ServerCrashStore {
    private readonly entries = new Map<string, LspServerCrash>();
    private readonly dismissed = new Set<string>();
    private readonly listeners = new Set<() => void>();
    private version = 0;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    /** Returns true when the server of the language crashed in the worktree, also when the user hid the banner. */
    has(root: string, languageId: string): boolean {
        return this.entries.has(entryKey(root, languageId));
    }

    /** Returns the crash for the banner, or undefined when no crash occurred or the user hid it. */
    get(root: string, languageId: string): LspServerCrash | undefined {
        const crash = this.entries.get(entryKey(root, languageId));
        return crash && !this.dismissed.has(crash.serverId) ? crash : undefined;
    }

    /** Adds the crash for all languages of the server. */
    set(crash: LspServerCrash): void {
        for (const languageId of crash.languages) {
            this.entries.set(entryKey(crash.root, languageId), crash);
        }
        this.changed();
    }

    /** Removes the crash of the server in the worktree, for example before "Try again". */
    clear(root: string, serverId: string): void {
        for (const [key, crash] of this.entries) {
            if (crash.root === root && crash.serverId === serverId) {
                this.entries.delete(key);
            }
        }
        this.dismissed.delete(serverId);
        this.changed();
    }

    dismiss(serverId: string): void {
        this.dismissed.add(serverId);
        this.changed();
    }

    private changed(): void {
        this.version += 1;
        this.listeners.forEach(listener => listener());
    }
}

export const serverCrashes = new ServerCrashStore();

/** Returns the crash of the language server for a file of a worktree, or undefined. */
export function useServerCrash(root: string, path: string): LspServerCrash | undefined {
    useSyncExternalStore(serverCrashes.subscribe, serverCrashes.getVersion);
    const languageId = lspLanguageId(path);
    return languageId ? serverCrashes.get(root, languageId) : undefined;
}
