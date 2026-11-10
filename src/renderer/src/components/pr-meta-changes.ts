import type { GitHubLabel, GitHubUser, PullRequest, PullRequestChange, RequestedReviewer } from '@shared/github';

/** A change to the reviewers, the assignees or the labels of a pull request. */
export type MetaChange = Extract<PullRequestChange, { kind: 'assignee' | 'reviewer' | 'label' }>;

/** The reviewers, the assignees and the labels that the sidebar shows. */
export interface MetaValues {
    reviewRequests: RequestedReviewer[];
    assignees: GitHubUser[];
    labels: GitHubLabel[];
}

/**
 * Returns the key of the item that a change adds or removes. Two changes with the same key change the same item,
 * so they must go to GitHub in order.
 */
export function metaChangeKey(change: MetaChange): string {
    switch (change.kind) {
        case 'assignee':
            return `assignee:${change.login}`;
        case 'reviewer':
            return `reviewer:${change.reviewer.kind}:${change.reviewer.login}`;
        case 'label':
            return `label:${change.name}`;
    }
}

/**
 * Applies the changes that GitHub did not confirm yet to the values of the pull request, in order.
 * A change is idempotent: an add of an item that is in the list, or a remove of an item that is not in the list,
 * does nothing. Thus the result stays correct when the pull request already has a change.
 * `knownLabels` gives the color of a label that the pull request does not have yet.
 */
export function applyMetaChanges(pr: Pick<PullRequest, keyof MetaValues>, changes: MetaChange[], knownLabels: GitHubLabel[] = []): MetaValues {
    let { reviewRequests, assignees, labels } = pr;
    for (const change of changes) {
        switch (change.kind) {
            case 'assignee': {
                const has = assignees.some(user => user.login === change.login);
                if (change.add && !has) assignees = [...assignees, { login: change.login }];
                if (!change.add && has) assignees = assignees.filter(user => user.login !== change.login);
                break;
            }
            case 'reviewer': {
                const same = (item: RequestedReviewer) => item.kind === change.reviewer.kind && item.login === change.reviewer.login;
                const has = reviewRequests.some(same);
                if (change.add && !has) reviewRequests = [...reviewRequests, change.reviewer];
                if (!change.add && has) reviewRequests = reviewRequests.filter(item => !same(item));
                break;
            }
            case 'label': {
                const has = labels.some(label => label.name === change.name);
                if (change.add && !has) {
                    const known = knownLabels.find(label => label.name === change.name);
                    labels = [...labels, known ?? { name: change.name, color: '' }];
                }
                if (!change.add && has) labels = labels.filter(label => label.name !== change.name);
                break;
            }
        }
    }
    return { reviewRequests, assignees, labels };
}
