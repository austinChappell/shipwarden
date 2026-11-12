// A ShipWarden task plugin for Linear. Each Linear team is a collection.
// The plugin uses the Linear GraphQL API with fetch. It has no dependencies.
import { log, networkDetail, runPlugin } from '../sdk/index.js';
import {
    activityComments,
    busiestTeam,
    COMMENT_FIELDS,
    errorCode,
    errorText,
    FULL_ISSUE_FIELDS,
    ISSUE_FIELDS,
    issueFilter,
    issueInput,
    labelOptions,
    memberOptions,
    oldestFirst,
    PRIORITIES,
    retryDelay,
    STATE_FIELDS,
    teamStatusOrder,
    toCollections,
    toComment,
    toStatus,
    toTask
} from './map.js';

const API = 'https://api.linear.app/graphql';
const PAGE_SIZE = 50;
/** The plugin reads at most this number of pages of a connection, for example the teams or the comments. */
const MAX_PAGES = 10;
/** The plugin keeps the teams and the workflow states for 10 minutes. */
const CACHE_MS = 10 * 60 * 1000;
/** The plugin waits for a rate limit only when the wait is shorter than this time. */
const MAX_RETRY_WAIT_MS = 30 * 1000;
/** The number of retries after a rate limit. */
const MAX_RETRIES = 2;
/** The time limit of one request. */
const REQUEST_TIMEOUT_MS = 30 * 1000;
/** The Dashboard reads the comments of this number of recently changed issues, at most. */
const ACTIVITY_ISSUES = 40;

