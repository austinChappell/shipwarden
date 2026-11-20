import { execFile } from 'child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeHookSettings, geminiHookSettings } from '@shared/agents';
import { HookServer } from './hook-server';

/** The environment of the test process without the hook variables of a ShipWarden terminal that runs the tests. */
function cleanEnv(): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GEMINI_CLI_)?(SHIPWARDEN|YARDMASTER)_/.test(name)));
}

const STOP = JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });

/**
 * Runs a hook command as Claude Code runs it: with /bin/sh and the event JSON on stdin.
 * It does not block, because the server in this process must answer. Rejects when the command fails.
 */
function runHook(command: string, env: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = execFile('/bin/sh', ['-c', command], { env: { ...cleanEnv(), ...env } }, error => (error ? reject(error) : resolve()));
        child.stdin?.end(STOP);
    });
}

const claudeStop = () => (claudeHookSettings().hooks.Stop[0] as { hooks: { command: string }[] }).hooks[0].command;
const geminiAfterAgent = () => (geminiHookSettings().hooks as Record<string, { hooks: { command: string }[] }[]>).AfterAgent[0].hooks[0].command;

describe('HookServer', () => {
    let server: HookServer | undefined;
    let folder: string;

    beforeEach(() => {
        folder = mkdtempSync(join(tmpdir(), 'sw-hook-'));
    });

    afterEach(() => {
        server?.stop();
        server = undefined;
        rmSync(folder, { recursive: true, force: true });
    });

    it('receives an event from the real hook command through the socket and rejects a wrong token', async () => {
        const events: [string, string, Record<string, unknown>][] = [];
        server = new HookServer((sessionId, event, payload) => events.push([sessionId, event, payload]));
        const { socket, token } = await server.start(join(folder, 'host.hook'));
        expect(statSync(socket).mode & 0o777).toBe(0o600);

        await runHook(claudeStop(), { SHIPWARDEN_HOOK_SOCKET: socket, SHIPWARDEN_HOOK_TOKEN: 'wrong-token', SHIPWARDEN_SESSION_ID: 'session-1' });
        await runHook(claudeStop(), { SHIPWARDEN_HOOK_SOCKET: socket, SHIPWARDEN_HOOK_TOKEN: token, SHIPWARDEN_SESSION_ID: 'session-1' });
        // Gemini CLI removes variables with "TOKEN" in the name. The command reads the GEMINI_CLI_ copies.
        await runHook(geminiAfterAgent(), {
            GEMINI_CLI_SHIPWARDEN_HOOK_SOCKET: socket,
            GEMINI_CLI_SHIPWARDEN_HOOK_TOKEN: token,
            GEMINI_CLI_SHIPWARDEN_SESSION_ID: 'session-2'
        });

        expect(events).toEqual([
            ['session-1', 'Stop', { hook_event_name: 'Stop', last_assistant_message: 'Done.' }],
            ['session-2', 'AfterAgent', { hook_event_name: 'Stop', last_assistant_message: 'Done.' }]
        ]);
    });

    it('replaces a socket file that a stopped host left, and removes the socket when it stops', async () => {
        const path = join(folder, 'host.hook');
        const first = new HookServer(() => undefined);
        await first.start(path);
        // A host that crashed does not remove its socket file.
        const second = new HookServer(() => undefined);
        server = second;
        await expect(second.start(path)).resolves.toMatchObject({ socket: path });
        first.stop();
        second.stop();
        expect(existsSync(path)).toBe(false);
    });
});

describe('hook command', () => {
    let tcp: Server | undefined;

    afterEach(() => tcp?.close());

    it('uses the URL of an older PTY host when the socket variable is not set', async () => {
        const received: { url?: string; token?: string; body: string }[] = [];
        tcp = createServer((request, response) => {
            let body = '';
            request.on('data', chunk => (body += chunk));
            request.on('end', () => {
                received.push({ url: request.url, token: request.headers['x-yardmaster-token'] as string, body });
                response.writeHead(204).end();
            });
        });
        await new Promise<void>(resolve => tcp!.listen(0, '127.0.0.1', resolve));
        const { port } = tcp.address() as AddressInfo;

        await runHook(claudeStop(), { SHIPWARDEN_HOOK_URL: `http://127.0.0.1:${port}`, SHIPWARDEN_HOOK_TOKEN: 'old', SHIPWARDEN_SESSION_ID: 'session-1' });

        expect(received).toEqual([{ url: '/hook/session-1/Stop', token: 'old', body: STOP }]);
    });

    it('succeeds without ShipWarden', async () => {
        await expect(runHook(claudeStop(), {})).resolves.toBeUndefined();
    });
});
