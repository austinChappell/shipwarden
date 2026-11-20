// The request handlers of the Jira plugin. Each Jira project is a collection.
// The plugin uses the Jira Cloud REST API v3 with fetch and Basic auth (email and API token). It has no dependencies.
import { log, networkDetail } from '../sdk/index.js';
import { markdownToAdf } from './adf.js';
import {
    activityComments,
    activityJql,
    basicAuth,
    busiestProject,
    errorText,
    findFieldIds,
    findTransition,
    fullFields,
    isIssueKey,
    issueFields,
    issueJql,
    jqlString,
    listFields,
    oldestFirst,
    parseSite,
    pickIssueType,
    priorityOptions,
    projectStatusOrder,
    retryDelay,
    toCollections,
    toComment,
    toLabel,
    toPerson,
    toTask,
    transitionStatuses
} from './map.js';

const PAGE_SIZE = 50;
/** The plugin reads at most this number of pages of a list, for example the projects or the comments. */
const MAX_PAGES = 20;
/** The plugin keeps the projects, the statuses, the people, and the options for 10 minutes. */
const CACHE_MS = 10 * 60 * 1000;
/** The plugin waits for a rate limit only when the wait is shorter than this time. */
const MAX_RETRY_WAIT_MS = 30 * 1000;
/** The number of retries after a rate limit. */
const MAX_RETRIES = 2;
/** The time limit of one request. */
const REQUEST_TIMEOUT_MS = 30 * 1000;
/** The Dashboard reads the comments of this number of recently changed issues, at most. */
const ACTIVITY_ISSUES = 40;

/**
 * Makes the handlers for `runPlugin`.
 * - `fetch`: the fetch function. The tests give a fetch that answers from fixtures.
 * - `now()`: returns the time in milliseconds.
 * - `wait(ms)`: waits before a retry after a rate limit.
 */
