// Converts GitHub REST API issues and comments to ShipWarden task protocol types.

export const STATUSES = {
    open: { id: 'open', name: 'Open', color: '#3fb950', category: 'todo' },
    closed: { id: 'closed', name: 'Closed', color: '#a371f7', category: 'done' },
    notPlanned: { id: 'not_planned', name: 'Closed as not planned', color: '#8b949e', category: 'canceled' }
};

export function issueStatus(issue) {
    if (issue.state === 'open') {
        return STATUSES.open;
    }
    return issue.state_reason === 'not_planned' ? STATUSES.notPlanned : STATUSES.closed;
}

/** Returns "owner/name" from an issue. The REST and search APIs both give "repository_url". */
export function issueRepo(issue) {
    const match = /\/repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url ?? '');
    return match ? match[1] : undefined;
}

/**
 * Splits a task ID into the repository and the issue number. The ID is "owner/name#123", because a number alone
 * is not unique across repositories. A bare number (from protocol version 1) uses `fallbackRepo`.
 */
export function parseTaskId(id, fallbackRepo) {
    const match = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(String(id));
    if (match) {
        return { repo: match[1], number: match[2] };
    }
    if (/^\d+$/.test(String(id)) && fallbackRepo) {
        return { repo: fallbackRepo, number: String(id) };
    }
    throw new Error(`The task ID "${id}" is not valid. A GitHub task ID is "owner/repository#number".`);
}

/** Converts repositories from GET /user/repos to collections. Archived repositories and repositories without issues are left out. */
export function toCollections(repos, defaultRepo) {
    return repos
        .filter(repo => repo.has_issues && !repo.archived)
        .map(repo => ({
            id: repo.full_name,
            name: repo.name,
            path: repo.owner?.login,
            url: repo.html_url,
            ...(repo.full_name.toLowerCase() === defaultRepo?.toLowerCase() ? { default: true } : {})
        }));
}

export function toTask(issue, { withDescription = false } = {}) {
    const repo = issueRepo(issue);
    return {
        id: repo ? `${repo}#${issue.number}` : String(issue.number),
        key: `#${issue.number}`,
        title: issue.title,
        url: issue.html_url,
        status: issueStatus(issue),
        assignees: (issue.assignees ?? []).map(user => ({ name: user.login, avatarUrl: user.avatar_url })),
        labels: (issue.labels ?? []).map(label =>
            typeof label === 'string' ? { name: label } : { name: label.name, color: label.color ? `#${label.color}` : undefined }
        ),
        updatedAt: issue.updated_at,
        description: withDescription ? (issue.body ?? '') : undefined,
        fields: {
            author: issue.user?.login ?? null,
            comments: issue.comments ?? 0,
            milestone: issue.milestone?.title ?? null
        }
    };
}

export function toComment(comment) {
    return {
        id: String(comment.id),
        author: comment.user ? { name: comment.user.login, avatarUrl: comment.user.avatar_url } : undefined,
        body: comment.body ?? '',
        createdAt: comment.created_at
    };
}

/** The issues endpoint also returns pull requests. A task list shows only issues. */
export function onlyIssues(items) {
    return items.filter(item => !item.pull_request);
}

/** Returns the REST state change for a status ID. */
export function stateChange(statusId) {
    switch (statusId) {
        case 'open':
            return { state: 'open' };
        case 'closed':
            return { state: 'closed', state_reason: 'completed' };
        case 'not_planned':
            return { state: 'closed', state_reason: 'not_planned' };
        default:
            throw new Error(`The status "${statusId}" does not exist for GitHub issues.`);
    }
}
