/**
 * Returns the page of the Review view. No repository: the entry page. A repository: its list of pull requests.
 * A repository and a number: the pull request. `repo` is the ID of the repository (see `repoId`).
 */
export function reviewPage(repo?: string, number?: number): string | undefined {
    if (!repo) return undefined;
    return number ? `${repo}#${number}` : repo;
}

/** Reads a page from `reviewPage`. */
export function parseReviewPage(page: string | undefined): { repo?: string; number?: number } {
    if (!page) return {};
    const hash = page.lastIndexOf('#');
    const number = hash < 0 ? Number.NaN : Number(page.slice(hash + 1));
    if (hash < 0 || !Number.isInteger(number) || number <= 0) return { repo: page };
    return { repo: page.slice(0, hash), number };
}

/** The start of the page of a PR group. A repository ID never starts with it, because it has no "/". */
const GROUP_PREFIX = 'group:';

/** Returns the page of a PR group in the Review view. */
export function groupPage(id: string): string {
    return `${GROUP_PREFIX}${id}`;
}

/** Returns the ID of the PR group of a page, or undefined when the page is not a group page. */
export function parseGroupPage(page: string | undefined): string | undefined {
    if (!page?.startsWith(GROUP_PREFIX)) return undefined;
    const id = page.slice(GROUP_PREFIX.length);
    return id && !id.includes('/') ? id : undefined;
}