export function createHandlers({ fetch = globalThis.fetch, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    let site;
    let authorization;
    /** The user of the API token. */
    let me;
    /** The IDs of the custom fields for the sprint and the story points. */
    let fieldIds = {};
    /** All projects of the user. The settings page lists them as scopes. */
    let allProjects = [];
    /** The project IDs in the connection's scope. Undefined means all projects. */
    let scopeIds;
    /** The collections, with the time of the load. */
    let collectionsCache;
    const projectStatuses = new Map();
    const projectPeople = new Map();
    const issuePeople = new Map();
    const optionCache = new Map();

    /**
     * Sends a request to the Jira REST API v3. `path` starts after "/rest/api/3". It waits and tries again after a
     * rate limit. Returns null for a response without a body.
     */
    async function jira(method, path, { query, body } = {}, attempt = 0) {
        const search = query
            ? `?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString()}`
            : '';
        let response;
        try {
            response = await fetch(`${site}/rest/api/3${path}${search}`, {
                method,
                headers: {
                    Authorization: authorization,
                    Accept: 'application/json',
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch (error) {
            throw new Error(`ShipWarden cannot connect to Jira: ${networkDetail(error)}`);
        }
        if (response.status === 429) {
            const delay = retryDelay(response.headers, Number.POSITIVE_INFINITY);
            if (attempt < MAX_RETRIES && delay <= MAX_RETRY_WAIT_MS) {
                log(`Jira limits the request rate. The plugin waits ${Math.round(delay / 1000)} seconds.`);
                await wait(delay);
                return jira(method, path, { query, body }, attempt + 1);
            }
            throw new Error(`Jira limits the request rate. Try again in ${Math.ceil(delay / 60000)} minutes.`);
        }
        let data = null;
        const text = await response.text();
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                // The response has no JSON body, for example a sign-in page.
            }
        }
        if (response.status === 401) {
            throw new Error(
                'Jira did not accept the email and the API token. Make sure that the email is the email of your Atlassian account, and make a new API token.'
            );
        }
        if (response.status === 403) {
            throw new Error(`Jira refused the request. Your account possibly has no permission for it. ${errorText(data)}`.trim());
        }
        if (!response.ok) {
            const detail = errorText(data) || (response.status === 404 ? 'Make sure that the site URL is correct.' : '');
            throw new Error(`Jira returned ${response.status} for ${method} ${path}. ${detail}`.trim());
        }
        return data;
    }

    /**
     * Reads all pages of a list with "startAt" and "isLast", for example "/project/search".
     * `select` returns the items of one page. Without "isLast", a short page is the last page.
     */
    async function offsetPages(path, query, select = page => page.values ?? []) {
        const items = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const data = await jira('GET', path, { query: { ...query, startAt: items.length, maxResults: PAGE_SIZE } });
            const values = select(data);
            items.push(...values);
            const isLast = data?.isLast ?? (data?.total !== undefined ? items.length >= data.total : values.length < PAGE_SIZE);
            if (isLast || values.length === 0) {
                break;
            }
        }
        return items;
    }

    /** Searches issues with the enhanced JQL search. A page ends with "nextPageToken" when more issues exist. */
    async function search(jql, fields, { nextPageToken, maxResults = PAGE_SIZE } = {}) {
        const data = await jira('POST', '/search/jql', { body: { jql, fields, maxResults, ...(nextPageToken ? { nextPageToken } : {}) } });
        return { issues: data?.issues ?? [], nextPageToken: data?.isLast ? undefined : data?.nextPageToken || undefined };
    }

    /** Returns the value of `key` in `cache`. When the value is absent or older than 10 minutes, `load` gets it again. */
    async function cached(cache, key, load) {
        const entry = cache.get(key);
        if (entry && now() - entry.at < CACHE_MS) {
            return entry.value;
        }
        const value = await load();
        cache.set(key, { value, at: now() });
        return value;
    }

    function projectsInScope() {
        return scopeIds ? allProjects.filter(project => scopeIds.includes(String(project.id))) : allProjects;
    }

    async function loadIssue(id) {
        const issue = await jira('GET', `/issue/${encodeURIComponent(id)}`, { query: { fields: fullFields(fieldIds).join(',') } });
        return toTask(issue, { site, fieldIds, withDetails: true });
    }

    /** Moves an issue to a status with the transition of the workflow that goes there. */
    async function transition(id, statusId) {
        const [data, issue] = await Promise.all([
            jira('GET', `/issue/${encodeURIComponent(id)}/transitions`),
            jira('GET', `/issue/${encodeURIComponent(id)}`, { query: { fields: 'status' } })
        ]);
        if (String(issue.fields?.status?.id) === String(statusId)) {
            return;
        }
        const match = findTransition(data?.transitions, statusId, issue.fields?.status?.name);
        await jira('POST', `/issue/${encodeURIComponent(id)}/transitions`, { body: { transition: { id: match.id } } });
    }

    async function assignableUsers(query) {
        const users = await offsetPages('/user/assignable/search', query, page => page ?? []);
        return users.filter(user => user.active !== false && user.accountType !== 'app').map(toPerson);
    }

    return {
        handlers: {
            async initialize({ settings, scope }) {
                site = parseSite(settings.site);
                const email = String(settings.email ?? '').trim();
                const token = String(settings.apiToken ?? '').trim();
                if (!email || !token) {
                    throw new Error('The Jira connection needs the email of your Atlassian account and an API token. Add them in Settings > Task managers.');
                }
                authorization = basicAuth(email, token);
                me = await jira('GET', '/myself');
                const [fields, projects] = await Promise.all([
                    jira('GET', '/field').catch(error => {
                        log(`The plugin cannot read the Jira fields: ${error.message}`);
                        return [];
                    }),
                    offsetPages('/project/search', { orderBy: 'name' })
                ]);
                fieldIds = findFieldIds(fields);
                allProjects = projects;
                if (allProjects.length === 0) {
                    throw new Error('The Jira account has no access to a project.');
                }
                scopeIds = scope?.map(String);
                if (projectsInScope().length === 0) {
                    throw new Error('The account has no access to the selected Jira projects. Change the projects in Settings > Task managers.');
                }
                log(`Jira plugin ready for ${site} as ${me.displayName}.`);
                return {
                    capabilities: { edit: true, subtasks: true },
                    fields: [
                        { id: 'type', label: 'Type', type: 'text' },
                        { id: 'sprint', label: 'Sprint', type: 'text' },
                        { id: 'components', label: 'Components', type: 'text' },
                        { id: 'storyPoints', label: 'Story points', type: 'number' },
                        { id: 'dueDate', label: 'Due', type: 'date' }
                    ],
                    actions: [
                        { id: 'assign-me', label: 'Assign to me' },
                        { id: 'unassign', label: 'Remove assignee', confirm: 'Remove the assignee from this issue?' }
                    ],
                    filters: [
                        { id: 'assigned', label: 'Assigned to me', default: true },
                        { id: 'sprint', label: 'Current sprint' },
                        { id: 'open', label: 'All open issues' },
                        { id: 'all', label: 'All issues, with done issues' }
                    ]
                };
            },

            /** The projects of the account. The settings page lets the user restrict the connection to some of them. */
            async listScopes() {
                return allProjects.map(project => ({ id: String(project.id), name: project.name, detail: project.key }));
            },

            /** Each project in the scope is a collection. The project with the most open issues of the user is the default. */
            async listCollections() {
                if (collectionsCache && now() - collectionsCache.at < CACHE_MS) {
                    return collectionsCache.collections;
                }
                const projects = projectsInScope();
                const scopeJql = scopeIds ? ` AND project in (${projects.map(project => jqlString(project.id)).join(', ')})` : '';
                const result = await search(`assignee = currentUser() AND statusCategory != Done${scopeJql} ORDER BY updated DESC`, ['project'], {
                    maxResults: 100
                }).catch(error => {
                    log(`The plugin cannot find the default project: ${error.message}`);
                    return { issues: [] };
                });
                const collections = toCollections(projects, site, busiestProject(result.issues));
                collectionsCache = { collections, at: now() };
                return collections;
            },

            /** One page of issues. The cursor is the "nextPageToken" of the Jira search. */
            async listTasks({ collection, filter = 'assigned', query, cursor }) {
                if (!collection) {
                    throw new Error('Select a Jira project.');
                }
                const fields = listFields(fieldIds);
                const page = await search(issueJql(collection, filter, query), fields, { nextPageToken: cursor || undefined });
                let issues = page.issues;
                // The summary search does not match the key. On the first page, a query such as "ENG-12" also gets that issue.
                if (!cursor && isIssueKey(query)) {
                    const issue = await jira('GET', `/issue/${encodeURIComponent(query.trim().toUpperCase())}`, { query: { fields: fields.join(',') } }).catch(
                        () => undefined
                    );
                    if (issue && String(issue.fields?.project?.id) === String(collection) && !issues.some(item => item.id === issue.id)) {
                        issues = [issue, ...issues];
                    }
                }
                return { tasks: issues.map(issue => toTask(issue, { site, fieldIds })), nextCursor: page.nextPageToken };
            },

            async getTask({ id }) {
                return loadIssue(id);
            },

            /**
             * Makes an issue of the type "Task" in the project. With `parent`, the issue is a subtask in the project of the
             * parent. With `status`, a transition moves the new issue to that status.
             */
            async createTask({ collection, title, description, status, parent }) {
                const summary = String(title ?? '').trim();
                if (!summary) {
                    throw new Error('An issue must have a summary.');
                }
                let projectId = collection;
                if (parent) {
                    const parentIssue = await jira('GET', `/issue/${encodeURIComponent(parent)}`, { query: { fields: 'project' } });
                    projectId = parentIssue.fields.project.id;
                }
                if (!projectId) {
                    throw new Error('Select a Jira project.');
                }
                const types = await cached(optionCache, `types:${projectId}`, () =>
                    offsetPages(`/issue/createmeta/${encodeURIComponent(projectId)}/issuetypes`, {}, page => page.issueTypes ?? page.values ?? [])
                );
                const issueType = pickIssueType(types, { subtask: !!parent });
                const fields = {
                    project: { id: String(projectId) },
                    issuetype: { id: String(issueType.id) },
                    summary,
                    ...(description ? { description: markdownToAdf(description) } : {}),
                    ...(parent ? { parent: { id: String(parent) } } : {})
                };
                const created = await jira('POST', '/issue', { body: { fields } });
                if (status) {
                    await transition(created.id, status).catch(error => log(`The plugin cannot move the new issue to the status: ${error.message}`));
                }
                return loadIssue(created.id);
            },

            /** Changes the status with a transition. Changes the summary, the description, the assignee, the labels, the priority, or the due date. */
            async updateTask(params) {
                const { id, status, ...rest } = params;
                const fields = issueFields(rest);
                if (status) {
                    await transition(id, status);
                }
                if (Object.keys(fields).length > 0) {
                    await jira('PUT', `/issue/${encodeURIComponent(id)}`, { query: { notifyUsers: 'true' }, body: { fields } });
                }
                return loadIssue(id);
            },

            /**
             * The choices for a part of an issue. The assignees: the users that Jira lets you assign. The labels: the labels
             * of the site, and the user can type a new label. The priority: the priorities of the site.
             */
            async listOptions({ id, part }) {
                if (part === 'assignees') {
                    return { options: await cached(issuePeople, id, () => assignableUsers({ issueKey: id })) };
                }
                if (part === 'labels') {
                    const labels = await cached(optionCache, 'labels', () => offsetPages('/label', {}));
                    return { options: labels.map(toLabel), create: true };
                }
                if (part === 'priority') {
                    const priorities = await cached(optionCache, 'priorities', () => offsetPages('/priority/search', {}));
                    return { options: priorityOptions(priorities) };
                }
                throw new Error(`Jira issues have no options for "${part}".`);
            },

            /** The users that Jira lets you assign in the project. */
            async listPeople({ collection }) {
                const people = await cached(projectPeople, collection, () => assignableUsers({ project: collection }));
                return { people, me: me.accountId };
            },

            /** The statuses of all issue types of the project, in category order. */
            async statusOrder({ collection }) {
                const statuses = await cached(projectStatuses, collection, async () =>
                    projectStatusOrder(await jira('GET', `/project/${encodeURIComponent(collection)}/statuses`))
                );
                return { statuses };
            },

            /** The statuses that an issue can go to: its status and the targets of its transitions in the workflow. */
            async listStatuses({ id }) {
                if (!id) {
                    return [];
                }
                const [data, issue] = await Promise.all([
                    jira('GET', `/issue/${encodeURIComponent(id)}/transitions`),
                    jira('GET', `/issue/${encodeURIComponent(id)}`, { query: { fields: 'status' } })
                ]);
                return transitionStatuses(issue.fields?.status, data?.transitions);
            },

            async listComments({ taskId }) {
                const comments = await offsetPages(`/issue/${encodeURIComponent(taskId)}/comment`, { orderBy: 'created' }, page => page.comments ?? []);
                return oldestFirst(comments).map(toComment);
            },

            /** Adds a comment. A mention becomes a native Jira mention, so Jira notifies the person. */
            async createComment({ taskId, body, mentions }) {
                const adf = markdownToAdf(body, { mentions });
                if (!adf) {
                    throw new Error('A comment must have text.');
                }
                const comment = await jira('POST', `/issue/${encodeURIComponent(taskId)}/comment`, { body: { body: adf } });
                return toComment(comment);
            },

            async runAction({ taskId, actionId }) {
                switch (actionId) {
                    case 'assign-me':
                        await jira('PUT', `/issue/${encodeURIComponent(taskId)}/assignee`, { body: { accountId: me.accountId } });
                        return { message: 'The issue is assigned to you.' };
                    case 'unassign':
                        await jira('PUT', `/issue/${encodeURIComponent(taskId)}/assignee`, { body: { accountId: null } });
                        return { message: 'The issue has no assignee now.' };
                    default:
                        throw new Error(`The action "${actionId}" does not exist for Jira issues.`);
                }
            },

            /** The Dashboard: comments from other people on the issues assigned to the user, newer than `since`. One search reads them. */
            async listActivity({ since }) {
                const sinceMs = Date.parse(since);
                if (!Number.isFinite(sinceMs)) {
                    throw new Error('activity/list needs "since" as an ISO time.');
                }
                const page = await search(activityJql(sinceMs, now(), scopeIds), ['summary', 'comment'], { maxResults: ACTIVITY_ISSUES });
                return { comments: activityComments(page.issues, site, me.accountId, sinceMs) };
            }
        }
    };
}
