import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliInstaller, linkFolders } from './cli-install';

let root: string;
let system: string;
let local: string;
const launcher = '/Applications/ShipWarden.app/Contents/Resources/bin/shipwarden';

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sw-install-'));
    system = join(root, 'usr-local-bin');
    local = join(root, 'home', '.local', 'bin');
    mkdirSync(system);
});

afterEach(() => {
    chmodSync(system, 0o755);
    rmSync(root, { recursive: true, force: true });
});

const installer = (path = '') => new CliInstaller({ launcher, home: join(root, 'home'), path: async () => path, folders: [system, local] });

describe('CliInstaller', () => {
    it('adds the link in the first writable folder', async () => {
        const state = await installer(`/bin:${system}`).install();
        expect(state).toEqual({ installed: join(system, 'shipwarden'), launcher, inPath: true });
        expect(readlinkSync(join(system, 'shipwarden'))).toBe(launcher);
    });

    it('uses the folder in the home folder when the first folder is not writable', async () => {
        chmodSync(system, 0o555);
        const state = await installer('/bin').install();
        expect(state).toEqual({ installed: join(local, 'shipwarden'), launcher, inPath: false });
    });

    it('replaces a link of an older app location, and keeps another file', async () => {
        symlinkSync('/Volumes/Old/ShipWarden.app/Contents/Resources/bin/shipwarden', join(system, 'shipwarden'));
        await installer().install();
        expect(readlinkSync(join(system, 'shipwarden'))).toBe(launcher);

        rmSync(join(system, 'shipwarden'));
        writeFileSync(join(system, 'shipwarden'), '#!/bin/sh\n');
        const state = await installer().install();
        expect(state.installed).toBe(join(local, 'shipwarden'));
    });

    it('removes only the links to this launcher', async () => {
        await installer().install();
        mkdirSync(local, { recursive: true });
        symlinkSync('/other/shipwarden', join(local, 'shipwarden'));
        const state = await installer().remove();
        expect(state.installed).toBeUndefined();
        expect(readlinkSync(join(local, 'shipwarden'))).toBe('/other/shipwarden');
    });

    it('tells when no link exists', async () => {
        expect(await installer().state()).toEqual({ launcher, inPath: false });
    });
});

describe('linkFolders', () => {
    it('gives /usr/local/bin first, then ~/.local/bin', () => {
        expect(linkFolders('/Users/me')).toEqual(['/usr/local/bin', '/Users/me/.local/bin']);
    });
});
