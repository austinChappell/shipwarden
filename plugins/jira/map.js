// Converts Jira Cloud REST API v3 objects to ShipWarden task protocol types.
// The API: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
import { adfToMarkdown, isRoundTripSafe, markdownToAdf } from './adf.js';

/**
 * Returns the base URL of a Jira Cloud site, for example "https://acme.atlassian.net".
 * The input can be the site name ("acme"), the host ("acme.atlassian.net"), or a URL of the site.
 */
export function parseSite(input) {
    const text = String(input ?? '').trim();
    if (!text) {
        throw new Error('The Jira connection needs the site URL, for example "https://acme.atlassian.net". Add it in Settings > Task managers.');
    }
    const withScheme = /^https?:\/\//i.test(text) ? text : /^[a-z0-9-]+$/i.test(text) ? `https://${text}.atlassian.net` : `https://${text}`;
    let url;
    try {
        url = new URL(withScheme);
    } catch {
        throw new Error(`The Jira site URL "${text}" is not valid. Use the form "https://acme.atlassian.net".`);
    }
    if (url.protocol !== 'https:') {
        throw new Error('The Jira site URL must start with https://.');
    }
    return `https://${url.host.toLowerCase()}`;
}

/** Returns the value of the Authorization header for an Atlassian account email and an API token. */
export function basicAuth(email, token) {
    return `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`;
}

/** The colors of the Jira status categories ("colorName"). */
const CATEGORY_COLORS = {
    'blue-gray': '#8590a2',
    'medium-gray': '#8590a2',
    yellow: '#1d7afc',
    green: '#22a06b'
};

/** The order of the Jira status categories in a workflow. */
const CATEGORY_ORDER = ['new', 'indeterminate', 'done'];

/** A status name for a closed issue that did not get done. */
const CANCELED_NAME = /cancel|won'?t|reject|declin|duplicate|abandon/i;

/**
 * Jira has three status categories: "new" (To Do), "indeterminate" (In Progress), and "done" (Done).
 * A "new" status with "backlog" in the name is a backlog status. A "done" status such as "Won't do" is canceled.
 */
export function statusCategory(status) {
    const key = status?.statusCategory?.key;
    const name = status?.name ?? '';
    switch (key) {
        case 'new':
            return /backlog/i.test(name) ? 'backlog' : 'todo';
        case 'indeterminate':
            return 'in_progress';
        case 'done':
            return CANCELED_NAME.test(name) ? 'canceled' : 'done';
        default:
            return 'todo';
    }
}

function categoryRank(status) {
    const rank = CATEGORY_ORDER.indexOf(status?.statusCategory?.key);
    return rank === -1 ? 0 : rank;
}

/** Converts a Jira status to a ShipWarden status. `position` is the place of the status in the workflow, when it is known. */
export function toStatus(status, position = 0) {
    return {
        id: String(status.id),
        name: status.name,
        color: CATEGORY_COLORS[status.statusCategory?.colorName],
        category: statusCategory(status),
        order: categoryRank(status) * 1000 + position
    };
}

/**
 * Returns the statuses of a project in workflow order. `issueTypes` is the result of "GET /project/{id}/statuses":
 * the statuses of each issue type. The function keeps each status once and sorts by the category.
 */
export function projectStatusOrder(issueTypes) {
    const seen = new Map();
    for (const issueType of issueTypes ?? []) {
        for (const status of issueType.statuses ?? []) {
            if (!seen.has(String(status.id))) {
                seen.set(String(status.id), toStatus(status, seen.size));
            }
        }
    }
    return [...seen.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...status }) => status);
}

/** The statuses that an issue can have: the current status and the targets of its transitions. */
export function transitionStatuses(current, transitions) {
    const seen = new Map();
    for (const status of [current, ...(transitions ?? []).map(transition => transition.to)]) {
        if (status?.id !== undefined && !seen.has(String(status.id))) {
            seen.set(String(status.id), toStatus(status, seen.size));
        }
    }
    return [...seen.values()].sort((a, b) => a.order - b.order);
}

/** Returns the transition that moves an issue to the status, or throws an error with the possible statuses. */
export function findTransition(transitions, statusId, currentName) {
    const transition = (transitions ?? []).find(item => String(item.to?.id) === String(statusId));
    if (!transition) {
        const names = (transitions ?? []).map(item => item.to?.name ?? item.name).filter(Boolean);
        const from = currentName ? ` from "${currentName}"` : '';
        throw new Error(
            names.length
                ? `The Jira workflow has no transition${from} to this status. The possible statuses are: ${names.join(', ')}.`
                : `The Jira workflow has no transition${from} that you can use.`
        );
    }
    return transition;
}

