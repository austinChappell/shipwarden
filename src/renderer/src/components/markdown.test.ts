// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { headingSlug, isVideoUrl, linkReferences, renderMarkdown, renderMarkdownFile, withMedia } from './Markdown';

describe('renderMarkdown', () => {
    it('shows the check boxes of a task list as marks', () => {
        const html = renderMarkdown('- [x] Done\n- [ ] Open\n\n<input type="checkbox" checked>');
        expect(html).toContain('<span class="md-check on" role="img" aria-label="Done"></span> Done');
        expect(html).toContain('<span class="md-check" role="img" aria-label="Not done"></span> Open');
        expect(html).not.toContain('<input');
    });

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

describe('linkReferences', () => {
    const repo = 'https://github.com/acme/app';

    it('links users and issues', () => {
        const html = linkReferences(renderMarkdown('cc @octocat about #12'), repo);
        expect(html).toContain('<a class="mention-link" href="https://github.com/octocat">@octocat</a>');
        expect(html).toContain('<a class="mention-link" href="https://github.com/acme/app/issues/12">#12</a>');
    });

    it('does not change code, links and email addresses', () => {
        const html = linkReferences(renderMarkdown('`@octocat` [#12](https://example.com) a@b.com\n\n```\n#3\n```'), repo);
        expect(html).not.toContain('mention-link');
    });

    it('links commits to GitHub, and marks the commits of the pull request', () => {
        const commit = { oid: '7195c5df5a0b', abbreviatedOid: '7195c5d', messageHeadline: 'x', committedDate: '', url: '', author: null };
        const html = linkReferences(renderMarkdown('Done in 7195c5df5 and abc1234'), repo, [commit]);
        expect(html).toContain(
            '<a class="commit-link" href="https://github.com/acme/app/commit/7195c5df5" data-commit="7195c5df5a0b" title="Show the changes of this commit. ⌘-click opens it on GitHub.">7195c5df5</a>'
        );
        expect(html).toContain('<a class="commit-link" href="https://github.com/acme/app/commit/abc1234">abc1234</a>');
    });
});

describe('withMedia', () => {
    const video = 'https://private-user-images.githubusercontent.com/1/2-abc.mp4?jwt=token';

    it('makes a video player from a video link alone in its paragraph', () => {
        const html = withMedia(renderMarkdown(`Before\n\n${video}\n\nAfter`));
        expect(html).toContain('<span class="md-video"><video src="https://private-user-images.githubusercontent.com/1/2-abc.mp4?jwt=token"');
        expect(html).toContain('class="md-zoom"');
        expect(html).toContain('<p>After</p>');
    });

    it('keeps a video link in a sentence as a link', () => {
        const html = withMedia(renderMarkdown(`See ${video} for the bug.`));
        expect(html).not.toContain('<video');
    });

    it('gives a video of GitHub HTML the button', () => {
        expect(withMedia(`<video src="${video}" controls></video>`)).toContain('class="md-zoom"');
        expect(withMedia('<video src="http://example.com/a.mp4"></video>')).not.toContain('md-zoom');
    });

    it('marks the images that a click shows larger', () => {
        const html = withMedia(
            renderMarkdown(
                '![shot](https://example.com/a.png) [![CI](https://example.com/badge.svg)](https://ci.example.com) <img class="emoji" src="https://example.com/e.png">'
            )
        );
        expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/a\.png"[^>]*class="md-zoomable"/);
        expect(html).toMatch(/<img[^>]*badge\.svg"(?![^>]*md-zoomable)[^>]*>/);
        expect(html).toMatch(/<img class="emoji"(?![^>]*md-zoomable)[^>]*>/);
    });

    it('marks an image in a link to the same image', () => {
        const src = 'https://private-user-images.githubusercontent.com/1/2-abc.png?jwt=token';
        expect(withMedia(`<a href="https://github.com/user-attachments/assets/x"><img src="${src}"></a>`)).toContain('md-zoomable');
    });
});

describe('isVideoUrl', () => {
    it('reads the extension of the path, not of the query', () => {
        expect(isVideoUrl('https://example.com/a.MOV?x=1')).toBe(true);
        expect(isVideoUrl('https://example.com/a?file=a.mp4')).toBe(false);
        expect(isVideoUrl('http://example.com/a.mp4')).toBe(false);
        expect(isVideoUrl('not a url')).toBe(false);
    });
});
