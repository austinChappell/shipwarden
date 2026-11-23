import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { majorVersionOf, OpencodeVersions } from './opencode-version';

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

/** Writes an executable file and returns its path. */
function program(name = 'opencode'): string {
    const folder = mkdtempSync(join(tmpdir(), 'opencode-version-'));
    folders.push(folder);
    const file = join(folder, name);
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    return file;
}

describe('majorVersionOf', () => {
    it('reads the major version', () => {
        expect(majorVersionOf('opencode v2.2.6')).toBe(2);
        expect(majorVersionOf('1.0.3\n')).toBe(1);
        expect(majorVersionOf('unknown')).toBeUndefined();
    });
});

describe('OpencodeVersions', () => {
    it('gives --standalone to opencode 2 and later only', async () => {
        const file = program();
        const v2 = new OpencodeVersions(Promise.resolve(), async () => 'opencode v2.2.6');
        expect(await v2.needsStandalone(`${file} --model x`)).toBe(true);
        const v1 = new OpencodeVersions(Promise.resolve(), async () => '1.4.0');
        expect(await v1.needsStandalone(file)).toBe(false);
        const broken = new OpencodeVersions(Promise.resolve(), async () => undefined);
        expect(await broken.needsStandalone(file)).toBe(false);
    });

    it('ignores other programs and a missing program', async () => {
        const version = vi.fn(async () => '2.0.0');
        const versions = new OpencodeVersions(Promise.resolve(), version);
        expect(await versions.needsStandalone('claude')).toBe(false);
        expect(await versions.needsStandalone(undefined)).toBe(false);
        expect(await versions.needsStandalone('/no/such/opencode')).toBe(false);
        expect(version).not.toHaveBeenCalled();
    });

    it('reads the version again after the program file changes', async () => {
        const file = program();
        const version = vi.fn(async () => '2.0.0');
        const versions = new OpencodeVersions(Promise.resolve(), version);
        await versions.needsStandalone(file);
        await versions.needsStandalone(file);
        expect(version).toHaveBeenCalledTimes(1);
        utimesSync(file, new Date(), new Date(Date.now() + 60_000));
        await versions.needsStandalone(file);
        expect(version).toHaveBeenCalledTimes(2);
    });
});
