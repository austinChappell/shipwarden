import { useEffect } from 'react';
import { showToast } from '../components/Toast';

/** The link of a page that shows one item, for example a pull request or a task. */
export interface PageLink {
    url: string;
    /** The name of the item in the toast, for example "PR" or "task". */
    kind: string;
}

/** The links of the mounted pages. The last link is the link of the page that opened last. */
const links: PageLink[] = [];

/**
 * Gives the link of the item on the page to ⇧⌘C while the component is mounted. A view mounts only while it shows,
 * so the link is always the link of an item on the screen. Without a URL, the page gives no link.
 */
export function usePageLink(url: string | undefined, kind: string): void {
    useEffect(() => (url ? addPageLink({ url, kind }) : undefined), [url, kind]);
}

/** Adds the link of a page. Returns a function that removes the link. */
export function addPageLink(link: PageLink): () => void {
    links.push(link);
    return () => {
        const index = links.indexOf(link);
        if (index >= 0) links.splice(index, 1);
    };
}

/** Returns the link of the page that opened last, or undefined when no page gives a link. */
export function currentPageLink(): PageLink | undefined {
    return links.at(-1);
}

/** Copies a link to the clipboard. A toast then tells the user, for example "Copied the PR link". */
export async function copyPageLink(link: PageLink): Promise<void> {
    await navigator.clipboard.writeText(link.url);
    showToast(`Copied the ${link.kind} link`, link.url);
}
