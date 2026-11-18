import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchctlResult } from '../helper/launch-agent';
import { launchPtyHost, ptyHostLabel, ptyHostPlist } from './host-launch';

const options = {
    label: 'dev.shipwarden.pty-host.abc',
    execPath: '/Applications/ShipWarden.app/Contents/MacOS/ShipWarden',
    hostScript: '/Applications/ShipWarden.app/Contents/Resources/app.asar/out/main/pty-host.js',
    socketPath: '/Users/me/Library/Application Support/ShipWarden/pty-host-v1-0123.sock',
    buildId: '0123',
    logPath: '/Users/me/Library/Application Support/ShipWarden/pty-host.log'
};

describe('ptyHostLabel', () => {
    it('gives each socket its own label', () => {
        expect(ptyHostLabel('/a.sock')).toMatch(/^dev\.shipwarden\.pty-host\.[0-9a-f]{12}$/);
        expect(ptyHostLabel('/a.sock')).toBe(ptyHostLabel('/a.sock'));
        expect(ptyHostLabel('/a.sock')).not.toBe(ptyHostLabel('/b.sock'));
    });
});

describe('ptyHostPlist', () => {
    it('runs the host script with --detach and the Node runtime of Electron', () => {
        const plist = ptyHostPlist(options);
        expect(plist).toContain(
            `<string>${options.execPath}</string>\n        <string>${options.hostScript}</string>\n        <string>${options.socketPath}</string>\n        <string>0123</string>\n        <string>--detach</string>`
        );
        expect(plist).toContain('<key>ELECTRON_RUN_AS_NODE</key>\n        <string>1</string>');
    });

    it('runs one time and keeps the host when launchd stops the job', () => {
        const plist = ptyHostPlist(options);
        expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
        expect(plist).not.toContain('KeepAlive');
        expect(plist).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
        expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
        expect(plist).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/Library\/Application Support\/ShipWarden\/pty-host.log<\/string>/);
    });

    it('escapes XML characters in paths', () => {
        expect(ptyHostPlist({ ...options, socketPath: '/Users/a&b/<x>.sock' })).toContain('<string>/Users/a&amp;b/&lt;x&gt;.sock</string>');
    });
});

describe('launchPtyHost', () => {
    let folder: string | undefined;
    afterEach(() => {
        if (folder) rmSync(folder, { recursive: true, force: true });
        folder = undefined;
    });

    function setup(loaded: boolean, bootstrapCode = 0) {
        folder = mkdtempSync(join(tmpdir(), 'shipwarden-host-launch-'));
        const calls: string[][] = [];
        let isLoaded = loaded;
        const launchctl = async (args: string[]): Promise<LaunchctlResult> => {
            calls.push(args);
            if (args[0] === 'print') return { code: isLoaded ? 0 : 113, output: '' };
            if (args[0] === 'bootstrap') {
                if (bootstrapCode !== 0) return { code: bootstrapCode, output: 'Bootstrap failed: 5: Input/output error' };
                isLoaded = true;
            }
            if (args[0] === 'bootout') isLoaded = false;
            return { code: 0, output: '' };
        };
        const plistPath = join(folder, `${options.label}.plist`);
        return { calls, plistPath, launch: () => launchPtyHost({ ...options, plistPath, uid: 501, launchctl }) };
    }

    it('loads the job, and the cleanup unloads it and removes the plist', async () => {
        const { calls, plistPath, launch } = setup(false);
        const cleanup = await launch();
        expect(readFileSync(plistPath, 'utf8')).toBe(ptyHostPlist(options));
        expect(calls).toContainEqual(['bootstrap', 'gui/501', plistPath]);
        calls.length = 0;
        await cleanup();
        expect(calls).toContainEqual(['bootout', `gui/501/${options.label}`]);
        expect(existsSync(plistPath)).toBe(false);
    });

    it('loads a job that is still loaded again, so that it runs again', async () => {
        const { calls, launch } = setup(false);
        await launch();
        calls.length = 0;
        await launch();
        expect(calls.map(call => call[0])).toEqual(['print', 'bootout', 'bootstrap']);
    });

    it('throws an error when launchctl cannot load the job', async () => {
        const { launch } = setup(false, 5);
        await expect(launch()).rejects.toThrow('launchctl cannot load the terminal host: Bootstrap failed: 5: Input/output error');
    });
});
