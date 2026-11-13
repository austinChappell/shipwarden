import { describe, expect, it, vi } from 'vitest';
import { SERVER_CRASHED, type LspServerCrash, type LspServerMessage } from '@shared/lsp';
import type { ServerInstaller } from './server-install';

// By default, a server that writes to stderr and stops with exit code 3 before it answers "initialize".
const server = vi.hoisted(() => ({ command: { command: 'sh', args: ['-c', 'echo "Could not find gem sorbet" >&2; exit 3'] } }));

vi.mock('./servers', () => ({
    serverForLanguage: () => ({
        id: 'ruby',
        name: 'Sorbet or ruby-lsp',
        languages: ['ruby'],
        installable: false,
        resolve: async () => server.command
    })
}));

const { LspManager } = await import('./lsp-manager');

describe('LspManager', () => {
    it('reports a server that stops at the start, with the exit code and the stderr lines', async () => {
        const messages: LspServerMessage[] = [];
        const manager = new LspManager(message => messages.push(message), Promise.resolve(), {} as ServerInstaller);

        expect(await manager.ensure('/tmp', 'ruby')).toBeUndefined();

        const crashes = messages.filter(message => message.method === SERVER_CRASHED);
        expect(crashes).toHaveLength(1);
        expect(crashes[0].params as LspServerCrash).toEqual({
            serverId: 'ruby',
            name: 'Sorbet or ruby-lsp',
            root: '/tmp',
            languages: ['ruby'],
            command: 'sh -c echo "Could not find gem sorbet" >&2; exit 3',
            reason: 'exit code 3',
            output: 'Could not find gem sorbet'
        });
    });

    it('reports a command that does not exist', async () => {
        server.command = { command: '/no/such/srb', args: [] };
        const messages: LspServerMessage[] = [];
        const manager = new LspManager(message => messages.push(message), Promise.resolve(), {} as ServerInstaller);

        expect(await manager.ensure('/tmp', 'ruby')).toBeUndefined();

        const crash = messages.find(message => message.method === SERVER_CRASHED)?.params as LspServerCrash;
        expect(crash.reason).toBe('it did not start: spawn /no/such/srb ENOENT');
    });
});
