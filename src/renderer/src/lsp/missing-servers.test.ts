import { describe, expect, it, vi } from 'vitest';
import type { LspMissingServer } from '@shared/lsp';
import { MissingServerStore } from './missing-servers';

const gopls: LspMissingServer = { serverId: 'gopls', name: 'gopls', installCommand: 'go install golang.org/x/tools/gopls@latest', tools: ['go', 'brew'] };

describe('MissingServerStore', () => {
    it('returns the missing server of a worktree and language', () => {
        const store = new MissingServerStore();
        store.set('/r', 'go', gopls);
        expect(store.get('/r', 'go')).toEqual({ server: gopls, installing: false });
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
        store.setInstalling('gopls', true);
        expect(store.get('/a', 'go')?.installing).toBe(true);
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
