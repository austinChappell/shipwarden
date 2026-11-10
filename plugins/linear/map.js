// Converts Linear GraphQL API objects to ShipWarden task protocol types.
// The schema: https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql

/** The GraphQL fields of an issue that `toTask` reads. */
export const ISSUE_FIELDS = `
    id identifier title url priority priorityLabel updatedAt dueDate estimate branchName
    state { id name color type position }
    assignee { id name displayName avatarUrl }
    labels(first: 20) { nodes { name color } }
    project { name }
    cycle { number name }
    team { id key }
`;

/** The GraphQL fields of a comment that `toComment` reads. */
export const COMMENT_FIELDS = `
    id body createdAt
    user { id name displayName avatarUrl }
    botActor { name avatarUrl }
    externalUser { name avatarUrl }
`;

/** The GraphQL fields of a workflow state that `toStatus` reads. */
export const STATE_FIELDS = 'id name color type position';

/** The order of the Linear workflow state types. The Linear app shows the states in this order. */
const TYPE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];

/** Linear workflow state types: triage, backlog, unstarted, started, completed, canceled. */
export function statusCategory(type) {
    switch (type) {
        case 'triage':
        case 'backlog':
            return 'backlog';
        case 'unstarted':
            return 'todo';
        case 'started':
            return 'in_progress';
        case 'completed':
            return 'done';
        case 'canceled':
            return 'canceled';
        default:
            return 'todo';
    }
}

/** Returns the position of a state in its team's workflow: first the type, then the position in the type. */
function stateRank(state) {
    const type = TYPE_ORDER.indexOf(state.type);
    return (type === -1 ? TYPE_ORDER.length : type) * 1e6 + (Number(state.position) || 0);
}

export function toStatus(state) {
    return {
        id: state.id,
        name: state.name,
        color: state.color || undefined,
        category: statusCategory(state.type),
        order: stateRank(state)
    };
}

/** Returns the workflow states of a team in workflow order, without the per-task order field. */
export function teamStatusOrder(states) {
    return [...states]
        .sort((a, b) => stateRank(a) - stateRank(b))
        .map(state => {
            const { order: _order, ...rest } = toStatus(state);
            return rest;
        });
}

function toPerson(user) {
    if (!user) {
        return undefined;
    }
    return { name: user.displayName || user.name, avatarUrl: user.avatarUrl ?? undefined };
}

export function toTask(issue, { withDescription = false } = {}) {
    return {
        id: issue.id,
        key: issue.identifier,
        title: issue.title,
        url: issue.url,
        status: toStatus(issue.state),
        assignees: issue.assignee ? [toPerson(issue.assignee)] : [],
        labels: (issue.labels?.nodes ?? []).map(label => ({ name: label.name, color: label.color || undefined })),
        // Linear priorities: 0 no priority, 1 urgent, 2 high, 3 medium, 4 low.
        priority: issue.priority ? { name: issue.priorityLabel, level: Number(issue.priority) } : undefined,
        updatedAt: issue.updatedAt,
        description: withDescription ? (issue.description ?? '') : undefined,
        fields: {
            branchName: issue.branchName ?? null,
            project: issue.project?.name ?? null,
            cycle: issue.cycle ? issue.cycle.name || `Cycle ${issue.cycle.number}` : null,
            estimate: issue.estimate ?? null,
            dueDate: issue.dueDate ?? null
        }
    };
}

/** A comment can come from a user, an integration (bot) or a person outside Linear, for example in Slack. */
export function commentAuthor(comment) {
    return toPerson(comment.user) ?? toPerson(comment.botActor) ?? toPerson(comment.externalUser);
}

export function toComment(comment) {
    return {
        id: comment.id,
        author: commentAuthor(comment),
        body: comment.body ?? '',
        createdAt: comment.createdAt
    };
}

