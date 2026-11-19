import type { ClickModifiers } from '@shared/browser';
import { parseIssueUrl, parsePullRequestUrl, repoId, type PullRequestLinkTab, type RepoRef } from '@shared/github';
import { openLink } from './links';
import { keyRoots, queryClient } from './query-client';

/** Opens a pull request in the Review view. App sets it while a review provider is on. */
type PullRequestOpener = (repo: RepoRef, number: number, tab: PullRequestLinkTab) => void;

let pullRequestOpener: PullRequestOpener | undefined;

/** Sets the function that opens a pull request in the Review view. Returns a function that removes it. */
export function setPullRequestOpener(opener: PullRequestOpener): () => void {
    pullRequestOpener = opener;
    return () => {
        if (pullRequestOpener === opener) pullRequestOpener = undefined;
    };
}

/**
 * Opens a link to a pull request in the Review view of ShipWarden. Returns false when the link is not for ShipWarden.
 * - ⌘-click and ⇧⌘-click are for the browser. The function returns false for them.
 * - A pull request address opens the pull request.
 * - A GitHub issue address (the address of a "#123" reference) can also be a pull request. The function asks GitHub
 *   for the kind of the item. A pull request opens in ShipWarden. An issue, or a failed request, opens in the default browser.
 * Without a review provider, all links are for the browser.
 */
export function openPullRequestLink(url: string, click: ClickModifiers): boolean {
    const opener = pullRequestOpener;
    if (!opener || click.metaKey || click.ctrlKey) return false;
    const pr = parsePullRequestUrl(url);
    if (pr) {
        opener(pr.repo, pr.number, pr.tab);
        return true;
    }
    const issue = parseIssueUrl(url);
    if (!issue) return false;
    queryClient
        .fetchQuery({
            queryKey: [...keyRoots.issueReference, repoId(issue.repo), issue.number],
            queryFn: () => window.shipwarden.github.issueReference(issue.repo, issue.number),
            // An issue never becomes a pull request, and a pull request never becomes an issue.
            staleTime: Number.POSITIVE_INFINITY
        })
        .catch(() => null)
        .then(item => {
            if (item?.kind === 'pullRequest') opener(issue.repo, issue.number, 'overview');
            else openLink(url);
        });
    return true;
}

/**
 * Opens a pull request address in the Review view of ShipWarden, on the given tab. Without a review provider, or for
 * an address that is not a pull request, the address opens in the default browser.
 */
export function openPullRequestUrl(url: string, tab?: PullRequestLinkTab): void {
    const pr = parsePullRequestUrl(url);
    if (pullRequestOpener && pr) pullRequestOpener(pr.repo, pr.number, tab ?? pr.tab);
    else openLink(url);
}
