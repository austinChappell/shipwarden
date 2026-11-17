import { useContext, useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { azureImageUrl } from '@shared/azure-image-url';
import type { PullRequestCommit } from '@shared/github';
import { findCommit, splitReferences } from '@shared/mentions';
import { MentionContext } from './mention-context';
import { openLink } from '../links';
import { openPullRequestLink } from '../pull-request-links';

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
    return sanitizeHtml(taskListMarks(marked.parse(text, { gfm: true, breaks: options.breaks ?? true, async: false })));
}

/**
 * Changes the check boxes of a task list ("- [x] item") to marks. The sanitizer removes all input elements,
 * so the marks are spans. The pattern matches only the check boxes that marked writes.
 */
export function taskListMarks(html: string): string {
    return html.replace(
        /<input (checked="" )?disabled="" type="checkbox">/g,
        (_, checked) => `<span class="md-check${checked ? ' on' : ''}" role="img" aria-label="${checked ? 'Done' : 'Not done'}"></span>`
    );
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

/**
 * Changes each "@login" to a link to the GitHub user, each "#123" to a link to the issue or the pull request in the repository,
 * and each commit SHA such as "7195c5df5" to a link to the commit in the repository.
 * When a SHA matches exactly one of `commits`, the link gets the full SHA in "data-commit", so a click can show the commit in ShipWarden.
 * The text in links and in code does not change. The function changes the HTML after DOMPurify and adds only links with safe addresses.
 */
export function linkReferences(html: string, repoUrl: string, commits: readonly PullRequestCommit[] = []): string {
    if (!/[@#]|[0-9a-f]{7}/i.test(html)) return html;
    const template = document.createElement('template');
    // The content of a template is inert. The images do not load and no code runs here.
    template.innerHTML = html;
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest('a, code, pre')) nodes.push(node as Text);
    }
    for (const node of nodes) {
        const parts = splitReferences(node.data);
        if (parts.length === 1 && parts[0].kind === 'text') continue;
        const fragment = document.createDocumentFragment();
        for (const part of parts) {
            if (part.kind === 'text') {
                fragment.append(part.text);
                continue;
            }
            const link = document.createElement('a');
            link.className = part.kind === 'commit' ? 'commit-link' : 'mention-link';
            link.href =
                part.kind === 'user'
                    ? `https://github.com/${part.login}`
                    : part.kind === 'issue'
                      ? `${repoUrl}/issues/${part.number}`
                      : `${repoUrl}/commit/${part.sha}`;
            link.textContent = part.text;
            const commit = part.kind === 'commit' ? findCommit(commits, part.sha) : undefined;
            if (commit) {
                link.dataset.commit = commit.oid;
                link.title = 'Show the changes of this commit. ⌘-click opens it on GitHub.';
            }
            fragment.append(link);
        }
        node.replaceWith(fragment);
    }
    return template.innerHTML;
}

/** Removes scripts, event handlers, styles and forms from HTML. */
export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });
}

/**
 * Shows Markdown from a task tracker or GitHub. Links open in the default browser, and with ⇧⌘-click in the in-app browser.
 * In the Review view, a click on the SHA of a commit of the pull request shows the commit in ShipWarden.
 * A click on a link to a pull request opens the pull request in the Review view. ⌘-click opens it on GitHub.
 */
export function Markdown({ text, className, html: rendered }: Props) {
    // In a GitHub pull request, "@login", "#123", and commit SHAs in the text become links. HTML that GitHub rendered has its own links.
    const source = useContext(MentionContext);
    const repoUrl = source?.repoUrl;
    const commits = source?.commits;
    const html = useMemo(() => {
        if (rendered !== undefined) return withAzureImages(sanitizeHtml(rendered));
        const html = renderMarkdown(text);
        return withAzureImages(repoUrl ? linkReferences(html, repoUrl, commits?.list) : html);
    }, [text, rendered, repoUrl, commits?.list]);

    const onClick = (event: MouseEvent<HTMLDivElement>) => {
        const link = (event.target as HTMLElement).closest('a');
        if (!link) {
            return;
        }
        event.preventDefault();
        // A plain click shows a commit of the pull request in ShipWarden. ⌘-click and ⇧⌘-click open GitHub.
        const commit = link.dataset.commit ? commits?.list.find(item => item.oid === link.dataset.commit) : undefined;
        if (commits && commit && !event.metaKey && !event.ctrlKey) {
            commits.open(commit);
            return;
        }
        const href = link.getAttribute('href') ?? '';
        // A plain click on a link to a pull request opens the pull request in ShipWarden.
        if (openPullRequestLink(href, event)) return;
        if (/^https?:\/\//.test(href)) {
            openLink(href, event);
        }
    };

    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown and sanitizeHtml clean the HTML with DOMPurify.
    return <div className={`markdown${className ? ` ${className}` : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
