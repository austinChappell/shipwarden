import { useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { azureImageUrl } from '@shared/azure-image-url';
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
export function renderMarkdown(text: string, options: { breaks?: boolean } = {}): string {
    return sanitizeHtml(marked.parse(text, { gfm: true, breaks: options.breaks ?? true, async: false }));
}

/** The prefix of the heading IDs in a Markdown file preview. */
export const HEADING_ID_PREFIX = 'user-content-';

/** Makes an anchor name from a heading, like GitHub: lower case, no punctuation, spaces become "-". */
export function headingSlug(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
}

/**
 * Converts a Markdown file to safe HTML for the preview.
 * - The line breaks follow GitHub for files: a single newline does not make a new line.
 * - Each heading gets an ID with the prefix "user-content-", so links such as "#install" can go to the heading.
 *   The prefix stops an ID from replacing a global name of the page (DOM clobbering), as on GitHub.
 * - `imageUrl` gets the `src` of each image. It returns the new URL, or undefined to remove the image source.
 * The function changes the HTML after DOMPurify, so the URLs of the custom protocol stay.
 */
export function renderMarkdownFile(text: string, imageUrl: (src: string) => string | undefined): string {
    const template = document.createElement('template');
    // The content of a template is inert. The images do not load and no code runs here.
    template.innerHTML = renderMarkdown(text, { breaks: false });
    const used = new Map<string, number>();
    template.content.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
        const slug = headingSlug(heading.textContent ?? '');
        if (!slug) return;
        const count = used.get(slug) ?? 0;
        used.set(slug, count + 1);
        heading.id = `${HEADING_ID_PREFIX}${count === 0 ? slug : `${slug}-${count}`}`;
    });
    replaceImageSources(template, imageUrl);
    return template.innerHTML;
}

/** Sets the `src` of each image to the result of `imageUrl`. When `imageUrl` returns undefined, the image has no source. */
function replaceImageSources(template: HTMLTemplateElement, imageUrl: (src: string) => string | undefined): void {
    template.content.querySelectorAll('img').forEach(image => {
        const source = image.getAttribute('src');
        if (source === null) return;
        const url = imageUrl(source);
        if (url === undefined) {
            image.removeAttribute('src');
        } else if (url !== source) {
            image.setAttribute('src', url);
        }
    });
}

/**
 * Sends the images of Azure DevOps through the `shipwarden-azure-image:` protocol. Azure DevOps requires a token for these images,
 * and the main process adds the token. The function changes the HTML after DOMPurify, so the URLs of the custom protocol stay.
 */
export function withAzureImages(html: string): string {
    if (!/dev\.azure\.com|visualstudio\.com/i.test(html)) return html;
    const template = document.createElement('template');
    // The content of a template is inert. The images do not load and no code runs here.
    template.innerHTML = html;
    replaceImageSources(template, source => azureImageUrl(source) ?? source);
    return template.innerHTML;
}

/** Removes scripts, event handlers, styles and forms from HTML. */
export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });
}

/** Shows Markdown from a task tracker or GitHub. Links open in the default browser, and with ⇧⌘-click in the in-app browser. */
export function Markdown({ text, className, html: rendered }: Props) {
    const html = useMemo(() => withAzureImages(rendered !== undefined ? sanitizeHtml(rendered) : renderMarkdown(text)), [text, rendered]);

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

    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown and sanitizeHtml clean the HTML with DOMPurify.
    return <div className={`markdown${className ? ` ${className}` : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
