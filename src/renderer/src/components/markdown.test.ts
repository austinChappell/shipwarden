// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { headingSlug, renderMarkdown, renderMarkdownFile } from './Markdown';

describe('renderMarkdown', () => {
    it('removes the backslash escapes of ClickUp Markdown', () => {
        const html = renderMarkdown('GET /api/search\\_by\\_email\n\n1\\. Require a role.');
        expect(html).toContain('search_by_email');
        expect(html).toContain('1. Require a role.');
        expect(html).not.toContain('\\');
    });

    it('removes active content', () => {
        const html = renderMarkdown('<img src=x onerror="alert(1)"><script>alert(2)</script>[link](javascript:alert(3))');
        expect(html).not.toMatch(/onerror|<script|javascript:/);
    });
});

describe('renderMarkdownFile', () => {
    it('gives the images new sources and removes the sources that the callback refuses', () => {
        const html = renderMarkdownFile('![a](img/a.png)\n\n![b](http://example.com/b.png)', source =>
            source.startsWith('http:') ? undefined : `shipwarden-file://root/2f/${source}`
        );
        expect(html).toContain('src="shipwarden-file://root/2f/img/a.png"');
        expect(html).not.toContain('http://example.com/b.png');
    });

    it('gives each heading a prefixed ID', () => {
        const html = renderMarkdownFile('# Getting Started!\n\n## Install\n\n## Install', source => source);
        expect(html).toContain('id="user-content-getting-started"');
        expect(html).toContain('id="user-content-install"');
        expect(html).toContain('id="user-content-install-1"');
    });

    it('does not make a line break from a single newline', () => {
        expect(renderMarkdownFile('one\ntwo', source => source)).not.toContain('<br');
    });

    it('removes active content', () => {
        const html = renderMarkdownFile('<svg><script>alert(1)</script></svg><img src="a.png" onerror="alert(2)">', source => source);
        expect(html).not.toMatch(/<script|onerror/);
    });
});

describe('headingSlug', () => {
    it('makes GitHub style anchors', () => {
        expect(headingSlug('Hello, World')).toBe('hello-world');
        expect(headingSlug('API v2.0 (beta)')).toBe('api-v20-beta');
    });
});
