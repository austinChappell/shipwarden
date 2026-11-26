import { useMemo } from 'react';
import { replaceVariables } from '@shared/automation-templates';
import { renderMarkdown } from '../components/Markdown';

/** The marks around the name of a variable while marked converts the Markdown. Markdown gives these characters no meaning. */
const START = '';
const END = '';
const MARKED_VARIABLE = /([^]*)/g;

/**
 * Converts a message template to HTML for the preview. A variable shows as a chip with its name. A link shows as
 * link text, and its tooltip shows the target. A click on it does nothing, because a target can contain a variable.
 */
export function messagePreviewHtml(message: string): string {
    const marked = replaceVariables(message, (name, filter) => `${START}${filter ? `${name}|${filter}` : name}${END}`);
    const template = document.createElement('template');
    template.innerHTML = renderMarkdown(marked);
    const root = template.content;

    for (const link of [...root.querySelectorAll('a')]) {
        const span = document.createElement('span');
        span.className = 'message-preview-link';
        span.title = safeDecode(link.getAttribute('href') ?? '').replace(MARKED_VARIABLE, '{{$1}}');
        span.append(...link.childNodes);
        link.replaceWith(span);
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeValue?.includes(START)) texts.push(node as Text);
    }
    for (const text of texts) {
        const value = text.nodeValue ?? '';
        const fragment = document.createDocumentFragment();
        let at = 0;
        for (const match of value.matchAll(MARKED_VARIABLE)) {
            fragment.append(value.slice(at, match.index));
            const chip = document.createElement('span');
            chip.className = 'message-preview-variable';
            chip.textContent = match[1];
            fragment.append(chip);
            at = (match.index ?? 0) + match[0].length;
        }
        fragment.append(value.slice(at));
        text.replaceWith(fragment);
    }
    return template.innerHTML;
}

/** Decodes a URL for a tooltip. A URL with a broken "%" sequence stays the same. */
function safeDecode(url: string): string {
    try {
        return decodeURI(url);
    } catch {
        return url;
    }
}

/** The preview of a message in Markdown. The variables show as chips, because their values exist only in a run. */
export function MessagePreview({ message }: { message: string }) {
    const html = useMemo(() => messagePreviewHtml(message), [message]);
    if (!message.trim()) return <div className="message-preview empty">Nothing to preview.</div>;
    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown sanitizes the HTML with DOMPurify, and the preview has no links.
    return <div className="message-preview markdown task-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
