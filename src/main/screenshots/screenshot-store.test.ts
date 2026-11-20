import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderKey, mergeCapture, parseScreenshotSet, screenshotFile, screenshotFolder, ScreenshotStore } from './screenshot-store';

const shot = (sha: string) => ({ branch: 'b', sha, capturedAt: 1 });

describe('screenshot paths', () => {
    it('puts each repository and branch in its own folder in the data folder', () => {
        const folder = screenshotFolder('/data', '/Users/me/code/web', 'feature/login');
        expect(folder).toMatch(/^\/data\/screenshots\/web-[0-9a-f]{8}\/feature-login-[0-9a-f]{8}$/);
    });

    it('gives two repositories with the same folder name different folders', () => {
        expect(screenshotFolder('/data', '/a/web', 'main')).not.toBe(screenshotFolder('/data', '/b/web', 'main'));
    });

    it('gives two branches with the same slug different folders', () => {
        expect(folderKey('feature/a')).not.toBe(folderKey('feature-a'));
        expect(folderKey('feature/a')).toMatch(/^feature-a-[0-9a-f]{8}$/);
    });

    it('names the image file by side and page', () => {
        expect(screenshotFile('/f', 'base', '/')).toMatch(/^\/f\/base-home-[0-9a-f]{8}\.png$/);
        expect(screenshotFile('/f', 'branch', '/a/b')).not.toBe(screenshotFile('/f', 'branch', '/a-b'));
    });

    it('keeps a path inside the data folder for a branch name with dots', () => {
        expect(screenshotFolder('/data', '/r', '../../etc')).toMatch(/^\/data\/screenshots\/r-[0-9a-f]{8}\/etc-[0-9a-f]{8}$/);
    });
});

describe('mergeCapture', () => {
    it('keeps the other side and follows the order of the settings', () => {
        const current = {
            viewportWidth: 1280,
            pages: [
                { path: '/', base: shot('a') },
                { path: '/old', base: shot('a') }
            ]
        };
        const next = mergeCapture(
            current,
            ['/new', '/'],
            1280,
            'branch',
            new Map([
                ['/', shot('b')],
                ['/new', shot('b')]
            ])
        );
        expect(next).toEqual({
            viewportWidth: 1280,
            pages: [
                { path: '/new', branch: shot('b') },
                { path: '/', branch: shot('b'), base: shot('a') }
            ]
        });
    });

    it('drops the other side when the width changed', () => {
        const current = { viewportWidth: 1280, pages: [{ path: '/', base: shot('a') }] };
        expect(mergeCapture(current, ['/'], 390, 'branch', new Map([['/', shot('b')]])).pages).toEqual([{ path: '/', branch: shot('b') }]);
    });
});

describe('parseScreenshotSet', () => {
    it('drops shots and pages with a wrong shape', () => {
        expect(parseScreenshotSet({ viewportWidth: 800, pages: [{ path: '/', base: { sha: 1 } }, null, { path: '/x', branch: shot('c') }] })).toEqual({
            viewportWidth: 800,
            pages: [{ path: '/' }, { path: '/x', branch: shot('c') }]
        });
        expect(parseScreenshotSet({ pages: [] })).toBeNull();
    });
});

describe('ScreenshotStore', () => {
    let folder: string | undefined;
    afterEach(async () => {
        if (folder) await rm(folder, { recursive: true, force: true });
    });

    it('writes, reads, and clears a set and its images', async () => {
        folder = await mkdtemp(join(tmpdir(), 'screenshots-'));
        const store = new ScreenshotStore(folder);
        expect(await store.read('/r', 'main')).toBeNull();
        await store.writeImage('/r', 'main', 'branch', '/', Buffer.from('png'));
        await store.write('/r', 'main', { viewportWidth: 1280, pages: [{ path: '/', branch: shot('a') }] });
        expect(await store.read('/r', 'main')).toEqual({ viewportWidth: 1280, pages: [{ path: '/', branch: shot('a') }] });
        expect((await store.readImage('/r', 'main', 'branch', '/'))?.toString()).toBe('png');
        expect(await store.readImage('/r', 'main', 'base', '/')).toBeUndefined();
        await store.clear('/r', 'main');
        expect(await store.read('/r', 'main')).toBeNull();
    });
});
