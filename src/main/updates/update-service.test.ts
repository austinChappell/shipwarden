import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { bundlePathOf, INSTALLER_SCRIPT } from './update-service';

describe('bundlePathOf', () => {
    it('finds the app bundle of a packaged app', () => {
        expect(bundlePathOf('/Applications/ShipWarden.app/Contents/MacOS/ShipWarden', true)).toBe('/Applications/ShipWarden.app');
    });

    it('never returns the Electron app of development', () => {
        const dev = '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
        expect(bundlePathOf(dev, false)).toBeUndefined();
        expect(bundlePathOf(dev, true)).toBeUndefined();
        expect(bundlePathOf('/Applications/ShipWarden.app/Contents/MacOS/ShipWarden', false)).toBeUndefined();
    });
});

describe('INSTALLER_SCRIPT', () => {
    const setup = () => {
        const root = mkdtempSync(join(tmpdir(), 'shipwarden-installer-'));
        const bin = join(root, 'bin');
        mkdirSync(bin);
        // A fake "open" that only writes down its argument.
        writeFileSync(join(bin, 'open'), `#!/bin/sh\necho "$1" > "${join(root, 'opened')}"\n`);
        chmodSync(join(bin, 'open'), 0o755);
        mkdirSync(join(root, 'Applications', 'ShipWarden.app'), { recursive: true });
        writeFileSync(join(root, 'Applications', 'ShipWarden.app', 'version'), 'old');
        const staging = join(root, 'Applications', '.ShipWarden-update');
        mkdirSync(join(staging, 'ShipWarden.app'), { recursive: true });
        writeFileSync(join(staging, 'ShipWarden.app', 'version'), 'new');
        return { root, bin, app: join(root, 'Applications', 'ShipWarden.app'), staging };
    };

    const runScript = (env: Record<string, string>) =>
        new Promise<void>((resolve, reject) => {
            // The app process: it ends after a short time, as the app does when it quits.
            const app = spawn('/bin/sleep', ['0.5']);
            const child = spawn('/bin/sh', ['-c', INSTALLER_SCRIPT], { env: { ...env, PID: String(app.pid) } });
            child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        });

    it('waits for the app, replaces the bundle and opens the new app', async () => {
        const { root, bin, app, staging } = setup();
        try {
            await runScript({ PATH: `${bin}:/usr/bin:/bin`, APP: app, NEW: join(staging, 'ShipWarden.app'), STAGING: staging });
            expect(readFileSync(join(app, 'version'), 'utf8')).toBe('new');
            expect(existsSync(`${app}.old`)).toBe(false);
            expect(existsSync(staging)).toBe(false);
            expect(readFileSync(join(root, 'opened'), 'utf8').trim()).toBe(app);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('puts the old app back when the new bundle is missing', async () => {
        const { root, bin, app, staging } = setup();
        try {
            await runScript({ PATH: `${bin}:/usr/bin:/bin`, APP: app, NEW: join(staging, 'Missing.app'), STAGING: staging });
            expect(readFileSync(join(app, 'version'), 'utf8')).toBe('old');
            expect(existsSync(`${app}.old`)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
