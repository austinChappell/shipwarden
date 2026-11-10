// A ShipWarden task plugin for Azure Boards (Azure DevOps work items). Each Azure DevOps project is a collection.
// The plugin uses the Azure DevOps REST API, version 7.1, and WIQL queries.
import { execFile } from 'node:child_process';
import { log, networkDetail, runPlugin } from '../sdk/index.js';
import {
    activityQuery,
    closedStateNames,
    LIST_FIELDS,
    listQuery,
    mergeStates,
    newComments,
    parseOrganization,
    projectOfRemote,
    sortComments,
    toComment,
    toTask,
    visibleTypes
} from './map.js';

const API_VERSION = '7.1';
/** The comments API has only preview versions in 7.1. */
const COMMENTS_API_VERSION = '7.1-preview.4';
const PAGE_SIZE = 100;
/** WIQL returns at most this number of work item IDs for the task list. */
const QUERY_LIMIT = 1000;
/** The batch API accepts at most 200 IDs in one request. */
const BATCH_LIMIT = 200;
/** The Dashboard reads the comments of this number of recently changed work items, at most. */
const ACTIVITY_TASKS = 40;
const CACHE_MS = 10 * 60 * 1000;

/** The base URL of the organization, for example "https://dev.azure.com/contoso". */
let baseUrl;
let authorization;
/** The user of the token: { id, name, uniqueName }. */
let me;
/** The project IDs in the connection's scope. Undefined means all projects. */
let scope;
let areaPath;
/** The repository roots of the ShipWarden project. */
let repositoryRoots = [];

/** All projects of the organization, with the time of the load. */
let projectsCache;
/** The work item types and states of each project, with the time of the load. The key is the project ID or name in lowercase. */
const projectMeta = new Map();
/** The project name of each work item ID. The comments API needs the project. */
const projectOfItem = new Map();
/** The comments of each work item, with the "System.ChangedDate" of the work item at the load. */
const commentCache = new Map();

let connection;

/** Sends a request to the Azure DevOps REST API. `path` starts with "/" and is relative to the organization URL. */
async function azure(method, path, body, { contentType = 'application/json', withHeaders = false } = {}) {
    let response;
    try {
        response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                Authorization: authorization,
                Accept: 'application/json',
                ...(body !== undefined ? { 'Content-Type': contentType } : {})
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            // Azure sends a sign-in page with a redirect when it does not accept the token.
            redirect: 'manual'
        });
    } catch (error) {
        throw new Error(`ShipWarden cannot connect to Azure DevOps: ${networkDetail(error)}`);
    }
    const isJson = (response.headers.get('content-type') ?? '').includes('json');
    // Azure DevOps answers 203 with an HTML sign-in page for a token that is not valid.
    if (
        response.status === 401 ||
        response.status === 203 ||
        (response.status >= 300 && response.status < 400) ||
        (response.ok && !isJson && response.status !== 204)
    ) {
        throw new Error(
            'Azure DevOps did not accept the personal access token. Make sure that the token is for this organization, that it did not expire, and that it has the scope "Work Items (Read & write)".'
        );
    }
    if (!response.ok) {
        let detail = '';
        try {
            detail = (await response.json()).message ?? '';
        } catch {
            // The error has no JSON body.
        }
        if (response.status === 404 && !detail) {
            detail = 'Make sure that the organization is correct.';
        }
        throw new Error(`Azure DevOps returned ${response.status} for ${method} ${path.split('?')[0]}. ${detail}`.trim());
    }
    const result = response.status === 204 ? null : await response.json();
    return withHeaders ? { result, headers: response.headers } : result;
}

function project(name) {
    return encodeURIComponent(name);
}

/** Runs `work` for each item, with at most `limit` at the same time. */
async function eachLimited(items, limit, work) {
    const results = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const index = next++;
                results[index] = await work(items[index]);
            }
        })
    );
    return results;
}

