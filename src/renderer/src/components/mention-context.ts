import { createContext } from 'react';
import type { PullRequest, RepoRef, RepoTarget } from '@shared/github';
import { repoUrlOf } from '@shared/mentions';

/**
 * The repository of the comment boxes and the comments below a provider.
 * - A comment box shows a list of users after "@" and a list of issues and pull requests after "#".
 * - A comment links "@login" to the user and "#123" to the issue or the pull request.
 * Only GitHub repositories have a provider. Without it, a comment box is a plain text box.
 */
export interface MentionSource {
    target: RepoTarget;
    /** The web address of the repository, for example "https://github.com/acme/app". */
    repoUrl: string;
    /** The users of the pull request: the author, the reviewers, the assignees and the people who commented. They come first in the list. */
    people: string[];
}

export const MentionContext = createContext<MentionSource | undefined>(undefined);

/** Returns the mention source of a pull request. Returns undefined for a pull request that is not on GitHub. */
export function mentionSourceOf(target: RepoTarget, pr: PullRequest): MentionSource | undefined {
    if (pr.host === 'azure') return undefined;
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
    return { target, repoUrl, people };
}

/** Returns the mention source of a GitHub repository that has no pull request yet. */
export function mentionSourceOfRepo(target: RepoTarget, repo: RepoRef): MentionSource | undefined {
    if (repo.host === 'azure') return undefined;
    return { target, repoUrl: `https://github.com/${repo.owner}/${repo.name}`, people: [] };
}
