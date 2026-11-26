// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { messagePreviewHtml } from './MessagePreview';

describe('messagePreviewHtml', () => {
    it('shows the variables as chips and the links as text with the target in the tooltip', () => {
        const html = messagePreviewHtml('This [PR]({{pr.url}}) is **ready**. It completes [{{task.key}}]({{task.url}}).');
        const root = document.createElement('div');
        root.innerHTML = html;
        expect(root.querySelector('a')).toBeNull();
        const links = [...root.querySelectorAll('.message-preview-link')];
        expect(links.map(link => link.getAttribute('title'))).toEqual(['{{pr.url}}', '{{task.url}}']);
        expect(links[0].textContent).toBe('PR');
        expect(links[1].querySelector('.message-preview-variable')?.textContent).toBe('task.key');
        expect(root.querySelector('strong')?.textContent).toBe('ready');
    });

    it('keeps the filter in the chip', () => {
        const root = document.createElement('div');
        root.innerHTML = messagePreviewHtml('Branch {{branch|url}}');
        expect(root.querySelector('.message-preview-variable')?.textContent).toBe('branch|url');
    });
});