/** Returns all projects of the organization. The plugin keeps them for 10 minutes. */
async function allProjects() {
    if (projectsCache && Date.now() - projectsCache.at < CACHE_MS) {
        return projectsCache.projects;
    }
    const projects = [];
    let token;
    for (let page = 0; page < 10; page++) {
        const continuation = token ? `&continuationToken=${encodeURIComponent(token)}` : '';
        const { result, headers } = await azure('GET', `/_apis/projects?stateFilter=wellFormed&$top=500${continuation}&api-version=${API_VERSION}`, undefined, {
            withHeaders: true
        });
        projects.push(...(result.value ?? []));
        token = headers.get('x-ms-continuationtoken');
        if (!token) {
            break;
        }
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    projectsCache = { projects, at: Date.now() };
    return projects;
}

/** Returns the projects in the connection's scope. */
async function scopedProjects() {
    const projects = await allProjects();
    if (!scope) {
        return projects;
    }
    const selected = projects.filter(item => scope.includes(item.id));
    if (selected.length === 0) {
        throw new Error('The token has no access to the selected Azure DevOps projects. Change the projects in Settings > Task managers.');
    }
    return selected;
}

/**
 * Returns the work item types of a project and the states of each type. The plugin keeps them for 10 minutes.
 * Result: { types: string[], states: Map<type in lowercase, state[]>, statuses, closedStates }.
 */
async function metadata(projectKey) {
    // A project name and a project ID use one cache entry when the project list is known.
    const known = projectsCache?.projects.find(item => item.id === projectKey || item.name.toLowerCase() === String(projectKey).toLowerCase());
    const key = (known?.id ?? String(projectKey)).toLowerCase();
    const cached = projectMeta.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
        return cached.meta;
    }
    const [types, categories] = await Promise.all([
        azure('GET', `/${project(projectKey)}/_apis/wit/workitemtypes?api-version=${API_VERSION}`),
        azure('GET', `/${project(projectKey)}/_apis/wit/workitemtypecategories?api-version=${API_VERSION}`).catch(() => ({ value: [] }))
    ]);
    const names = visibleTypes(types.value, categories.value);
    const typeStates = await eachLimited(names, 4, name =>
        azure('GET', `/${project(projectKey)}/_apis/wit/workitemtypes/${encodeURIComponent(name)}/states?api-version=${API_VERSION}`).then(
            result => result.value ?? [],
            () => []
        )
    );
    const meta = {
        types: names,
        states: new Map(names.map((name, index) => [name.toLowerCase(), typeStates[index]])),
        statuses: mergeStates(typeStates),
        closedStates: closedStateNames(typeStates)
    };
    projectMeta.set(key, { meta, at: Date.now() });
    return meta;
}

/** Returns the states of one work item type. A type outside the visible types gets its own request. */
async function statesOfType(projectKey, type) {
    const meta = await metadata(projectKey);
    const known = meta.states.get(String(type).toLowerCase());
    if (known) {
        return known;
    }
    const result = await azure('GET', `/${project(projectKey)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?api-version=${API_VERSION}`);
    return result.value ?? [];
}

/** Converts a work item to a task, with the colors and categories of its type's states. */
async function workItemTask(item, withDescription) {
    const fields = item.fields ?? {};
    const projectName = fields['System.TeamProject'];
    if (projectName) {
        projectOfItem.set(String(item.id), projectName);
    }
    const states =
        projectName && fields['System.WorkItemType'] ? await statesOfType(projectName, fields['System.WorkItemType']).catch(() => undefined) : undefined;
    return toTask(item, { baseUrl, states, withDescription });
}

/** Reads the work items with the IDs, in the order of the IDs. */
async function workItems(ids) {
    const items = [];
    for (let start = 0; start < ids.length; start += BATCH_LIMIT) {
        const chunk = ids.slice(start, start + BATCH_LIMIT);
        const result = await azure('POST', `/_apis/wit/workitemsbatch?api-version=${API_VERSION}`, { ids: chunk, fields: LIST_FIELDS, errorPolicy: 'omit' });
        items.push(...(result.value ?? []).filter(Boolean));
    }
    const byId = new Map(items.map(item => [item.id, item]));
    return ids.map(id => byId.get(id)).filter(Boolean);
}

function workItemId(id) {
    const number = Number(String(id).replace(/^(?:AB)?#/i, ''));
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`The task ID "${id}" is not valid. An Azure DevOps task ID is a work item number.`);
    }
    return number;
}

