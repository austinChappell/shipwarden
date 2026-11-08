import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalEvents } from '../terminal/terminal-manager';
import { PtyHostClient } from './pty-host-client';
import { PtyHostServer } from './pty-host-server';
import { buildSocketPath, ptyHostSocketFolder } from './protocol';

const SHELL_ENV = { SHELL: '/bin/sh', PATH: '/usr/bin:/bin', HOME: tmpdir() };

function until(test: () => boolean, timeout = 5000): Promise<void> {
    const deadline = Date.now() + timeout;
    return new Promise((resolve, reject) => {
        const check = () => {
            if (test()) {
                resolve();
            } else if (Date.now() > deadline) {
                reject(new Error('The condition did not become true in time.'));
            } else {
                setTimeout(check, 20);
            }
        };
        check();
    });
}

describe('PTY host', () => {
    let folder: string;
    const servers: PtyHostServer[] = [];
    const clients: PtyHostClient[] = [];

    afterEach(() => {
        clients.splice(0).forEach(client => client.dispose());
        servers.splice(0).forEach(server => server.stop());
        rmSync(folder, { recursive: true, force: true });
    });

    /** Makes a client whose "spawn" starts an in-process server. */
    function setup(buildId: string, idle: { count: number } = { count: 0 }) {
        folder = mkdtempSync(join(tmpdir(), 'ym-'));
        // The socket of a host from before the per-build sockets.
        const olderSocketPath = join(folder, 'pty-host-v1.sock');
        const output: Record<string, string> = {};
        const exits: string[] = [];
        const events: TerminalEvents = {
            data: (id, data) => {
                output[id] = (output[id] ?? '') + data;
            },
            exit: id => exits.push(id),
            agentState: () => undefined
        };
        const spawned: string[] = [];
        const spawnHost = (path: string, id: string) => {
            spawned.push(id);
            const server = new PtyHostServer({
                socketPath: path,
                buildId: id,
                idleMs: 50,
                onIdle: () => {
                    idle.count++;
                    server.stop();
                }
            });
            servers.push(server);
            server.start();
        };
        const makeClient = (clientBuildId = buildId) => {
            const socketPath = buildSocketPath(folder, clientBuildId);
            const client = new PtyHostClient({ socketPath, olderSocketPaths: [olderSocketPath], hostScript: '', logPath: join(folder, 'log'), events, spawnHost, buildId: clientBuildId });
            clients.push(client);
            return client;
        };
        return { olderSocketPath, output, exits, spawned, spawnHost, makeClient, idle };
    }

    it('keeps a session when the app disconnects, and a new app gets its output', async () => {
        const { output, spawned, makeClient } = setup('build-1');
        const first = makeClient();
        const session = await first.create({ cwd: tmpdir(), title: 'shell', cols: 80, rows: 24, command: 'echo yard-hello' }, SHELL_ENV);
        await until(() => (output[session.id] ?? '').includes('yard-hello'));
        expect(spawned).toEqual(['build-1']);

        // The app quits: only the connection closes.
        first.dispose();

        // The next app run connects to the same host and does not start another one.
        const second = makeClient();
        const sessions = await second.list();
        expect(sessions.map(item => item.id)).toEqual([session.id]);
        expect(sessions[0].exited).toBe(false);
        expect((await second.replay(session.id)).data).toContain('yard-hello');
        expect(spawned).toEqual(['build-1']);

        await second.kill(session.id);
        expect(await second.list()).toEqual([]);
    });

    it('stops when no app is connected and no session runs', async () => {
        const idle = { count: 0 };
        const { makeClient } = setup('build-1', idle);
        const client = makeClient();
        const session = await client.create({ cwd: tmpdir(), title: 'shell', cols: 80, rows: 24 }, SHELL_ENV);
        client.dispose();
        await new Promise(resolve => setTimeout(resolve, 150));
        // A running session keeps the host alive.
        expect(idle.count).toBe(0);

        const other = makeClient();
        await other.kill(session.id);
        other.dispose();
        await until(() => idle.count === 1);
    });

    it('stops the host and its running sessions when the app asks', async () => {
        const idle = { count: 0 };
        const { makeClient } = setup('build-1', idle);
        const client = makeClient();
        await client.create({ cwd: tmpdir(), title: 'shell', cols: 80, rows: 24 }, SHELL_ENV);
        expect(client.isConnected()).toBe(true);

        await client.shutdownHost();
        await until(() => idle.count === 1);
        expect(client.isConnected()).toBe(false);
    });

    it('does not start a host only to stop it', async () => {
        const { spawned, makeClient } = setup('build-1');
        await makeClient().shutdownHost();
        expect(spawned).toEqual([]);
    });

    it('stops a host of another build when it has no running session', async () => {
        const idle = { count: 0 };
        const { spawned, makeClient } = setup('old', idle);
        await makeClient('old').list();
        clients[0].dispose();

        await makeClient('new').list();
        expect(spawned).toEqual(['old', 'new']);
        await until(() => idle.count === 1);
    });

    it('keeps the sessions of an outdated host, and starts new sessions in the host of its own build', async () => {
        const idle = { count: 0 };
        const { spawned, makeClient } = setup('old', idle);
        const old = makeClient('old');
        const oldSession = await old.create({ cwd: tmpdir(), title: 'old shell', cols: 80, rows: 24 }, SHELL_ENV);
        old.dispose();

        const client = makeClient('new');
        const listed = await client.list();
        expect(listed.map(item => [item.id, item.hostOutdated])).toEqual([[oldSession.id, true]]);

        const newSession = await client.create({ cwd: tmpdir(), title: 'new shell', cols: 80, rows: 24 }, SHELL_ENV);
        expect(spawned).toEqual(['old', 'new']);
        const all = await client.list();
        expect(all.map(item => [item.title, !!item.hostOutdated]).sort()).toEqual([['new shell', false], ['old shell', true]]);
        expect(await client.hostPids()).toHaveLength(2);

        // The last session of the outdated host ends. The app disconnects, and the outdated host stops.
        await client.kill(oldSession.id);
        await until(() => idle.count === 1);
        expect((await client.list()).map(item => item.id)).toEqual([newSession.id]);
    });

    it('finds an outdated host on an older socket', async () => {
        const { olderSocketPath, spawnHost } = setup('new');
        spawnHost(olderSocketPath, 'older');
        const old = new PtyHostClient({ socketPath: olderSocketPath, hostScript: '', logPath: join(folder, 'log'), events: { data: () => undefined, exit: () => undefined, agentState: () => undefined }, buildId: 'older' });
        clients.push(old);
        await old.create({ cwd: tmpdir(), title: 'older shell', cols: 80, rows: 24 }, SHELL_ENV);
        old.dispose();

        // A second path to the same host, as "Yardmaster" and "yardmaster" on a file system that ignores case.
        const alias = join(folder, 'alias.sock');
        symlinkSync(olderSocketPath, alias);
        const client = new PtyHostClient({
            socketPath: buildSocketPath(folder, 'new'),
            olderSocketPaths: [olderSocketPath, alias],
            hostScript: '',
            logPath: join(folder, 'log'),
            events: { data: () => undefined, exit: () => undefined, agentState: () => undefined },
            spawnHost,
            buildId: 'new'
        });
        clients.push(client);
        const listed = await client.list();
        expect(listed.map(item => [item.title, item.hostOutdated])).toEqual([['older shell', true]]);
        // The older host and the new host. The alias does not add the older host a second time.
        expect(await client.hostPids()).toHaveLength(2);
    });

    it('keeps each socket path below the limit of macOS', () => {
        const longFolder = join('/Users/someone', 'a'.repeat(120), 'ShipWarden');
        const path = buildSocketPath(ptyHostSocketFolder(longFolder), 'debe63ac8a194271');
        expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103);
        expect(ptyHostSocketFolder('/Users/me/Library/Application Support/ShipWarden')).toBe('/Users/me/Library/Application Support/ShipWarden');
    });

    it('stops only the outdated hosts when the app asks', async () => {
        const idle = { count: 0 };
        const { exits, makeClient } = setup('old', idle);
        const old = makeClient('old');
        const oldSession = await old.create({ cwd: tmpdir(), title: 'old shell', cols: 80, rows: 24 }, SHELL_ENV);
        old.dispose();

        const client = makeClient('new');
        const newSession = await client.create({ cwd: tmpdir(), title: 'new shell', cols: 80, rows: 24 }, SHELL_ENV);
        expect(await client.shutdownOutdatedHosts()).toBe(1);
        expect(exits).toContain(oldSession.id);
        await until(() => idle.count === 1);
        const listed = await client.list();
        expect(listed.map(item => [item.id, item.exited])).toEqual([[newSession.id, false]]);
    });
});
