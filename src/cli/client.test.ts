import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_PROTOCOL } from '@shared/cli';
import { ClientError, readConfig, sendRequest } from './client';

let folder: string;
let fake: Server | undefined;
let received: unknown[] = [];

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'sw-client-'));
    received = [];
});

afterEach(() => {
    fake?.close();
    fake = undefined;
    rmSync(folder, { recursive: true, force: true });
});

/** A fake app: it reads one line and writes the answer. */
function fakeApp(answer: (request: unknown) => string | undefined): Promise<string> {
    const socket = join(folder, 'fake.sock');
    return new Promise(resolve => {
        fake = createServer(connection => {
            let buffer = '';
            connection.setEncoding('utf8');
            connection.on('data', (chunk: string) => {
                buffer += chunk;
                if (!buffer.includes('\n')) return;
                const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
                received.push(request);
                const text = answer(request);
                if (text === undefined) connection.end();
                else connection.end(text);
            });
        });
        fake.listen(socket, () => resolve(socket));
    });
}

describe('sendRequest', () => {
    it('sends the token, the command, the values, and the folder', async () => {
        const socket = await fakeApp(() => `${JSON.stringify({ ok: true, result: { message: 'Hi' } })}\n`);
        const response = await sendRequest({ socket, token: 't1' }, 'agent.send', { prompt: 'Run the tests' }, '/w/a');
        expect(response).toEqual({ ok: true, result: { message: 'Hi' } });
        expect(received).toEqual([{ protocol: CLI_PROTOCOL, token: 't1', command: 'agent.send', args: { prompt: 'Run the tests' }, cwd: '/w/a' }]);
    });

    it('fails when the app closes the connection without an answer', async () => {
        const socket = await fakeApp(() => undefined);
        await expect(sendRequest({ socket, token: 't1' }, 'status', {}, '/')).rejects.toThrow('without an answer');
    });

    it('fails when the answer is not JSON', async () => {
        const socket = await fakeApp(() => 'nonsense\n');
        await expect(sendRequest({ socket, token: 't1' }, 'status', {}, '/')).rejects.toThrow('not valid JSON');
    });

    it('tells that the app is not running when the socket is missing', async () => {
        const error = await sendRequest({ socket: join(folder, 'missing.sock'), token: 't1' }, 'status', {}, '/').catch(err => err);
        expect(error).toBeInstanceOf(ClientError);
        expect(error.message).toContain('ShipWarden is not running');
        expect(error.exitCode).toBe(4);
    });
});

describe('readConfig', () => {
    it('reads a valid file', async () => {
        const file = join(folder, 'cli.json');
        writeFileSync(file, JSON.stringify({ protocol: 1, socket: '/s.sock', token: 'abc', pid: 4, version: '1.0.0' }));
        expect(await readConfig(file)).toEqual({ protocol: 1, socket: '/s.sock', token: 'abc', pid: 4, version: '1.0.0' });
    });

    it('fails for a missing or a broken file', async () => {
        await expect(readConfig(join(folder, 'none.json'))).rejects.toThrow('ShipWarden is not running');
        const file = join(folder, 'broken.json');
        writeFileSync(file, '{"socket": 3}');
        await expect(readConfig(file)).rejects.toThrow('is not valid');
    });
});