let apiKey;
let viewer;
/** All teams of the API key. The settings page lists them as scopes. */
let allTeams = [];
/** The team IDs in the connection's scope. Undefined means all teams. */
let scopeIds;
/** The collections, with the time of the load. */
let collectionsCache;
/** The workflow states of each team, with the time of the load. */
const teamStates = new Map();
/** The labels that the issues of each team can have, with the time of the load. */
const teamLabels = new Map();
/** The members of each team, with the time of the load. */
const teamMembers = new Map();
/** The team ID of each issue that the plugin loaded. The options of an issue come from its team. */
const teamOfIssue = new Map();

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Sends a GraphQL request to Linear and returns its data. It waits and tries again after a rate limit. */
async function linear(query, variables = {}, attempt = 0) {
    let response;
    try {
        response = await fetch(API, {
            method: 'POST',
            headers: {
                // A personal API key has no "Bearer" prefix.
                Authorization: apiKey,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        throw new Error(`ShipWarden cannot connect to Linear: ${networkDetail(error)}`);
    }
    let body;
    try {
        body = await response.json();
    } catch {
        // The response has no JSON body.
    }
    const errors = body?.errors ?? [];
    const codes = errors.map(errorCode);
    if (response.status === 429 || codes.includes('RATELIMITED')) {
        const delay = retryDelay(response.headers, Date.now(), Number.POSITIVE_INFINITY);
        if (attempt < MAX_RETRIES && delay <= MAX_RETRY_WAIT_MS) {
            log(`Linear limits the request rate. The plugin waits ${Math.round(delay / 1000)} seconds.`);
            await wait(delay);
            return linear(query, variables, attempt + 1);
        }
        throw new Error(`Linear limits the request rate. Try again in ${Math.ceil(delay / 60000)} minutes.`);
    }
    if (response.status === 401 || codes.includes('AUTHENTICATION_ERROR')) {
        throw new Error(`Linear did not accept the API key. Make a new key in Linear > Settings > Security & access. ${errorText(errors)}`.trim());
    }
    if (errors.length > 0) {
        throw new Error(`Linear returned an error: ${errorText(errors) || response.status}`);
    }
    if (!response.ok || !body?.data) {
        throw new Error(`Linear returned ${response.status} with no data.`);
    }
    return body.data;
}

/**
 * Reads all pages of a connection. `select` returns the connection from the data of one page.
 * The query must take the variables "first" and "after".
 */
async function allPages(query, variables, select) {
    const nodes = [];
    let after;
    for (let page = 0; page < MAX_PAGES; page++) {
        const connection = select(await linear(query, { ...variables, first: PAGE_SIZE, after }));
        nodes.push(...connection.nodes);
        if (!connection.pageInfo?.hasNextPage) {
            break;
        }
        after = connection.pageInfo.endCursor;
    }
    return nodes;
}

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

async function loadTeams() {
    return allPages(
        `query Teams($first: Int, $after: String) { teams(first: $first, after: $after) { nodes { id key name } ${PAGE_INFO} } }`,
        {},
        data => data.teams
    );
}

/** Returns the teams in the connection's scope. */
function teamsInScope() {
    return scopeIds ? allTeams.filter(team => scopeIds.includes(team.id)) : allTeams;
}

/** Returns the workflow states of a team. The plugin keeps them for 10 minutes. */
async function statesOfTeam(teamId) {
    const cached = teamStates.get(teamId);
    if (cached && Date.now() - cached.at < CACHE_MS) {
        return cached.states;
    }
    const states = await allPages(
        `query States($id: String!, $first: Int, $after: String) {
            team(id: $id) { states(first: $first, after: $after) { nodes { ${STATE_FIELDS} } ${PAGE_INFO} } }
        }`,
        { id: teamId },
        data => data.team.states
    );
    teamStates.set(teamId, { states, at: Date.now() });
    return states;
}

/** Returns the value of `key` in `cache`. When the value is absent or older than 10 minutes, `load` gets it again. */
async function cached(cache, key, load) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.at < CACHE_MS) {
        return entry.value;
    }
    const value = await load();
    cache.set(key, { value, at: Date.now() });
    return value;
}

/** Keeps the team of an issue, and converts the issue to a task with the description, the details and the editable parts. */
function fullTask(issue) {
    if (issue.team?.id) {
        teamOfIssue.set(issue.id, issue.team.id);
    }
    return toTask(issue, { withDescription: true });
}

async function loadIssue(id) {
    const data = await linear(`query Issue($id: String!) { issue(id: $id) { ${FULL_ISSUE_FIELDS} } }`, { id });
    return fullTask(data.issue);
}

/** Returns the team ID of an issue. */
async function teamOf(id) {
    const known = teamOfIssue.get(id);
    if (known) {
        return known;
    }
    const data = await linear('query IssueTeam($id: String!) { issue(id: $id) { id team { id } } }', { id });
    teamOfIssue.set(id, data.issue.team.id);
    // The ShipWarden task ID is the UUID of the issue. Linear also accepts the identifier, so keep both keys.
    teamOfIssue.set(data.issue.id, data.issue.team.id);
    return data.issue.team.id;
}

/** Returns the labels of a team and the labels of the workspace. The plugin keeps them for 10 minutes. */
function labelsOfTeam(teamId) {
    return cached(teamLabels, teamId, () =>
        allPages(
            `query Labels($filter: IssueLabelFilter, $first: Int, $after: String) {
                issueLabels(filter: $filter, first: $first, after: $after) { nodes { id name color isGroup } ${PAGE_INFO} }
            }`,
            { filter: { or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] } },
            data => data.issueLabels
        )
    );
}

/** Returns the members of a team. The plugin keeps them for 10 minutes. */
function membersOfTeam(teamId) {
    return cached(teamMembers, teamId, () =>
        allPages(
            `query Members($id: String!, $first: Int, $after: String) {
                team(id: $id) { members(first: $first, after: $after) { nodes { id name displayName avatarUrl active } ${PAGE_INFO} } }
            }`,
            { id: teamId },
            data => data.team.members
        )
    );
}

/** Changes an issue and returns the task. `input` is an IssueUpdateInput. */
async function changeIssue(id, input) {
    const data = await linear(
        `mutation Update($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success issue { ${FULL_ISSUE_FIELDS} } }
        }`,
        { id, input }
    );
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
        throw new Error('Linear did not change the issue.');
    }
    return fullTask(data.issueUpdate.issue);
}

