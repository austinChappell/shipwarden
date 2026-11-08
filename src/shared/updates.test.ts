import { describe, expect, it } from 'vitest';
import { compareVersions, parseManifest, parseVersion, releaseNotes } from './updates';

describe('versions', () => {
    it('parses versions with or without "v"', () => {
        expect(parseVersion('v1.2.3')).toEqual({ parts: [1, 2, 3], pre: '' });
        expect(parseVersion('0.10.0-beta.1')).toEqual({ parts: [0, 10, 0], pre: 'beta.1' });
        expect(parseVersion('1.2')).toBeUndefined();
    });

    it('compares versions by number, and a pre-release before its release', () => {
        expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
        expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
        expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
        expect(compareVersions('nonsense', '0.0.1')).toBeLessThan(0);
    });
});

describe('parseManifest', () => {
    const valid = { version: '0.2.0', zip: { name: 'ShipWarden-0.2.0-arm64-mac.zip', sha256: 'a'.repeat(64), size: 1000 } };

    it('accepts a valid manifest', () => {
        expect(parseManifest(valid)).toEqual(valid);
    });

    it('refuses a bad checksum, a path in the name, or a bad version', () => {
        expect(parseManifest({ ...valid, zip: { ...valid.zip, sha256: 'xyz' } })).toBeUndefined();
        expect(parseManifest({ ...valid, zip: { ...valid.zip, name: '../evil.zip' } })).toBeUndefined();
        expect(parseManifest({ ...valid, version: 'latest' })).toBeUndefined();
        expect(parseManifest(null)).toBeUndefined();
    });
});

describe('releaseNotes', () => {
    it('lists the commits without release and merge commits', () => {
        const notes = releaseNotes('0.2.0', [
            { hash: 'abcdef1234', subject: 'Add the updater' },
            { hash: '1111111111', subject: 'Release v0.1.1' },
            { hash: '2222222222', subject: 'Merge branch main' }
        ], 'v0.1.1');
        expect(notes).toBe('## ShipWarden 0.2.0\n\n- Add the updater (abcdef1)\n\nChanges since v0.1.1.\n');
    });

    it('says so when there are no changes', () => {
        expect(releaseNotes('0.2.0', [])).toContain('- No changes in the code.');
    });
});
