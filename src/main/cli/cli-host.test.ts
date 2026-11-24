import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_PROTOCOL } from '@shared/cli';
import { readConfig, sendRequest } from '../../cli/client';
import { CliHost } from './cli-host';
import { cliConfigPath, cliSocketPath } from './paths';

let folder: string;
let host: CliHost | undefined;

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'sw-host-'));
});

afterEach(() => {
    host?.stop();
    rmSync(folder, { recursive: true, force: true });
});

describe('CliHost', () => {
    it('writes a private config file that the CLI uses, and removes it at the stop', async () => {
        const configPath = join(folder, 'home', '.shipwarden', 'cli.json');
        host = new CliHost({
            socketPath: join(folder, 'cli.sock'),
            configPath,
            version: '1.0.0',
            pid: 7,
            handler: { handle: async request => ({ message: request.command }) }
        });
        await host.start();
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        const config = await readConfig(configPath);
        expect(config).toMatchObject({ protocol: CLI_PROTOCOL, socket: join(folder, 'cli.sock'), pid: 7, version: '1.0.0' });
        expect(config.token).toMatch(/^[0-9a-f]{64}$/);
        expect(await sendRequest(config, 'status', {}, '/')).toEqual({ ok: true, result: { message: 'status' } });

        host.stop();
        expect(existsSync(configPath)).toBe(false);
    });
});

describe('paths', () => {
    it('puts the config in ~/.shipwarden, in a separate data folder, or at the path of the env variable', () => {
        expect(cliConfigPath('/Users/me', {})).toBe('/Users/me/.shipwarden/cli.json');
        expect(cliConfigPath('/Users/me', {}, '/tmp/sw-fresh')).toBe('/tmp/sw-fresh/cli.json');
        expect(cliConfigPath('/Users/me', { SHIPWARDEN_CLI_CONFIG: '/x/cli.json' }, '/tmp/sw-fresh')).toBe('/x/cli.json');
    });
    it('keeps the socket path short', () => {
        expect(cliSocketPath('/Users/me/Library/Application Support/ShipWarden')).toBe('/Users/me/Library/Application Support/ShipWarden/cli-v1.sock');
        const long = cliSocketPath(`/Users/me/${'x'.repeat(120)}`);
        expect(Buffer.byteLength(long)).toBeLessThanOrEqual(100);
        expect(long).toMatch(/sw-[0-9a-f]{8}\/cli-v1\.sock$/);
    });
});
