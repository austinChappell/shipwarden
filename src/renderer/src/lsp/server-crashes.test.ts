import { describe, expect, it } from 'vitest';
import type { LspServerCrash } from '@shared/lsp';
import { ServerCrashStore } from './server-crashes';

const sorbet: LspServerCrash = {
    serverId: 'ruby',
    name: 'Sorbet or ruby-lsp',
    root: '/a',
    languages: ['ruby'],
    command: 'bundle exec srb typecheck --lsp',
    reason: 'exit code 1',
    output: 'Could not find gem sorbet'
};

const typescript: LspServerCrash = { ...sorbet, serverId: 'typescript', name: 'typescript-language-server', languages: ['typescript', 'javascript'] };

describe('ServerCrashStore', () => {
    it('keeps the crash for each language of the server in the worktree', () => {
        const store = new ServerCrashStore();
        store.set(typescript);
        expect(store.get('/a', 'typescript')).toBe(typescript);
        expect(store.get('/a', 'javascript')).toBe(typescript);
        expect(store.get('/b', 'typescript')).toBeUndefined();
    });

    it('hides the banner after "Not now", but keeps the server stopped', () => {
        const store = new ServerCrashStore();
        store.set(sorbet);
        store.dismiss('ruby');
        expect(store.get('/a', 'ruby')).toBeUndefined();
        expect(store.has('/a', 'ruby')).toBe(true);
    });

    it('removes the crash of one worktree before "Try again"', () => {
        const store = new ServerCrashStore();
        store.set(sorbet);
        store.set({ ...sorbet, root: '/b' });
        store.clear('/a', 'ruby');
        expect(store.has('/a', 'ruby')).toBe(false);
        expect(store.has('/b', 'ruby')).toBe(true);
    });
});
