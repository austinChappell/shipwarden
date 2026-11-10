import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileUrl } from '@shared/file-url';
import { createFileProtocolHandler } from './file-protocol';
import { isInside } from './file-service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

describe('isInside', () => {
    it('is true for the folder and its children', () => {
        expect(isInside('/repo', '/repo')).toBe(true);
        expect(isInside('/repo', '/repo/a/b.png')).toBe(true);
    });

    it('is false for other folders', () => {
        expect(isInside('/repo', '/repo2/a.png')).toBe(false);
        expect(isInside('/repo', '/etc/passwd')).toBe(false);
        expect(isInside('/repo/a', '/repo')).toBe(false);
    });
});

describe('file protocol handler', () => {
    let base: string;
    let root: string;
    let outside: string;
    const handler = () =>
        createFileProtocolHandler(async value => {
            if (value !== root) throw new Error('not known');
            return value;
        });
    const get = (url: string, headers: Record<string, string> = {}) => handler()(new Request(url, { headers }));

    beforeEach(async () => {
        base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-protocol-')));
        root = path.join(base, 'repo');
        outside = path.join(base, 'outside');
        await fs.mkdir(path.join(root, 'img'), { recursive: true });
        await fs.mkdir(outside);
        await fs.writeFile(path.join(root, 'img', 'a.png'), PNG);
        await fs.writeFile(path.join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        await fs.writeFile(path.join(root, 'noext'), PNG);
        await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
        await fs.writeFile(path.join(outside, 'b.png'), PNG);
        await fs.symlink(path.join(outside, 'b.png'), path.join(root, 'link.png'));
    });

    afterEach(async () => {
        await fs.rm(base, { recursive: true, force: true });
    });

    it('sends an image of a known worktree', async () => {
        const response = await get(fileUrl(root, 'img/a.png', 2));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('content-length')).toBe(String(PNG.length));
        expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    });

    it('sends a byte range', async () => {
        const response = await get(fileUrl(root, 'img/a.png'), { Range: 'bytes=2-5' });
        expect(response.status).toBe(206);
        expect(response.headers.get('content-range')).toBe(`bytes 2-5/${PNG.length}`);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...PNG.subarray(2, 6)]);
    });

    it('answers 416 for a range outside the file', async () => {
        const response = await get(fileUrl(root, 'img/a.png'), { Range: 'bytes=999-' });
        expect(response.status).toBe(416);
    });

    it('sends an SVG with a policy that stops scripts', async () => {
        const response = await get(fileUrl(root, 'logo.svg'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/svg+xml');
        expect(response.headers.get('content-security-policy')).toContain('sandbox');
    });

    it('finds the type of a file with no extension from its first bytes', async () => {
        const response = await get(fileUrl(root, 'noext'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
    });

    it('refuses a text file', async () => {
        expect((await get(fileUrl(root, '.env'))).status).toBe(403);
    });

    it('refuses a root that is not a known worktree', async () => {
        expect((await get(fileUrl(outside, 'b.png'))).status).toBe(403);
    });

    it('refuses a symbolic link to a file outside the worktree', async () => {
        expect((await get(fileUrl(root, 'link.png'))).status).toBe(403);
    });

    it('answers 404 for a missing file', async () => {
        expect((await get(fileUrl(root, 'img/missing.png'))).status).toBe(404);
    });

    it('refuses other methods', async () => {
        const response = await handler()(new Request(fileUrl(root, 'img/a.png'), { method: 'POST', body: 'x' }));
        expect(response.status).toBe(405);
    });
});
