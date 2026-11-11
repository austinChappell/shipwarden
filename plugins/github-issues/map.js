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

/**
 * Converts an issue to a task. `editable` gives the parts that tasks/update can change. Only tasks/get sends it.
 * The ID of an assignee is the login. A label has no ID, because the name is the option ID.
 */
export function toTask(issue, { withDescription = false, editable } = {}) {
    const repo = issueRepo(issue);
    return {
        id: repo ? `${repo}#${issue.number}` : String(issue.number),
        key: `#${issue.number}`,
        title: issue.title,
        url: issue.html_url,
        status: issueStatus(issue),
        assignees: (issue.assignees ?? []).map(toPerson),
        labels: (issue.labels ?? []).map(label =>
            typeof label === 'string' ? { name: label } : { name: label.name, color: label.color ? `#${label.color}` : undefined }
        ),
        updatedAt: issue.updated_at,
        description: withDescription ? (issue.body ?? '') : undefined,
        fields: {
            author: issue.user?.login ?? null,
            comments: issue.comments ?? 0,
            milestone: issue.milestone?.title ?? null
        },
        ...(editable ? { editable } : {})
    };
}

/** Converts a GitHub user to a person or an option. The ID is the login, because the REST API assigns issues by login. */
export function toPerson(user) {
    return { id: user.login, name: user.login, avatarUrl: user.avatar_url };
}

/** Converts a repository label to an option. The name is the ID, because the REST API sets labels by name. */
export function labelOption(label) {
    return { id: label.name, name: label.name, color: label.color ? `#${label.color}` : undefined };
}

/**
 * Returns the parts of an issue that the user can change. `permissions` comes from GET /repos/{owner}/{repo}.
 * Triage access gives the labels and the assignees. Write access also gives the title and the body.
 * The author of an issue can always change its title and body.
 */
export function editableParts(issue, permissions, login) {
    const write = !!(permissions?.admin || permissions?.maintain || permissions?.push);
    const triage = write || !!permissions?.triage;
    const author = !!login && issue.user?.login?.toLowerCase() === login.toLowerCase();
    return { title: write || author, description: write || author, assignees: triage, labels: triage };
}

/**
 * Converts a tasks/update request to the body of PATCH /repos/{owner}/{repo}/issues/{number}.
 * GitHub issues have no priority, no dates, no estimate, no custom fields and no checklists.
 */
export function issueChange({ status, title, description, assignees, labels, ...rest }) {
    for (const part of ['priority', 'startDate', 'dueDate', 'timeEstimate', 'customField', 'checklistItem']) {
        if (rest[part] !== undefined) {
            throw new Error(`GitHub issues do not have the part "${part}".`);
        }
    }
    const body = status ? stateChange(status) : {};
    if (title !== undefined) {
        if (!String(title).trim()) {
            throw new Error('An issue must have a title.');
        }
        body.title = String(title).trim();
    }
    if (description !== undefined) {
        body.body = description ?? '';
    }
    if (assignees !== undefined) {
        body.assignees = assignees ?? [];
    }
    if (labels !== undefined) {
        body.labels = labels ?? [];
    }
    return body;
}

/** Returns the label names that are not in the labels of the repository. The comparison ignores the case, as GitHub does. */
export function missingLabels(names, repoLabels) {
    const known = new Set(repoLabels.map(label => label.name.toLowerCase()));
    return [...new Set(names)].filter(name => !known.has(name.toLowerCase()));
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

/**
 * Loads the pages of a list with 100 items on each page, at most `maxPages` pages. The first page comes first. When
 * it is full, the other pages load at the same time, so the list needs two round trips and not one for each page.
 * The list stops at the first page that is not full.
 */
export async function loadPages(fetchPage, maxPages, pageSize = 100) {
    const first = await fetchPage(1);
    if (first.length < pageSize || maxPages <= 1) return first;
    const rest = await Promise.all(Array.from({ length: maxPages - 1 }, (_, index) => fetchPage(index + 2)));
    const items = [...first];
    for (const page of rest) {
        items.push(...page);
        if (page.length < pageSize) break;
    }
    return items;
}