/** Returns the comments with the oldest first. The task view shows the oldest first. */
export function oldestFirst(comments) {
    return [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * Converts teams to collections. `organization` gives the path and the URL.
 * `defaultTeamId` marks the team that the picker selects first.
 */
export function toCollections(teams, organization, defaultTeamId) {
    return teams.map(team => ({
        id: team.id,
        name: team.name,
        path: organization?.name,
        url: organization?.urlKey ? `https://linear.app/${organization.urlKey}/team/${team.key}/active` : undefined,
        ...(team.id === defaultTeamId ? { default: true } : {})
    }));
}

/** Returns the ID of the team that has the most of the issues, or undefined for no issues. */
export function busiestTeam(issues) {
    const counts = new Map();
    for (const issue of issues) {
        if (issue.team?.id) {
            counts.set(issue.team.id, (counts.get(issue.team.id) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Returns the GraphQL issue filter for the task list of one team.
 * Filters: "assigned" (open issues of the user), "cycle" (open issues in the current cycle),
 * "open" (all open issues) and "all" (with completed and canceled issues).
 * A query matches the title, or the number when the query is a number or an identifier such as "ENG-123".
 */
export function issueFilter(teamId, filter, query) {
    const parts = [{ team: { id: { eq: teamId } } }];
    if (filter !== 'all') {
        parts.push({ state: { type: { nin: ['completed', 'canceled'] } } });
    }
    if (filter === 'assigned') {
        parts.push({ assignee: { isMe: { eq: true } } });
    }
    if (filter === 'cycle') {
        parts.push({ cycle: { isActive: { eq: true } } });
    }
    const text = query?.trim();
    if (text) {
        const match = /^(?:[A-Za-z][A-Za-z0-9_]*-)?(\d+)$/.exec(text);
        parts.push(match ? { or: [{ number: { eq: Number(match[1]) } }, { title: { containsIgnoreCase: text } }] } : { title: { containsIgnoreCase: text } });
    }
    return { and: parts };
}

/**
 * Returns the Dashboard comments of the issues: comments from other people, newer than `sinceMs` and newer than the
 * user's own last comment on the same issue. Each issue has its comments in `comments.nodes`.
 */
export function activityComments(issues, viewerId, sinceMs) {
    return issues.flatMap(issue => {
        const comments = issue.comments?.nodes ?? [];
        const own = comments.filter(comment => comment.user?.id === viewerId).map(comment => Date.parse(comment.createdAt));
        const after = Math.max(sinceMs, ...own);
        return oldestFirst(comments)
            .filter(comment => comment.user?.id !== viewerId && Date.parse(comment.createdAt) > after)
            .map(comment => ({
                id: comment.id,
                taskId: issue.id,
                taskKey: issue.identifier,
                taskTitle: issue.title,
                taskUrl: issue.url,
                author: commentAuthor(comment)?.name,
                body: comment.body ?? '',
                createdAt: comment.createdAt
            }));
    });
}

/** Returns the error code of a GraphQL error, for example "RATELIMITED" or "AUTHENTICATION_ERROR". */
export function errorCode(error) {
    return error?.extensions?.code ?? error?.extensions?.type;
}

/** Returns the text of the GraphQL errors for a person to read. */
export function errorText(errors) {
    return (errors ?? [])
        .map(error => error.extensions?.userPresentableMessage ?? error.message)
        .filter(Boolean)
        .join(' ');
}

/**
 * Returns the time in milliseconds to wait after a rate limit. It uses the "Retry-After" header (seconds), else the
 * "X-RateLimit-Requests-Reset" header (epoch milliseconds). The result is between 1 second and `maxMs`.
 */
export function retryDelay(headers, now, maxMs) {
    const retryAfter = Number(headers.get('retry-after'));
    let delay;
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delay = retryAfter * 1000;
    } else {
        const reset = Number(headers.get('x-ratelimit-requests-reset'));
        delay = Number.isFinite(reset) && reset > now ? reset - now : 1000;
    }
    return Math.min(Math.max(delay, 1000), maxMs);
}
