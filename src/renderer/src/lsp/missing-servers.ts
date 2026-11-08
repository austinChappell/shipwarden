import { useSyncExternalStore } from 'react';
import { lspLanguageId, type LspMissingServer } from '@shared/lsp';

interface Entry {
    root: string;
    languageId: string;
    server: LspMissingServer;
}

/** The state of a missing server for one file. */
export interface MissingServerState {
    server: LspMissingServer;
    /** True while ShipWarden waits for an install command to complete. */
    installing: boolean;
}

function entryKey(root: string, languageId: string): string {
    return `${root}\0${languageId}`;
}

/**
 * Keeps the language servers that worktrees need but that are not installed.
 * "Not now" hides a server until the app restarts.
 */
export class MissingServerStore {
    private readonly entries = new Map<string, Entry>();
    private readonly installing = new Set<string>();
    private readonly dismissed = new Set<string>();
    private readonly listeners = new Set<() => void>();
    private version = 0;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    has(root: string, languageId: string): boolean {
        return this.entries.has(entryKey(root, languageId));
    }

    /** Returns the state for the file, or undefined when the server is available or the user hid it. */
    get(root: string, languageId: string): MissingServerState | undefined {
        const entry = this.entries.get(entryKey(root, languageId));
        if (!entry || this.dismissed.has(entry.server.serverId)) {
            return undefined;
        }
        return { server: entry.server, installing: this.installing.has(entry.server.serverId) };
    }

    set(root: string, languageId: string, server: LspMissingServer): void {
        this.entries.set(entryKey(root, languageId), { root, languageId, server });
        this.changed();
    }

    delete(root: string, languageId: string): void {
        if (this.entries.delete(entryKey(root, languageId))) {
            this.changed();
        }
    }

    /** Returns one worktree and language that need the server, or undefined. */
    anyEntryOf(serverId: string): { root: string; languageId: string } | undefined {
        return [...this.entries.values()].find(entry => entry.server.serverId === serverId);
    }

    /** Removes the server from all worktrees, for example after an install. */
    deleteServer(serverId: string): void {
        for (const [key, entry] of this.entries) {
            if (entry.server.serverId === serverId) {
                this.entries.delete(key);
            }
        }
        this.changed();
    }

    isInstalling(serverId: string): boolean {
        return this.installing.has(serverId);
    }

    setInstalling(serverId: string, installing: boolean): void {
        if (installing) {
            this.installing.add(serverId);
        } else {
            this.installing.delete(serverId);
        }
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

export const missingServers = new MissingServerStore();

/** Returns the missing language server for a file of a worktree, or undefined. */
export function useMissingServer(root: string, path: string): MissingServerState | undefined {
    useSyncExternalStore(missingServers.subscribe, missingServers.getVersion);
    const languageId = lspLanguageId(path);
    return languageId ? missingServers.get(root, languageId) : undefined;
}
