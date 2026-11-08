// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './Markdown';

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
