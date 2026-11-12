// A ShipWarden task plugin for Azure Boards (Azure DevOps work items). Each Azure DevOps project is a collection.
// The plugin uses the Azure DevOps REST API, version 7.1, and WIQL queries.
import { execFile } from 'node:child_process';
import { log, networkDetail, runPlugin } from '../sdk/index.js';
import {
    activityQuery,
    closedStateNames,
    editableParts,
    FIELDS,
    hierarchyIds,
    LIST_FIELDS,
    listQuery,
    memberOptions,
    mergeStates,
    newComments,
    newItemType,
    PARENT_RELATION,
    parseOrganization,
    PRIORITIES,
    projectOfRemote,
    sortComments,
    toComment,
    toDetails,
    toTask,
    visibleTypes,
    workItemPatch
} from './map.js';

const API_VERSION = '7.1';
/** The comments API and the tags API have only preview versions in 7.1. */
const COMMENTS_API_VERSION = '7.1-preview.4';
const TAGS_API_VERSION = '7.1-preview.1';
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
/** The repository roots of the ShipWarden projects. */
let repositoryRoots = [];

/** All projects of the organization, with the time of the load. */
let projectsCache;
/** The work item types and states of each project, with the time of the load. The key is the project ID or name in lowercase. */
const projectMeta = new Map();
/** The project name of each work item ID. The comments API needs the project. */
const projectOfItem = new Map();
/** The comments of each work item, with the "System.ChangedDate" of the work item at the load. */
const commentCache = new Map();
/** The work item type of each work item ID: { project, type }. */
const typeOfItem = new Map();
/** The field reference names of each work item type. The key is "project|type" in lowercase. */
const typeFieldCache = new Map();
/** The tags of each project. */
const tagCache = new Map();
/** The members of the teams of each project. */
const memberCache = new Map();

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
        categories: categories.value ?? [],
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

/** Returns a set of the field reference names of a work item type. The plugin keeps it for 10 minutes. */
function fieldsOfType(projectName, type) {
    return cached(typeFieldCache, `${projectName}|${type}`.toLowerCase(), async () => {
        const result = await azure('GET', `/${project(projectName)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/fields?api-version=${API_VERSION}`);
        return new Set((result.value ?? []).map(field => field.referenceName));
    });
}

/**
 * Returns the field reference names of the type of a work item. When Azure does not give them, the result has only
 * the fields of the work item that have a value.
 */
function fieldsOfItem(item) {
    const fields = item.fields ?? {};
    const fallback = new Set(Object.keys(fields));
    if (!fields['System.TeamProject'] || !fields['System.WorkItemType']) {
        return Promise.resolve(fallback);
    }
    return fieldsOfType(fields['System.TeamProject'], fields['System.WorkItemType']).catch(error => {
        log(`The plugin cannot read the fields of the type "${fields['System.WorkItemType']}": ${error.message}`);
        return fallback;
    });
}

/**
 * Converts a work item to a task, with the colors and categories of its type's states. `full` also adds the
 * description, the details and the editable parts.
 */
async function workItemTask(item, full) {
    const fields = item.fields ?? {};
    const projectName = fields['System.TeamProject'];
    if (projectName) {
        projectOfItem.set(String(item.id), projectName);
        if (fields['System.WorkItemType']) {
            typeOfItem.set(String(item.id), { project: projectName, type: fields['System.WorkItemType'] });
        }
    }
    const [states, typeFields] = await Promise.all([
        projectName && fields['System.WorkItemType'] ? statesOfType(projectName, fields['System.WorkItemType']).catch(() => undefined) : undefined,
        full ? fieldsOfItem(item) : undefined
    ]);
    const task = toTask(item, { baseUrl, states, withDescription: full });
    if (!full) {
        return task;
    }
    return { ...task, details: { ...toDetails(item), ...(await relatedOf(item)) }, editable: editableParts(item, typeFields) };
}