runPlugin({
    async initialize({ settings, scope }) {
        apiKey = String(settings.apiKey ?? '').trim();
        if (!apiKey) {
            throw new Error('The Linear connection needs an API key. Add it in Settings > Task managers.');
        }
        viewer = (await linear('query Viewer { viewer { id name displayName organization { id name urlKey } } }')).viewer;
        allTeams = await loadTeams();
        if (allTeams.length === 0) {
            throw new Error('The Linear API key has no access to a team.');
        }
        scopeIds = scope;
        if (teamsInScope().length === 0) {
            throw new Error('The API key has no access to the selected Linear teams. Change the teams in Settings > Task managers.');
        }
        log(`Linear plugin ready for "${viewer.organization.name}" as ${viewer.displayName || viewer.name}.`);
        return {
            capabilities: { edit: true, subtasks: true },
            fields: [
                { id: 'branchName', label: 'Branch', type: 'text' },
                { id: 'project', label: 'Project', type: 'text' },
                { id: 'cycle', label: 'Cycle', type: 'text' },
                { id: 'estimate', label: 'Estimate', type: 'number' },
                { id: 'dueDate', label: 'Due', type: 'date' }
            ],
            actions: [
                { id: 'assign-me', label: 'Assign to me' },
                { id: 'unassign', label: 'Remove assignee', confirm: 'Remove the assignee from this issue?' }
            ],
            filters: [
                { id: 'assigned', label: 'Assigned to me', default: true },
                { id: 'cycle', label: 'Current cycle' },
                { id: 'open', label: 'All open issues' },
                { id: 'all', label: 'All issues, with closed' }
            ]
        };
    },

    /** The teams of the API key. The settings page lets the user restrict the connection to some of them. */
    async listScopes() {
        return allTeams.map(team => ({ id: team.id, name: team.name, detail: team.key }));
    },

    /** Each team in the scope is a collection. The team with the most open issues of the user is the default. */
    async listCollections() {
        if (collectionsCache && Date.now() - collectionsCache.at < CACHE_MS) {
            return collectionsCache.collections;
        }
        const teams = teamsInScope();
        const data = await linear(
            `query Assigned($filter: IssueFilter) {
                viewer { assignedIssues(first: 100, orderBy: updatedAt, filter: $filter) { nodes { team { id } } } }
            }`,
            { filter: { state: { type: { nin: ['completed', 'canceled'] } }, team: { id: { in: teams.map(team => team.id) } } } }
        ).catch(error => {
            log(`The plugin cannot find the default team: ${error.message}`);
            return undefined;
        });
        const busiest = busiestTeam(data?.viewer.assignedIssues.nodes ?? []);
        const collections = toCollections(teams, viewer.organization, busiest);
        collectionsCache = { collections, at: Date.now() };
        return collections;
    },

    async listTasks({ collection, filter = 'assigned', query, cursor }) {
        if (!collection) {
            throw new Error('Select a Linear team.');
        }
        const data = await linear(
            `query Issues($filter: IssueFilter, $first: Int, $after: String) {
                issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} }
            }`,
            { filter: issueFilter(collection, filter, query), first: PAGE_SIZE, after: cursor || undefined }
        );
        for (const issue of data.issues.nodes) {
            teamOfIssue.set(issue.id, issue.team.id);
        }
        return {
            tasks: data.issues.nodes.map(issue => toTask(issue)),
            nextCursor: data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : undefined
        };
    },

    async getTask({ id }) {
        return loadIssue(id);
    },

    /**
     * Makes an issue in a team. With `parent`, the issue is a sub-issue in the team of the parent.
     * `status` is the ID of a workflow state. Without it, Linear uses the default state of the team.
     */
    async createTask({ collection, title, description, status, parent }) {
        const name = String(title ?? '').trim();
        if (!name) {
            throw new Error('An issue must have a title.');
        }
        const teamId = parent ? await teamOf(parent) : collection;
        if (!teamId) {
            throw new Error('Select a Linear team.');
        }
        const input = {
            teamId,
            title: name,
            ...(description ? { description } : {}),
            ...(status ? { stateId: status } : {}),
            ...(parent ? { parentId: parent } : {})
        };
        const data = await linear(`mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${FULL_ISSUE_FIELDS} } } }`, {
            input
        });
        if (!data.issueCreate.success || !data.issueCreate.issue) {
            throw new Error('Linear did not make the issue.');
        }
        return fullTask(data.issueCreate.issue);
    },

    /** Changes the status, the title, the description, the assignee, the labels, the priority or the due date. */
    async updateTask(params) {
        const input = issueInput(params);
        if (Object.keys(input).length === 0) {
            return loadIssue(params.id);
        }
        return changeIssue(params.id, input);
    },

    /**
     * The choices for a part of an issue. The assignees: the active members of the team. The labels: the labels of the
     * team and of the workspace, without group labels. The priority: the four Linear priorities.
     * The user cannot type a new label, because Linear sets labels only by ID.
     */
    async listOptions({ id, part }) {
        if (part === 'priority') {
            return { options: PRIORITIES };
        }
        if (part === 'assignees') {
            return { options: memberOptions(await membersOfTeam(await teamOf(id))) };
        }
        if (part === 'labels') {
            return { options: labelOptions(await labelsOfTeam(await teamOf(id))) };
        }
        throw new Error(`Linear issues have no options for "${part}".`);
    },

    /** The workflow states of the team, in workflow order. */
    async statusOrder({ collection }) {
        return { statuses: teamStatusOrder(await statesOfTeam(collection)) };
    },

    /** The statuses come from the team of the issue, because each Linear team has its own workflow. */
    async listStatuses({ id }) {
        if (!id) {
            return [];
        }
        const states = await statesOfTeam(await teamOf(id));
        return [...states].map(toStatus).sort((a, b) => a.order - b.order);
    },

    async listComments({ taskId }) {
        const comments = await allPages(
            `query Comments($id: String!, $first: Int, $after: String) {
                issue(id: $id) { comments(first: $first, after: $after) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} } }
            }`,
            { id: taskId },
            data => data.issue.comments
        );
        return oldestFirst(comments).map(toComment);
    },

    async createComment({ taskId, body }) {
        const data = await linear(`mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } } }`, {
            input: { issueId: taskId, body }
        });
        if (!data.commentCreate.success || !data.commentCreate.comment) {
            throw new Error('Linear did not add the comment.');
        }
        return toComment(data.commentCreate.comment);
    },

    async runAction({ taskId, actionId }) {
        switch (actionId) {
            case 'assign-me':
                await changeIssue(taskId, { assigneeId: viewer.id });
                return { message: 'The issue is assigned to you.' };
            case 'unassign':
                await changeIssue(taskId, { assigneeId: null });
                return { message: 'The issue has no assignee now.' };
            default:
                throw new Error(`The action "${actionId}" does not exist for Linear issues.`);
        }
    },

    /**
     * The Dashboard: comments from other people on the issues assigned to the user, newer than `since`.
     * One request reads the issues that changed and their new comments.
     */
    async listActivity({ since }) {
        const sinceMs = Date.parse(since);
        if (!Number.isFinite(sinceMs)) {
            throw new Error('activity/list needs "since" as an ISO time.');
        }
        const sinceIso = new Date(sinceMs).toISOString();
        const filter = { updatedAt: { gt: sinceIso }, ...(scopeIds ? { team: { id: { in: scopeIds } } } : {}) };
        const data = await linear(
            `query Activity($filter: IssueFilter, $since: DateTimeOrDuration) {
                viewer { assignedIssues(first: ${ACTIVITY_ISSUES}, orderBy: updatedAt, filter: $filter) { nodes {
                    id identifier title url
                    comments(first: 50, filter: { createdAt: { gt: $since } }) { nodes { ${COMMENT_FIELDS} } }
                } } }
            }`,
            { filter, since: sinceIso }
        );
        return { comments: activityComments(data.viewer.assignedIssues.nodes, viewer.id, sinceMs) };
    }
});
