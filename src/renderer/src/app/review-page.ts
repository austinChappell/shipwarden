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