/**
 * Returns the parent and the child work items of a work item as task references. The work item must have
 * "$expand=relations". One batch request reads the related work items. A failure gives no references and no error.
 */
async function relatedOf(item) {
    const { parent, children } = hierarchyIds(item);
    const ids = [...(parent ? [parent] : []), ...children];
    if (ids.length === 0) {
        return {};
    }
    try {
        const refs = new Map();
        for (const related of await workItems(ids)) {
            const task = await workItemTask(related, false);
            refs.set(Number(task.id), { id: task.id, key: task.key, title: task.title, url: task.url, status: task.status, assignees: task.assignees });
        }
        const subtasks = children.map(id => refs.get(id)).filter(Boolean);
        return { ...(parent && refs.has(parent) ? { parent: refs.get(parent) } : {}), ...(subtasks.length ? { subtasks } : {}) };
    } catch (error) {
        log(`The plugin cannot read the related work items of ${item.id}: ${error.message}`);
        return {};
    }
}

/** Reads one work item with its relations. */
function readWorkItem(number) {
    return azure('GET', `/_apis/wit/workitems/${number}?$expand=relations&api-version=${API_VERSION}`);
}

/** Returns the field reference names of the type of a work item, from its ID. */
async function fieldsOfId(number) {
    let known = typeOfItem.get(String(number));
    if (!known) {
        const item = await azure('GET', `/_apis/wit/workitems/${number}?fields=System.TeamProject,System.WorkItemType&api-version=${API_VERSION}`);
        known = { project: item.fields['System.TeamProject'], type: item.fields['System.WorkItemType'] };
        typeOfItem.set(String(number), known);
        projectOfItem.set(String(number), known.project);
    }
    return fieldsOfType(known.project, known.type).catch(error => {
        // Without the fields, the plugin sends the change. Azure then refuses a field that the type does not have.
        log(`The plugin cannot read the fields of the type "${known.type}": ${error.message}`);
        return new Set(Object.values(FIELDS));
    });
}

/** Returns the tag names of a project. The plugin keeps them for 10 minutes. */
function tagsOf(projectName) {
    return cached(tagCache, projectName.toLowerCase(), async () => {
        const result = await azure('GET', `/${project(projectName)}/_apis/wit/tags?api-version=${TAGS_API_VERSION}`);
        return (result.value ?? []).map(tag => tag.name).sort((a, b) => a.localeCompare(b));
    });
}

