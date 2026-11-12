// Converts Linear GraphQL API objects to ShipWarden task protocol types.
// The schema: https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql

/** The GraphQL fields of an issue that `toTask` reads. */
export const ISSUE_FIELDS = `
    id identifier title url priority priorityLabel updatedAt dueDate estimate branchName
    state { id name color type position }
    assignee { id name displayName avatarUrl }
    labels(first: 50) { nodes { id name color } }
    project { name }
    cycle { number name }
    team { id key }
`;

/** The GraphQL fields of a related issue (the parent or a sub-issue) that `toRef` reads. */
const REF_FIELDS = 'id identifier title url state { id name color type position } assignee { id name displayName avatarUrl }';

/** The GraphQL fields of an issue for tasks/get: the fields of `ISSUE_FIELDS`, the description, the parent and the sub-issues. */
export const FULL_ISSUE_FIELDS = `${ISSUE_FIELDS} description parent { ${REF_FIELDS} } children(first: 100) { nodes { ${REF_FIELDS} } }`;

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

/** The Linear priorities that a user can select. 0 ("No priority") is the empty value. */
export const PRIORITIES = [
    { id: '1', name: 'Urgent' },
    { id: '2', name: 'High' },
    { id: '3', name: 'Medium' },
    { id: '4', name: 'Low' }
];

/** The parts of an issue that tasks/update can change. Linear has no start date. The estimate is in points, not in time. */
export const EDITABLE = { title: true, description: true, assignees: true, labels: true, priority: true, dueDate: true };

/** Converts a Linear user to a person or an option. The ID is the user ID. */
export function toPerson(user) {
    if (!user) {
        return undefined;
    }
    return { id: user.id, name: user.displayName || user.name, avatarUrl: user.avatarUrl ?? undefined };
}

/** Converts a Linear label to a task label or an option. The ID is the label ID. */
export function toLabel(label) {
    return { id: label.id, name: label.name, color: label.color || undefined };
}

/** Converts a related issue (the parent or a sub-issue) to a task reference. */
export function toRef(issue) {
    return {
        id: issue.id,
        key: issue.identifier,
        title: issue.title,
        url: issue.url,
        ...(issue.state ? { status: toStatus(issue.state) } : {}),
        assignees: issue.assignee ? [toPerson(issue.assignee)] : []
    };
}

/** The details of an issue from `FULL_ISSUE_FIELDS`: the due date, the parent and the sub-issues. */
export function toDetails(issue) {
    const subtasks = (issue.children?.nodes ?? []).map(toRef);
    return {
        ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
        ...(issue.parent ? { parent: toRef(issue.parent) } : {}),
        ...(subtasks.length ? { subtasks } : {})
    };
}

/**
 * Converts an issue to a task. `withDescription` also adds the description, the details and the editable parts.
 * Only tasks/get and tasks/update use it.
 */
export function toTask(issue, { withDescription = false } = {}) {
    return {
        id: issue.id,
        key: issue.identifier,
        title: issue.title,
        url: issue.url,
        status: toStatus(issue.state),
        assignees: issue.assignee ? [toPerson(issue.assignee)] : [],
        labels: (issue.labels?.nodes ?? []).map(toLabel),
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
        },
        ...(withDescription ? { details: toDetails(issue), editable: EDITABLE } : {})
    };
}

/** The parts of a tasks/update request that Linear issues do not have. */
const UNSUPPORTED_PARTS = { startDate: 'a start date', timeEstimate: 'an estimate in time', customField: 'custom fields', checklistItem: 'checklists' };

/**
 * Converts a tasks/update request to an IssueUpdateInput. An empty result means no change.
 * A Linear issue has one assignee. The task dialog can send more than one, so the last ID is the new assignee.
 */
export function issueInput({ status, title, description, assignees, labels, priority, dueDate, ...rest }) {
    for (const [part, name] of Object.entries(UNSUPPORTED_PARTS)) {
        if (rest[part] !== undefined) {
            throw new Error(`Linear issues do not have ${name}.`);
        }
    }
    const input = {};
    if (status) {
        input.stateId = status;
    }
    if (title !== undefined) {
        if (!String(title ?? '').trim()) {
            throw new Error('An issue must have a title.');
        }
        input.title = String(title).trim();
    }
    if (description !== undefined) {
        input.description = description ?? '';
    }
    if (assignees !== undefined) {
        input.assigneeId = assignees?.at(-1) ?? null;
    }
    if (labels !== undefined) {
        input.labelIds = labels ?? [];
    }
    if (priority !== undefined) {
        input.priority = priorityValue(priority);
    }
    if (dueDate !== undefined) {
        input.dueDate = dayValue(dueDate);
    }
    return input;
}

/** Converts a priority option ID to a Linear priority. Null clears the priority: 0 is "No priority". */
export function priorityValue(priority) {
    if (priority === null || priority === '' || priority === '0') {
        return 0;
    }
    if (!PRIORITIES.some(option => option.id === String(priority))) {
        throw new Error(`The priority "${priority}" does not exist in Linear. Use a level from 1 (urgent) to 4 (low).`);
    }
    return Number(priority);
}

/** Checks a date for a Linear "TimelessDate". Null clears the date. */
export function dayValue(day) {
    if (day === null || day === '') {
        return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
        throw new Error(`The date "${day}" is not valid. Use the form YYYY-MM-DD.`);
    }
    return String(day);
}

/** Returns the labels that a user can put on an issue. A group label is only a parent of other labels. */
export function labelOptions(labels) {
    return labels
        .filter(label => !label.isGroup)
        .map(toLabel)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns the active members of a team as options, sorted by name. */
export function memberOptions(users) {
    return users
        .filter(user => user.active !== false)
        .map(toPerson)
        .sort((a, b) => a.name.localeCompare(b.name));
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