/** Returns the project name of a work item. */
async function projectOf(id) {
    const known = projectOfItem.get(String(id));
    if (known) {
        return known;
    }
    const item = await azure('GET', `/_apis/wit/workitems/${id}?fields=System.TeamProject&api-version=${API_VERSION}`);
    const name = item.fields['System.TeamProject'];
    projectOfItem.set(String(id), name);
    return name;
}

/** Changes fields of a work item. `changes` maps a field reference name to its new value. */
async function patchWorkItem(id, changes) {
    const operations = Object.entries(changes).map(([field, value]) => ({ op: 'add', path: `/fields/${field}`, value }));
    return azure('PATCH', `/_apis/wit/workitems/${id}?api-version=${API_VERSION}`, operations, { contentType: 'application/json-patch+json' });
}

async function listComments(projectName, id) {
    const result = await azure('GET', `/${project(projectName)}/_apis/wit/workItems/${id}/comments?$top=200&api-version=${COMMENTS_API_VERSION}`);
    return sortComments(result.comments);
}

/** Returns the "origin" remote URL of a git repository, or undefined. */
function originUrl(root) {
    return new Promise(resolve => {
        execFile('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
    });
}

/** Finds the project to select first: the project of the area path setting, else the project of an Azure Repos remote. */
async function preferredProject() {
    if (areaPath) {
        return areaPath.split('\\')[0];
    }
    for (const root of repositoryRoots) {
        const name = projectOfRemote(await originUrl(root));
        if (name) {
            return name;
        }
    }
    return undefined;
}

connection = runPlugin({
    async initialize({ settings, scope: selected, context }) {
        const organization = parseOrganization(settings.organization);
        baseUrl = organization.baseUrl;
        const token = String(settings.token ?? '').trim();
        if (!token) {
            throw new Error('The Azure DevOps connection needs a personal access token. Add it in Settings > Task managers.');
        }
        authorization = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
        areaPath = typeof settings.areaPath === 'string' && settings.areaPath.trim() ? settings.areaPath.trim().replace(/\//g, '\\') : undefined;
        scope = selected && selected.length > 0 ? selected : undefined;
        repositoryRoots = (context?.repositories ?? []).map(repo => repo.root);
        const data = await azure('GET', '/_apis/connectionData');
        const user = data.authenticatedUser ?? {};
        me = {
            id: user.id,
            name: user.providerDisplayName ?? user.customDisplayName,
            uniqueName: user.properties?.Account?.$value ?? user.providerDisplayName
        };
        log(`Azure DevOps plugin ready for ${baseUrl} as ${me.name ?? 'an unknown user'}.`);
        return {
            fields: [
                { id: 'type', label: 'Type', type: 'text' },
                { id: 'area', label: 'Area', type: 'text' },
                { id: 'iteration', label: 'Iteration', type: 'text' }
            ],
            actions: [{ id: 'assign-me', label: 'Assign to me' }],
            filters: [
                { id: 'assigned', label: 'Assigned to me', default: true },
                { id: 'open', label: 'All open work items' },
                { id: 'all', label: 'All work items, with closed' }
            ]
        };
    },

    /** The projects of the organization. The settings page lets the user restrict the connection to some of them. */
    async listScopes() {
        return (await allProjects()).map(item => ({ id: item.id, name: item.name, detail: item.description || undefined }));
    },

    /**
     * Each project in the scope is a collection. The project of the area path setting, or of an Azure Repos remote
     * of the ShipWarden project, is the default.
     */
    async listCollections() {
        const projects = await scopedProjects();
        const preferred = (await preferredProject())?.toLowerCase();
        return projects.map(item => ({
            id: item.id,
            name: item.name,
            url: `${baseUrl}/${project(item.name)}/_workitems`,
            ...(item.name.toLowerCase() === preferred ? { default: true } : {})
        }));
    },

    async listTasks({ collection, filter = 'assigned', query, cursor }) {
        if (!collection) {
            throw new Error('Select an Azure DevOps project.');
        }
        const meta = await metadata(collection);
        const wiql = listQuery({ filter, query, closedStates: meta.closedStates, areaPath, types: meta.types });
        const result = await azure('POST', `/${project(collection)}/_apis/wit/wiql?$top=${QUERY_LIMIT}&api-version=${API_VERSION}`, { query: wiql });
        const ids = (result.workItems ?? []).map(item => item.id);
        const start = Number(cursor ?? 0);
        const page = await workItems(ids.slice(start, start + PAGE_SIZE));
        return {
            tasks: await Promise.all(page.map(item => workItemTask(item, false))),
            nextCursor: start + PAGE_SIZE < ids.length ? String(start + PAGE_SIZE) : undefined
        };
    },

    async getTask({ id }) {
        return workItemTask(await azure('GET', `/_apis/wit/workitems/${workItemId(id)}?api-version=${API_VERSION}`), true);
    },

    /** The status ID is the state name. */
    async updateTask({ id, status }) {
        const number = workItemId(id);
        const item = status
            ? await patchWorkItem(number, { 'System.State': status })
            : await azure('GET', `/_apis/wit/workitems/${number}?api-version=${API_VERSION}`);
        return workItemTask(item, true);
    },

    /** The statuses come from the work item type of the task, because each type has its own states. */
    async listStatuses({ id }) {
        if (!id) {
            return [];
        }
        const number = workItemId(id);
        const item = await azure('GET', `/_apis/wit/workitems/${number}?fields=System.TeamProject,System.WorkItemType&api-version=${API_VERSION}`);
        const states = await statesOfType(item.fields['System.TeamProject'], item.fields['System.WorkItemType']);
        return mergeStates([states]);
    },

    /** The states of all work item types of the project, in workflow order. */
    async statusOrder({ collection }) {
        return { statuses: (await metadata(collection)).statuses };
    },

    async listComments({ taskId }) {
        const number = workItemId(taskId);
        return (await listComments(await projectOf(number), number)).map(toComment);
    },

    async createComment({ taskId, body }) {
        const number = workItemId(taskId);
        const created = await azure(
            'POST',
            `/${project(await projectOf(number))}/_apis/wit/workItems/${number}/comments?format=markdown&api-version=${COMMENTS_API_VERSION}`,
            { text: body }
        );
        return toComment({ format: 'markdown', ...created, text: created.text ?? body });
    },

    async runAction({ taskId, actionId }) {
        const number = workItemId(taskId);
        if (actionId !== 'assign-me') {
            throw new Error(`The action "${actionId}" does not exist for Azure DevOps.`);
        }
        if (!me?.uniqueName) {
            throw new Error('Azure DevOps did not give the user of the token. ShipWarden cannot assign the work item.');
        }
        await patchWorkItem(number, { 'System.AssignedTo': me.uniqueName });
        connection.notify('tasks/changed', { ids: [String(number)] });
        return { message: `Work item ${number} is assigned to you.` };
    },

    /**
     * The Dashboard: comments from other people on the work items assigned to the user, newer than `since`.
     * The plugin reads the comments of the assigned work items that changed after `since`.
     */
    async listActivity({ since }) {
        if (!Number.isFinite(Date.parse(since))) {
            throw new Error('activity/list needs "since" as an ISO time.');
        }
        const projectNames = scope ? (await scopedProjects()).map(item => item.name) : undefined;
        const result = await azure('POST', `/_apis/wit/wiql?timePrecision=true&$top=${ACTIVITY_TASKS}&api-version=${API_VERSION}`, {
            query: activityQuery(since, projectNames)
        });
        const items = await workItems((result.workItems ?? []).map(item => item.id).slice(0, ACTIVITY_TASKS));
        const perItem = await eachLimited(items, 4, async item => {
            const fields = item.fields;
            const changed = fields['System.ChangedDate'];
            const cached = commentCache.get(item.id);
            let comments = cached?.changed === changed ? cached.comments : undefined;
            if (!comments) {
                comments = await listComments(fields['System.TeamProject'], item.id).catch(() => []);
                commentCache.set(item.id, { changed, comments });
            }
            const task = toTask(item, { baseUrl });
            return newComments(comments, me?.id, since).map(comment => {
                const mapped = toComment(comment);
                return {
                    id: `${item.id}-${mapped.id}`,
                    taskId: task.id,
                    taskKey: task.key,
                    taskTitle: task.title,
                    taskUrl: task.url,
                    author: mapped.author?.name,
                    body: mapped.body,
                    createdAt: comment.createdDate
                };
            });
        });
        return { comments: perItem.flat() };
    }
});
