import { describe, expect, it, vi } from 'vitest';
import type { LspMissingServer } from '@shared/lsp';
import { MissingServerStore } from './missing-servers';

const gopls: LspMissingServer = {
    serverId: 'gopls',
    name: 'gopls',
    install: { description: 'Runs go install.', source: 'go install golang.org/x/tools/gopls@latest', folder: '/data/language-servers/gopls/bin' }
};

describe('MissingServerStore', () => {
    it('returns the missing server of a worktree and language', () => {
        const store = new MissingServerStore();
        store.set('/r', 'go', gopls);
        expect(store.get('/r', 'go')).toEqual({ server: gopls, install: undefined });
        expect(store.get('/other', 'go')).toBeUndefined();
    });

    it('hides a server after "Not now" in all worktrees', () => {
        const store = new MissingServerStore();
        store.set('/a', 'go', gopls);
        store.set('/b', 'go', gopls);
        store.dismiss('gopls');
        expect(store.get('/a', 'go')).toBeUndefined();
        expect(store.get('/b', 'go')).toBeUndefined();
        expect(store.has('/a', 'go')).toBe(true);
    });

    it('shows the install state, and removes the server from all worktrees after the install', () => {
        const store = new MissingServerStore();
        store.set('/a', 'go', gopls);
        store.set('/b', 'go', gopls);
        store.setInstallState('gopls', { serverId: 'gopls', status: 'running', step: 'Downloading', progress: 0.5 });
        expect(store.isInstalling('gopls')).toBe(true);
        expect(store.get('/a', 'go')?.install?.progress).toBe(0.5);
        store.setInstallState('gopls', { serverId: 'gopls', status: 'error', error: 'No network.' });
        expect(store.isInstalling('gopls')).toBe(false);
        expect(store.get('/b', 'go')?.install?.error).toBe('No network.');
        expect(store.anyEntryOf('gopls')).toEqual({ root: '/a', languageId: 'go', server: gopls });
        store.deleteServer('gopls');
        expect(store.anyEntryOf('gopls')).toBeUndefined();
        expect(store.get('/b', 'go')).toBeUndefined();
    });

    it('tells the listeners about each change', () => {
        const store = new MissingServerStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        const version = store.getVersion();
        store.set('/a', 'go', gopls);
        store.delete('/a', 'go');
        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.getVersion()).toBe(version + 2);
        unsubscribe();
        store.set('/a', 'go', gopls);
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