/** Returns the members of all teams of a project as options. The plugin keeps them for 10 minutes. */
function membersOf(projectName) {
    return cached(memberCache, projectName.toLowerCase(), async () => {
        const teams = (await azure('GET', `/_apis/projects/${project(projectName)}/teams?$top=100&api-version=${API_VERSION}`)).value ?? [];
        const lists = await eachLimited(teams, 4, team =>
            azure('GET', `/_apis/projects/${project(projectName)}/teams/${team.id}/members?$top=1000&api-version=${API_VERSION}`).then(
                result => result.value ?? [],
                () => []
            )
        );
        return memberOptions(lists);
    });
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

/** Sends JSON Patch operations to a work item and returns the changed work item. */
async function patchOperations(id, operations) {
    return azure('PATCH', `/_apis/wit/workitems/${id}?$expand=relations&api-version=${API_VERSION}`, operations, {
        contentType: 'application/json-patch+json'
    });
}

/** Changes fields of a work item. `changes` maps a field reference name to its new value. */
async function patchWorkItem(id, changes) {
    return patchOperations(
        id,
        Object.entries(changes).map(([field, value]) => ({ op: 'add', path: `/fields/${field}`, value }))
    );
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
            capabilities: { edit: true, subtasks: true },
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
     * of a ShipWarden project, is the default.
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
        return workItemTask(await readWorkItem(workItemId(id)), true);
    },

    /**
     * Makes a work item in a project. The type is the default requirement type of the project, for example
     * "User Story". With `parent`, the work item is a child of the parent, with the default task type (for example
     * "Task") and the area and the iteration of the parent, as in the Azure Boards web app.
     */
    async createTask({ collection, title, description, status, parent }) {
        const parentItem = parent
            ? await azure(
                  'GET',
                  `/_apis/wit/workitems/${workItemId(parent)}?fields=System.TeamProject,System.AreaPath,System.IterationPath&api-version=${API_VERSION}`
              )
            : undefined;
        const projectKey = parentItem?.fields?.['System.TeamProject'] ?? collection;
        if (!projectKey) {
            throw new Error('Select an Azure DevOps project.');
        }
        const meta = await metadata(projectKey);
        const type = newItemType(meta.categories, meta.types, !!parent);
        const typeFields = await fieldsOfType(projectKey, type).catch(() => new Set(Object.values(FIELDS)));
        const placement = [];
        if (parentItem) {
            for (const field of ['System.AreaPath', 'System.IterationPath']) {
                if (parentItem.fields?.[field]) placement.push({ op: 'add', path: `/fields/${field}`, value: parentItem.fields[field] });
            }
            placement.push({ op: 'add', path: '/relations/-', value: { rel: PARENT_RELATION, url: `${baseUrl}/_apis/wit/workItems/${parentItem.id}` } });
        } else if (areaPath) {
            // The area path setting limits the task list. A new work item goes into it, so the list shows it.
            const known = projectsCache?.projects.find(item => item.id === projectKey || item.name.toLowerCase() === String(projectKey).toLowerCase());
            if (known && areaPath.split('\\')[0].toLowerCase() === known.name.toLowerCase()) {
                placement.push({ op: 'add', path: '/fields/System.AreaPath', value: areaPath });
            }
        }
        const operations = htmlDescription => [
            ...workItemPatch({ title, description: description || undefined, status }, typeFields, { htmlDescription }),
            ...placement
        ];
        const path = `/${project(projectKey)}/_apis/wit/workitems/$${encodeURIComponent(type)}?$expand=relations&api-version=${API_VERSION}`;
        const send = htmlDescription => azure('POST', path, operations(htmlDescription), { contentType: 'application/json-patch+json' });
        let item;
        try {
            item = await send(false);
        } catch (error) {
            if (!description) {
                throw error;
            }
            log(`Azure DevOps did not accept the description as Markdown. The plugin sends it as HTML. ${error.message}`);
            item = await send(true);
        }
        return workItemTask(item, true);
    },

    /**
     * Changes the state, the title, the description, the assignee, the tags, the priority, the dates or the estimate.
     * The status ID is the state name. The description goes to the field as Markdown. When Azure does not accept
     * Markdown, the plugin sends it again as simple HTML.
     */
    async updateTask(params) {
        const number = workItemId(params.id);
        const typeFields = await fieldsOfId(number);
        const operations = workItemPatch(params, typeFields);
        if (operations.length === 0) {
            return workItemTask(await readWorkItem(number), true);
        }
        let item;
        try {
            item = await patchOperations(number, operations);
        } catch (error) {
            if (params.description === undefined) {
                throw error;
            }
            log(`Azure DevOps did not accept the description as Markdown. The plugin sends it as HTML. ${error.message}`);
            item = await patchOperations(number, workItemPatch(params, typeFields, { htmlDescription: true }));
        }
        return workItemTask(item, true);
    },

    /**
     * The choices for a part of a work item. The assignees: the members of the teams of the project. The labels: the
     * tags of the project. The user can type a new tag, because Azure makes a tag when a work item gets it.
     * The priority: the four levels of the standard processes.
     */
    async listOptions({ id, part }) {
        if (part === 'priority') {
            return { options: PRIORITIES };
        }
        const projectName = await projectOf(workItemId(id));
        if (part === 'labels') {
            return { options: (await tagsOf(projectName)).map(name => ({ id: name, name })), create: true };
        }
        if (part === 'assignees') {
            return { options: await membersOf(projectName) };
        }
        throw new Error(`Azure DevOps work items have no options for "${part}".`);
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
