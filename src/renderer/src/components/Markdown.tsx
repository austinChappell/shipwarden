import { useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { openLink } from '../links';

interface Props {
    text: string;
    className?: string;
    /** HTML that GitHub rendered. When it is set, the component shows it (sanitized) instead of `text`. */
    html?: string;
}

/**
 * Converts Markdown to safe HTML. Task trackers and pull requests supply this text,
 * so DOMPurify removes scripts, event handlers and other active content.
 */
export function renderMarkdown(text: string): string {
    return sanitizeHtml(marked.parse(text, { gfm: true, breaks: true, async: false }));
}

/** Removes scripts, event handlers, styles and forms from HTML. */
export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });
}

/** Shows Markdown from a task tracker or GitHub. Links open in the default browser, and with ⇧⌘-click in the in-app browser. */
export function Markdown({ text, className, html: rendered }: Props) {
    const html = useMemo(() => (rendered !== undefined ? sanitizeHtml(rendered) : renderMarkdown(text)), [text, rendered]);

    const onClick = (event: MouseEvent<HTMLDivElement>) => {
        const link = (event.target as HTMLElement).closest('a');
        if (!link) {
            return;
        }
        event.preventDefault();
        const href = link.getAttribute('href') ?? '';
        if (/^https?:\/\//.test(href)) {
            openLink(href, event);
        }
    };

    return <div className={`markdown${className ? ` ${className}` : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
