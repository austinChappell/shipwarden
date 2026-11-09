import { describe, expect, it } from 'vitest';
import { fileUrl, parseFileUrl, parseRange, resolveRelativeLink } from './file-url';

describe('fileUrl and parseFileUrl', () => {
    it('keep the root and the path', () => {
        const root = '/Users/Ann/My Repo';
        const url = fileUrl(root, 'docs/images/Logo #1.png');
        expect(url.startsWith('shipwarden-file://root/')).toBe(true);
        expect(parseFileUrl(url)).toEqual({ root, path: 'docs/images/Logo #1.png' });
    });

    it('keep a root with non-ASCII characters', () => {
        const url = fileUrl('/tmp/ünïcode', 'ä.png');
        expect(parseFileUrl(url)).toEqual({ root: '/tmp/ünïcode', path: 'ä.png' });
    });

    it('add the version as a query that the parser ignores', () => {
        const url = fileUrl('/repo', 'a.png', 3);
        expect(url.endsWith('?v=3')).toBe(true);
        expect(parseFileUrl(url)).toEqual({ root: '/repo', path: 'a.png' });
    });

    it('refuse other schemes, hosts and bad roots', () => {
        expect(parseFileUrl('file:///etc/passwd')).toBeUndefined();
        expect(parseFileUrl('shipwarden-file://other/2f/a.png')).toBeUndefined();
        expect(parseFileUrl('shipwarden-file://root/zz/a.png')).toBeUndefined();
        expect(parseFileUrl('shipwarden-file://root/2f')).toBeUndefined();
        expect(parseFileUrl('not a url')).toBeUndefined();
    });

    it('refuse encoded separators and parent folders', () => {
        const base = fileUrl('/repo', 'x').replace(/\/x$/, '');
        expect(parseFileUrl(`${base}/a%2F..%2F..%2Fetc%2Fpasswd`)).toBeUndefined();
        expect(parseFileUrl(`${base}/%2E%2E/secret`)).toBeUndefined();
        expect(parseFileUrl(`${base}/a%5Cb`)).toBeUndefined();
        expect(parseFileUrl(`${base}/a%00b`)).toBeUndefined();
    });

    it('get no path above the root from plain ".." segments', () => {
        // The URL parser removes ".." segments. The hex root is then gone, so the URL is not valid.
        const base = fileUrl('/repo', 'x').replace(/\/x$/, '');
        expect(parseFileUrl(`${base}/../../etc/passwd`)).toBeUndefined();
    });
});

describe('resolveRelativeLink', () => {
    it('resolves against the folder of the Markdown file', () => {
        expect(resolveRelativeLink('docs/guide/README.md', 'images/a.png')).toBe('docs/guide/images/a.png');
        expect(resolveRelativeLink('docs/guide/README.md', './a.png')).toBe('docs/guide/a.png');
        expect(resolveRelativeLink('docs/guide/README.md', '../logo.svg')).toBe('docs/logo.svg');
        expect(resolveRelativeLink('README.md', 'docs/a.png')).toBe('docs/a.png');
    });

    it('resolves a link that starts with "/" against the root', () => {
        expect(resolveRelativeLink('docs/README.md', '/assets/a.png')).toBe('assets/a.png');
    });

    it('removes the query and the anchor and decodes the path', () => {
        expect(resolveRelativeLink('README.md', 'my%20file.md#usage')).toBe('my file.md');
        expect(resolveRelativeLink('README.md', 'a.png?raw=true')).toBe('a.png');
    });

    it('returns undefined for links outside the root', () => {
        expect(resolveRelativeLink('README.md', '../secret.png')).toBeUndefined();
        expect(resolveRelativeLink('docs/README.md', '../../x.png')).toBeUndefined();
    });

    it('returns undefined for absolute URLs and anchors', () => {
        expect(resolveRelativeLink('README.md', 'https://example.com/a.png')).toBeUndefined();
        expect(resolveRelativeLink('README.md', '//example.com/a.png')).toBeUndefined();
        expect(resolveRelativeLink('README.md', 'data:image/png;base64,AAAA')).toBeUndefined();
        expect(resolveRelativeLink('README.md', 'file:///etc/passwd')).toBeUndefined();
        expect(resolveRelativeLink('README.md', 'javascript:alert(1)')).toBeUndefined();
        expect(resolveRelativeLink('README.md', '#install')).toBeUndefined();
        expect(resolveRelativeLink('README.md', '')).toBeUndefined();
    });
});

describe('parseRange', () => {
    it('returns undefined with no header or with more than one range', () => {
        expect(parseRange(null, 100)).toBeUndefined();
        expect(parseRange('bytes=0-1,5-6', 100)).toBeUndefined();
    });

    it('reads a start and an end', () => {
        expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
        expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    });

    it('reads a suffix range', () => {
        expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    });

    it('returns invalid for a range outside the file', () => {
        expect(parseRange('bytes=100-', 100)).toBe('invalid');
        expect(parseRange('bytes=5-2', 100)).toBe('invalid');
        expect(parseRange('bytes=-', 100)).toBe('invalid');
        expect(parseRange('bytes=-0', 100)).toBe('invalid');
        expect(parseRange('items=0-1', 100)).toBe('invalid');
    });
});
