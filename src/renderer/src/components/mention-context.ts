import { createContext } from 'react';
import type { PullRequest, PullRequestCommit, RepoRef, RepoTarget } from '@shared/github';
import { repoUrlOf } from '@shared/mentions';

/**
 * The repository of the comment boxes and the comments below a provider.
 * - A comment box shows a list of users after "@" and a list of issues and pull requests after "#".
 * - A comment links "@login" to the user, "#123" to the issue or the pull request, and a commit SHA to the commit.
 * Only GitHub repositories have a provider. Without it, a comment box is a plain text box.
 */
export interface MentionSource {
    target: RepoTarget;
    /** The web address of the repository, for example "https://github.com/acme/app". */
    repoUrl: string;
    /** The users of the pull request: the author, the reviewers, the assignees and the people who commented. They come first in the list. */
    people: string[];
    /** The commits that open in ShipWarden. Without it, each commit SHA in a comment is a link to GitHub. */
    commits?: CommitOpener;
}

/** Shows the diff of a commit of the pull request in ShipWarden. */
export interface CommitOpener {
    /** The commits of the pull request. A SHA that matches none of them stays a link to GitHub. */
    list: PullRequestCommit[];
    open(commit: PullRequestCommit): void;
}

export const MentionContext = createContext<MentionSource | undefined>(undefined);

/**
 * Returns the mention source of a pull request. Returns undefined for a pull request that is not on GitHub.
 * With `openCommit`, a click on the SHA of a commit of the pull request shows the commit in ShipWarden.
 */
export function mentionSourceOf(target: RepoTarget, pr: PullRequest, openCommit?: (commit: PullRequestCommit) => void): MentionSource | undefined {
    if (pr.host === 'azure' || pr.host === 'gitlab') return undefined;
    const repoUrl = repoUrlOf(pr.url);
    if (!repoUrl) return undefined;
    const logins = [
        pr.author?.login,
        ...pr.reviewRequests.filter(reviewer => reviewer.kind === 'user').map(reviewer => reviewer.login),
        ...pr.assignees.map(user => user.login),
        ...pr.reviews.map(review => review.author?.login),
        ...pr.issueComments.map(comment => comment.author?.login),
        ...pr.threads.flatMap(thread => thread.comments.map(comment => comment.author?.login))
    ];
    // Bots cannot get a notification, so the list leaves them out.
    const people = [...new Set(logins.filter((login): login is string => !!login && !login.endsWith('[bot]')))];
    return { target, repoUrl, people, commits: openCommit && { list: pr.commits, open: openCommit } };
}

/** Returns the mention source of a GitHub repository that has no pull request yet. */
export function mentionSourceOfRepo(target: RepoTarget, repo: RepoRef): MentionSource | undefined {
    if (repo.host === 'azure' || repo.host === 'gitlab') return undefined;
    return { target, repoUrl: `https://github.com/${repo.owner}/${repo.name}`, people: [] };
}
