import { request } from 'https';
import type { TLSSocket } from 'tls';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePairingLink, type RemoteAgent, type RemoteSnapshot, type ScreenSnapshot } from '@shared/remote';
import type { TerminalSession } from '@shared/terminal';
import { RemoteDevices } from './remote-devices';
import { RemoteServer } from './remote-server';
import { ensureTlsIdentity, type TlsIdentity } from './tls-identity';

const agent: TerminalSession = {
    id: 'agent-1', title: 'Claude', cwd: '/repo', worktreePath: '/repo', isAgent: true, exited: false,
    cols: 20, rows: 3, agentState: 'waiting', agentMessage: 'Claude needs your permission to use Bash'
};
const shell: TerminalSession = { id: 'shell-1', title: 'zsh', cwd: '/repo', isAgent: false, exited: false };

interface Response { status: number; body: string; fingerprint: string }

describe('RemoteServer', () => {
    let folder: string;
    let identity: TlsIdentity;
    let server: RemoteServer;
    const writes: [string, string][] = [];
    const approvals: unknown[][] = [];

    /** Sends a request like the phone: it trusts the certificate only by its fingerprint. */
    function send(method: string, path: string, options: { token?: string; body?: unknown; stream?: (text: string) => boolean } = {}): Promise<Response> {
        return new Promise((resolve, reject) => {
            const body = options.body === undefined ? undefined : JSON.stringify(options.body);
            const req = request({
                host: '127.0.0.1', port: server.port, method, path, rejectUnauthorized: false,
                headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }
            }, res => {
                const fingerprint = ((res.socket as TLSSocket).getPeerCertificate().fingerprint256 ?? '').replace(/:/g, '').toLowerCase();
                let text = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    text += chunk;
                    if (options.stream?.(text)) {
                        req.destroy();
                        resolve({ status: res.statusCode ?? 0, body: text, fingerprint });
                    }
                });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, fingerprint }));
            });
            req.on('error', error => (options.stream ? undefined : reject(error)));
            req.end(body);
        });
    }

    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), 'shipwarden-remote-'));
        identity = await ensureTlsIdentity(folder);
        server = new RemoteServer({
            devices: new RemoteDevices(join(folder, 'remote-devices.json')),
            identity: async () => identity,
            hosts: () => ['127.0.0.1'],
            listenHost: '127.0.0.1',
            backend: {
                macName: () => 'Test Mac',
                version: '1.2.3',
                snapshot: async () => ({ projects: [], agents: [] }),
                sessions: async () => [agent, shell],
                replay: async () => ({ data: 'hello \x1b[32mworld\x1b[0m', seq: 1 }),
                write: (id, data) => writes.push([id, data]),
                approvePullRequest: async (...args) => {
                    approvals.push(args);
                },
                onStatusChanged: () => undefined
            }
        });
        await server.apply({ enabled: true, port: 0, keepRunning: false });
    });

    afterAll(async () => {
        await server.stop();
        rmSync(folder, { recursive: true, force: true });
    });

    it('keeps the same certificate in the folder', async () => {
        expect((await ensureTlsIdentity(folder)).fingerprint).toBe(identity.fingerprint);
        expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('pairs a phone, then serves the API to its token only', async () => {
        expect((await server.status()).running).toBe(true);
        const link = parsePairingLink(server.startPairing().link)!;
        expect(link.port).toBe(server.port);

        const wrong = await send('POST', '/v1/pair', { body: { code: 'wrong', name: 'Phone' } });
        expect(wrong.status).toBe(403);

        const paired = await send('POST', '/v1/pair', { body: { code: link.code, name: 'Test iPhone' } });
        expect(paired.status).toBe(200);
        // The phone compares this fingerprint with the fingerprint in the pairing link.
        expect(paired.fingerprint).toBe(link.fingerprint);
        const { token } = JSON.parse(paired.body) as { token: string };

        expect((await send('GET', '/v1/state')).status).toBe(401);
        expect((await send('GET', '/v1/state', { token: 'not-a-token' })).status).toBe(401);
        const state = await send('GET', '/v1/state', { token });
        expect(state.status).toBe(200);
        expect(JSON.parse(state.body) as RemoteSnapshot).toMatchObject({ protocol: 1, mac: { name: 'Test Mac', version: '1.2.3' } });

        // The event stream starts with the agents. Shells are not in the list.
        const events = await send('GET', '/v1/events', { token, stream: text => text.includes('event: agents') && text.endsWith('\n\n') });
        const agents = JSON.parse(/event: agents\ndata: (.*)\n/.exec(events.body)![1]) as RemoteAgent[];
        expect(agents.map(item => item.id)).toEqual(['agent-1']);
        expect(agents[0].message).toBe('Claude needs your permission to use Bash');

        // The screen stream sends the replay as styled text.
        const screen = await send('GET', '/v1/sessions/agent-1/screen', { token, stream: text => /event: screen\ndata: .*\n\n/.test(text) });
        const snapshot = JSON.parse(/event: screen\ndata: (.*)\n/.exec(screen.body)![1]) as ScreenSnapshot;
        expect(snapshot.lines[0]).toEqual([{ t: 'hello ' }, { t: 'world', fg: 2 }]);

        // Text and Enter are separate writes.
        expect((await send('POST', '/v1/sessions/agent-1/input', { token, body: { text: 'yes', submit: true } })).status).toBe(200);
        expect(writes).toEqual([['agent-1', 'yes'], ['agent-1', '\r']]);

        // The phone cannot type in a shell.
        expect((await send('POST', '/v1/sessions/shell-1/input', { token, body: { text: 'ls', submit: true } })).status).toBe(404);

        expect((await send('POST', '/v1/pull-requests/approve', { token, body: { worktreePath: '/repo', number: 7, headSha: 'abc' } })).status).toBe(200);
        expect(approvals).toEqual([['/repo', 7, 'abc', '']]);

        // A removed phone loses access at once.
        const device = (await server.status()).devices[0];
        await server.removeDevice(device.id);
        expect((await send('GET', '/v1/state', { token })).status).toBe(401);
    });
});
