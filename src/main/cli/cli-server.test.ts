import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_PROTOCOL, type CliResponse } from '@shared/cli';
import { sendRequest } from '../../cli/client';
import { checkRequest, CliError, CliServer, sameToken, type CliHandler } from './cli-server';

const TOKEN = 'good-token';
let folder: string;
let server: CliServer | undefined;
const signals: AbortSignal[] = [];

const handler: CliHandler = {
    handle: async (request, signal) => {
        signals.push(signal);
        if (request.command === 'agent.wait') {
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            return {};
        }
        if (request.command === 'task.get') throw new CliError('notFound', 'No task.');
        if (request.command === 'task.status') throw new Error('Boom.');
        return { message: `cwd ${request.cwd}`, args: request.args };
    }
};

async function start(): Promise<string> {
    folder = mkdtempSync(join(tmpdir(), 'sw-cli-'));
    const socketPath = join(folder, 'cli.sock');
    server = new CliServer({ socketPath, token: TOKEN, handler });
    await server.start();
    return socketPath;
}

afterEach(() => {
    server?.stop();
    server = undefined;
    signals.length = 0;
    rmSync(folder, { recursive: true, force: true });
});

describe('CliServer', () => {
    it('answers a request with the token', async () => {
        const socket = await start();
        const response = await sendRequest({ socket, token: TOKEN }, 'status', { all: true }, '/w/a');
        expect(response).toEqual({ ok: true, result: { message: 'cwd /w/a', args: { all: true } } });
    });

    it('makes a socket that only the user can open', async () => {
        const socket = await start();
        expect(statSync(socket).mode & 0o777).toBe(0o600);
    });

    it('refuses a request without a token or with a wrong token', async () => {
        const socket = await start();
        const none = await sendRequest({ socket, token: '' }, 'status', {}, '/w/a');
        expect(none).toEqual({ ok: false, error: { code: 'unauthorized', message: 'The request has no token.' } });
        const wrong = await sendRequest({ socket, token: 'bad-token' }, 'status', {}, '/w/a');
        expect(wrong.ok).toBe(false);
        expect(!wrong.ok && wrong.error.code).toBe('unauthorized');
        expect(signals).toHaveLength(0);
    });

    it('gives the code of a CliError, and "failed" for other errors', async () => {
        const socket = await start();
        expect(await sendRequest({ socket, token: TOKEN }, 'task.get', {}, '/w/a')).toEqual({ ok: false, error: { code: 'notFound', message: 'No task.' } });
        expect(await sendRequest({ socket, token: TOKEN }, 'task.status', {}, '/w/a')).toEqual({ ok: false, error: { code: 'failed', message: 'Boom.' } });
    });

    it('stops the command when the CLI closes the connection', async () => {
        const socket = await start();
        const { connect } = await import('net');
        const client = connect(socket);
        await new Promise(resolve => client.once('connect', resolve));
        client.write(`${JSON.stringify({ protocol: CLI_PROTOCOL, token: TOKEN, command: 'agent.wait', args: {}, cwd: '/' })}\n`);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(signals[0]?.aborted).toBe(false);
        client.destroy();
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(signals[0]?.aborted).toBe(true);
    });

    it('refuses a second server on the same socket', async () => {
        const socket = await start();
        await expect(new CliServer({ socketPath: socket, token: TOKEN, handler }).start()).rejects.toThrow('Another ShipWarden');
    });
});

describe('checkRequest', () => {
    const valid = { protocol: CLI_PROTOCOL, token: TOKEN, command: 'status', args: {}, cwd: '/w' };
    const code = (value: unknown) => (checkRequest(value, TOKEN) as Extract<CliResponse, { ok: false }>).error?.code;

    it('accepts a valid request', () => {
        expect(checkRequest(valid, TOKEN)).toEqual(valid);
    });
    it('checks the token before the other values', () => {
        expect(code({ ...valid, token: 'x', command: 'nothing' })).toBe('unauthorized');
    });
    it('refuses another protocol and an unknown command', () => {
        expect(code({ ...valid, protocol: 99 })).toBe('badRequest');
        expect(code({ ...valid, command: 'rm -rf' })).toBe('badRequest');
        expect(code([])).toBe('badRequest');
    });
});

describe('sameToken', () => {
    it('compares the tokens', () => {
        expect(sameToken('abc', 'abc')).toBe(true);
        expect(sameToken('abd', 'abc')).toBe(false);
        expect(sameToken('ab', 'abc')).toBe(false);
        expect(sameToken(undefined, 'abc')).toBe(false);
        expect(sameToken('', '')).toBe(false);
    });
});