/** Converts a Jira user to a person or an option. The ID is the account ID. */
export function toPerson(user) {
    if (!user) {
        return undefined;
    }
    return { id: user.accountId, name: user.displayName || user.emailAddress || 'Unknown', avatarUrl: user.avatarUrls?.['48x48'] };
}

/** Jira labels are names without an ID, so the name is the ID. */
export function toLabel(name) {
    return { id: name, name };
}

/** The level of a Jira priority is its ID. The default priorities go from 1 (Highest) to 5 (Lowest). */
export function toPriority(priority) {
    if (!priority?.id) {
        return undefined;
    }
    return { name: priority.name, level: Number(priority.id) };
}

/** Returns the priorities as options. The ID is the level as a string, as the protocol asks. */
export function priorityOptions(priorities) {
    return (priorities ?? []).map(priority => ({ id: String(priority.id), name: priority.name, color: priority.statusColor || undefined }));
}

/** Finds the IDs of the custom fields for the sprint and the story points in the result of "GET /field". */
export function findFieldIds(fields) {
    const list = fields ?? [];
    const sprint = list.find(field => field.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint');
    const points =
        list.find(field => field.schema?.custom === 'com.pyxis.greenhopper.jira:jsw-story-points') ??
        list.find(field => /^story points?( estimate)?$|^story point estimate$/i.test(field.name ?? '') && field.schema?.type === 'number');
    return { sprint: sprint?.id, storyPoints: points?.id };
}

/** The fields of an issue for the task list. */
export function listFields(fieldIds) {
    return [
        'summary',
        'status',
        'assignee',
        'labels',
        'priority',
        'updated',
        'issuetype',
        'components',
        'duedate',
        'project',
        'parent',
        ...(fieldIds?.sprint ? [fieldIds.sprint] : []),
        ...(fieldIds?.storyPoints ? [fieldIds.storyPoints] : [])
    ];
}

/** The fields of an issue for tasks/get: the list fields and the details. */
export function fullFields(fieldIds) {
    return [...listFields(fieldIds), 'description', 'reporter', 'created', 'subtasks', 'issuelinks', 'attachment', 'timeoriginalestimate', 'timespent'];
}

/** Returns the name of the active sprint of an issue, else the name of its last sprint. */
export function sprintName(value) {
    const sprints = Array.isArray(value) ? value : value ? [value] : [];
    const active = sprints.find(sprint => sprint?.state === 'active') ?? sprints.at(-1);
    return active?.name ?? null;
}

/** The URL of an issue in the Jira web app. */
export function issueUrl(site, key) {
    return `${site}/browse/${key}`;
}

/** Converts a related issue (the parent, a subtask, or a linked issue) to a task reference. */
export function toRef(issue, site) {
    const fields = issue.fields ?? {};
    return {
        id: String(issue.id),
        key: issue.key,
        title: fields.summary,
        url: issue.key ? issueUrl(site, issue.key) : undefined,
        ...(fields.status ? { status: toStatus(fields.status) } : {}),
        ...(fields.assignee ? { assignees: [toPerson(fields.assignee)] } : {})
    };
}

/** The relation of an issue link to this issue. A link with "inwardIssue" points from the other issue to this issue. */
function linkRelation(link) {
    const isBlocks = /block/i.test(link.type?.name ?? '');
    if (!isBlocks) {
        return 'related';
    }
    return link.outwardIssue ? 'blocks' : 'blocked_by';
}

/** The details of an issue for tasks/get. */
export function toDetails(issue, site) {
    const fields = issue.fields ?? {};
    const subtasks = (fields.subtasks ?? []).map(item => toRef(item, site));
    const links = (fields.issuelinks ?? [])
        .filter(link => link.inwardIssue || link.outwardIssue)
        .map(link => ({ relation: linkRelation(link), task: toRef(link.outwardIssue ?? link.inwardIssue, site) }));
    const attachments = (fields.attachment ?? []).map(file => ({
        name: file.filename,
        url: file.content,
        ...(file.size !== undefined ? { size: file.size } : {}),
        ...(file.thumbnail ? { thumbnailUrl: file.thumbnail } : {}),
        ...(file.created ? { createdAt: file.created } : {})
    }));
    return {
        ...(fields.project?.name ? { location: fields.project.name } : {}),
        ...(fields.reporter ? { creator: toPerson(fields.reporter) } : {}),
        ...(fields.created ? { createdAt: fields.created } : {}),
        ...(fields.duedate ? { dueDate: fields.duedate } : {}),
        ...(fields.timeoriginalestimate ? { timeEstimate: fields.timeoriginalestimate * 1000 } : {}),
        ...(fields.timespent ? { timeSpent: fields.timespent * 1000 } : {}),
        ...(fields.parent ? { parent: toRef(fields.parent, site) } : {}),
        ...(subtasks.length ? { subtasks } : {}),
        ...(links.length ? { links } : {}),
        ...(attachments.length ? { attachments } : {})
    };
}

/**
 * Converts an issue to a task. `withDetails` also adds the description, the details, and the editable parts.
 * Only tasks/get and tasks/update use it. The description is editable only when the Markdown keeps all its parts.
 */
export function toTask(issue, { site, fieldIds = {}, withDetails = false }) {
    const fields = issue.fields ?? {};
    return {
        id: String(issue.id),
        key: issue.key,
        title: fields.summary ?? '',
        url: issueUrl(site, issue.key),
        status: toStatus(fields.status ?? { id: 'unknown', name: 'Unknown' }),
        assignees: fields.assignee ? [toPerson(fields.assignee)] : [],
        labels: (fields.labels ?? []).map(toLabel),
        priority: toPriority(fields.priority),
        updatedAt: fields.updated ? new Date(fields.updated).toISOString() : undefined,
        description: withDetails ? adfToMarkdown(fields.description) : undefined,
        fields: {
            type: fields.issuetype?.name ?? null,
            sprint: fieldIds.sprint ? sprintName(fields[fieldIds.sprint]) : null,
            components: (fields.components ?? []).map(component => component.name).join(', ') || null,
            storyPoints: fieldIds.storyPoints ? (fields[fieldIds.storyPoints] ?? null) : null,
            dueDate: fields.duedate ?? null
        },
        ...(withDetails
            ? {
                  details: toDetails(issue, site),
                  editable: {
                      title: true,
                      description: isRoundTripSafe(fields.description),
                      assignees: true,
                      labels: true,
                      priority: true,
                      dueDate: true
                  }
              }
            : {})
    };
}

/** The parts of a tasks/update request that this plugin does not change. */
const UNSUPPORTED_PARTS = { startDate: 'a start date', timeEstimate: 'an estimate', customField: 'custom fields', checklistItem: 'checklists' };

/**
 * Converts a tasks/update request to the "fields" of "PUT /issue/{id}". The status is not a field: a transition changes it.
 * A Jira issue has one assignee. The task dialog can send more than one, so the last ID is the new assignee.
 */
export function issueFields({ title, description, assignees, labels, priority, dueDate, ...rest }) {
    for (const [part, name] of Object.entries(UNSUPPORTED_PARTS)) {
        if (rest[part] !== undefined) {
            throw new Error(`The Jira plugin cannot change ${name}.`);
        }
    }
    const fields = {};
    if (title !== undefined) {
        const summary = String(title ?? '').trim();
        if (!summary) {
            throw new Error('An issue must have a summary.');
        }
        fields.summary = summary;
    }
    if (description !== undefined) {
        fields.description = markdownToAdf(description);
    }
    if (assignees !== undefined) {
        const accountId = assignees?.at(-1);
        fields.assignee = accountId ? { accountId } : null;
    }
    if (labels !== undefined) {
        fields.labels = cleanLabels(labels ?? []);
    }
    if (priority !== undefined) {
        if (priority === null || priority === '') {
            throw new Error('A Jira issue must have a priority. Select a different priority.');
        }
        fields.priority = { id: String(priority) };
    }
    if (dueDate !== undefined) {
        fields.duedate = dayValue(dueDate);
    }
    return fields;
}

/** Checks the label names. A Jira label cannot contain a space. */
export function cleanLabels(labels) {
    return [
        ...new Set(
            labels.map(label => {
                const name = String(label).trim();
                if (/\s/.test(name)) {
                    throw new Error(`The label "${name}" has a space. A Jira label cannot contain spaces.`);
                }
                return name;
            })
        )
    ].filter(Boolean);
}

/** Checks a date as "YYYY-MM-DD". Null clears the date. */
export function dayValue(day) {
    if (day === null || day === '') {
        return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
        throw new Error(`The date "${day}" is not valid. Use the form YYYY-MM-DD.`);
    }
    return String(day);
}

/** Returns a JQL string literal. */
export function jqlString(text) {
    return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** True when the query looks like an issue key, for example "ENG-123". */
export function isIssueKey(query) {
    return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(String(query ?? '').trim());
}

/**
 * Returns the JQL for the task list of one project.
 * Filters: "assigned" (open issues of the user), "sprint" (issues in an open sprint), "open" (all open issues), and
 * "all" (with done issues). A query searches the summary. The special characters of the text search become spaces.
 */
export function issueJql(projectId, filter, query) {
    const parts = [`project = ${jqlString(projectId)}`];
    if (filter === 'assigned') {
        parts.push('assignee = currentUser()', 'statusCategory != Done');
    } else if (filter === 'sprint') {
        parts.push('sprint in openSprints()');
    } else if (filter !== 'all') {
        parts.push('statusCategory != Done');
    }
    const text = String(query ?? '')
        .replace(/[+\-&|!(){}[\]^~*?\\:"/]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (text) {
        parts.push(`summary ~ ${jqlString(`${text}*`)}`);
    }
    return `${parts.join(' AND ')} ORDER BY updated DESC`;
}

/** Converts a Jira comment to a ShipWarden comment with a Markdown body. */
export function toComment(comment) {
    return {
        id: String(comment.id),
        author: toPerson(comment.author),
        body: adfToMarkdown(comment.body),
        createdAt: comment.created ? new Date(comment.created).toISOString() : undefined
    };
}

/** Returns the comments with the oldest first. The task view shows the oldest first. */
export function oldestFirst(comments) {
    return [...comments].sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
}

/**
 * Returns the Dashboard comments of the issues: comments from other people, newer than `sinceMs` and newer than the
 * user's own last comment on the same issue. Each issue has its comments in `fields.comment.comments`.
 */
export function activityComments(issues, site, meId, sinceMs) {
    return (issues ?? []).flatMap(issue => {
        const comments = issue.fields?.comment?.comments ?? [];
        const own = comments.filter(comment => comment.author?.accountId === meId).map(comment => Date.parse(comment.created));
        const after = Math.max(sinceMs, ...own);
        return oldestFirst(comments)
            .filter(comment => comment.author?.accountId !== meId && Date.parse(comment.created) > after)
            .map(comment => ({
                id: String(comment.id),
                taskId: String(issue.id),
                taskKey: issue.key,
                taskTitle: issue.fields?.summary ?? issue.key,
                taskUrl: issueUrl(site, issue.key),
                author: comment.author?.displayName,
                body: adfToMarkdown(comment.body),
                createdAt: new Date(comment.created).toISOString()
            }));
    });
}

/** Returns the JQL of the Dashboard: the user's issues that changed since `sinceMs`. JQL has relative times in minutes. */
export function activityJql(sinceMs, now, projectIds) {
    const minutes = Math.max(1, Math.ceil((now - sinceMs) / 60000));
    const scope = projectIds?.length ? ` AND project in (${projectIds.map(jqlString).join(', ')})` : '';
    return `assignee = currentUser() AND updated >= -${minutes}m${scope} ORDER BY updated DESC`;
}

/** Converts projects to collections. `defaultId` marks the project that the picker selects first. */
export function toCollections(projects, site, defaultId) {
    return projects.map(project => ({
        id: String(project.id),
        name: project.name,
        path: project.projectCategory?.name || project.key,
        url: `${site}/browse/${project.key}`,
        ...(String(project.id) === String(defaultId) ? { default: true } : {})
    }));
}

/** Returns the ID of the project that has the most of the issues, or undefined for no issues. */
export function busiestProject(issues) {
    const counts = new Map();
    for (const issue of issues ?? []) {
        const id = issue.fields?.project?.id;
        if (id) {
            counts.set(String(id), (counts.get(String(id)) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Selects the issue type for a new issue. A subtask gets a subtask type. A new issue gets "Task", else the first
 * standard type that is not an epic.
 */
export function pickIssueType(types, { subtask = false } = {}) {
    const list = types ?? [];
    if (subtask) {
        const type = list.find(item => item.subtask);
        if (!type) {
            throw new Error('This Jira project has no subtask issue type.');
        }
        return type;
    }
    const standard = list.filter(item => !item.subtask);
    const type =
        standard.find(item => /^task$/i.test(item.name)) ??
        standard.find(item => !/^epic$/i.test(item.name) && Number(item.hierarchyLevel ?? 0) === 0) ??
        standard[0];
    if (!type) {
        throw new Error('This Jira project has no issue type for a new issue.');
    }
    return type;
}

/** Returns the error text of a Jira error response: "errorMessages" and the messages of "errors". */
export function errorText(body) {
    if (!body || typeof body !== 'object') {
        return '';
    }
    const messages = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([field, message]) => `${field}: ${message}`)];
    return messages.filter(Boolean).join(' ');
}

/** Returns the time in milliseconds to wait after a rate limit, from the "Retry-After" header (seconds). */
export function retryDelay(headers, maxMs) {
    const retryAfter = Number(headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000;
    return Math.min(Math.max(delay, 1000), maxMs);
}
