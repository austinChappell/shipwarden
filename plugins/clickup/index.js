// A ShipWarden task plugin for ClickUp. Each ClickUp list is a collection.
import { log, networkDetail, runPlugin } from '../sdk/index.js';
import {
    busiestList,
    commentParts,
    customFieldRequest,
    dayToMilliseconds,
    EDITABLE,
    listChange,
    listStatusOrder,
    matchesQuery,
    parseChecklistItemId,
    plainComment,
    PRIORITIES,
    rateLimitWait,
    toCollections,
    toComment,
    toDetails,
    toLabel,
    toPerson,
    toStatus,
    toTask
} from './map.js';

const API = 'https://api.clickup.com/api/v2';

let token;
let userId;
/** All workspaces (ClickUp "teams") of the token. The settings page lists them as scopes. */
let allTeams = [];
/** The workspaces in the connection's scope. Without a scope, all workspaces. */
let teams = [];

/**
 * The collections, with the time of the load. The hierarchy needs two requests for each space, and ClickUp allows
 * 100 requests per minute, so the plugin keeps the result for 10 minutes.
 */
let collectionsCache;
/** The load of the collections that runs now. A second request at the same time waits for it and sends no requests of its own. */
let collectionsLoad;
/** The statuses of each list, with the time of the load. */
const listStatuses = new Map();
const LIST_CACHE_MS = 10 * 60 * 1000;
/** The members of each list, with the time of the load. */
const listMembers = new Map();
/** The tags of each space, with the time of the load. */
const spaceTags = new Map();
/** The list and the space of each task that the plugin loaded. The options of a task need them, so they need no new request. */
const taskPlaces = new Map();
/** The comments of each task, with the "date_updated" of the task at the load. A task without a change needs no new request. */
const commentCache = new Map();
/** The number of times that a request is sent again after a 429 response. */
const RATE_LIMIT_RETRIES = 2;
/** The longest wait after a 429 response. If the reset time is later, the request fails. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** The longest wait after a 429 response during "initialize". ShipWarden stops a plugin that does not answer "initialize" in 30 seconds. */
const MAX_INITIALIZE_WAIT_MS = 20_000;
/** The number of spaces that the plugin reads at the same time. Each space needs two requests. */
const SPACE_CONCURRENCY = 3;
/** The Dashboard reads the comments of this number of recently changed tasks, at most, in each workspace. */
const ACTIVITY_TASKS = 40;

/** Returns the members of a ClickUp list. The plugin keeps them for 10 minutes. */
async function membersOfList(listId) {
    const cached = listMembers.get(listId);
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
        return cached.members;
    }
    const { members } = await clickup('GET', `/list/${listId}/member`);
    listMembers.set(listId, { members, at: Date.now() });
    return members;
}

/** The path of the list of a task, for example "Engineering / Projects / Sprint 12". It uses the loaded collections, so it sends no request. */
function locationOf(task) {
    const listId = task.list?.id === undefined ? undefined : String(task.list.id);
    const collection = collectionsCache?.collections.find(item => item.id === listId);
    if (collection) {
        return collection.path ? `${collection.path} / ${collection.name}` : collection.name;
    }
    const folder = task.folder && !task.folder.hidden ? task.folder.name : undefined;
    return [folder, task.list?.name].filter(Boolean).join(' / ') || undefined;
}

/** Remembers the list and the space of a ClickUp task. */
function rememberPlace(task) {
    if (task.list?.id) {
        taskPlaces.set(String(task.id), { listId: String(task.list.id), spaceId: task.space?.id ? String(task.space.id) : undefined });
    }
}

/** Returns the list and the space of a task. A task that the plugin did not load needs one request. */
async function placeOf(id) {
    if (!taskPlaces.has(String(id))) {
        rememberPlace(await clickup('GET', `/task/${id}`));
    }
    const place = taskPlaces.get(String(id));
    if (!place) {
        throw new Error('ClickUp did not send the list of the task.');
    }
    return place;
}

/** Returns the raw ClickUp task with its description and subtasks. */
async function fetchTask(id) {
    const task = await clickup('GET', `/task/${id}?include_markdown_description=true&include_subtasks=true`);
    rememberPlace(task);
    return task;
}

/** Converts a raw ClickUp task with the description, the details and the editable parts. */
function fullTask(task) {
    return { ...toTask(task, { withDescription: true }), details: toDetails(task, locationOf(task)), editable: EDITABLE };
}

/** Loads one task with its subtasks, and converts it with the description and the details. */
async function loadTask(id) {
    return fullTask(await fetchTask(id));
}

/** Returns the tags of a space. The plugin keeps them for 10 minutes. */
async function tagsOfSpace(spaceId) {
    const cached = spaceTags.get(spaceId);
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
        return cached.tags;
    }
    const { tags } = await clickup('GET', `/space/${spaceId}/tag`);
    spaceTags.set(spaceId, { tags, at: Date.now() });
    return tags;
}

/**
 * Changes the tags of a task to the names in `wanted`. A name that the space does not have becomes a new tag of the space.
 * ClickUp adds and removes one tag per request.
 */
async function setTags(task, wanted) {
    const { add, rem } = listChange(
        (task.tags ?? []).map(tag => tag.name),
        wanted
    );
    const spaceId = task.space?.id ? String(task.space.id) : undefined;
    if (add.length && spaceId) {
        const known = new Set((await tagsOfSpace(spaceId)).map(tag => tag.name.toLowerCase()));
        const missing = add.filter(name => !known.has(name.toLowerCase()));
        for (const name of missing) {
            await clickup('POST', `/space/${spaceId}/tag`, { tag: { name } });
        }
        if (missing.length) spaceTags.delete(spaceId);
    }
    for (const name of add) {
        await clickup('POST', `/task/${task.id}/tag/${encodeURIComponent(name)}`);
    }
    for (const name of rem) {
        await clickup('DELETE', `/task/${task.id}/tag/${encodeURIComponent(name)}`);
    }
}

/** Returns the comments of a task with the replies of each comment. */
async function commentsWithReplies(taskId) {
    const { comments } = await clickup('GET', `/task/${taskId}/comment`);
    const replies = await Promise.all(
        comments
            .filter(comment => Number(comment.reply_count) > 0)
            .slice(0, 10)
            .map(comment =>
                clickup('GET', `/comment/${comment.id}/reply`).then(
                    result => result.comments ?? [],
                    () => []
                )
            )
    );
    return [...comments, ...replies.flat()];
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

/** Returns the statuses of a ClickUp list. The plugin keeps them for 10 minutes. */
async function statusesOfList(listId) {
    const cached = listStatuses.get(listId);
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
        return cached.statuses;
    }
    const list = await clickup('GET', `/list/${listId}`);
    listStatuses.set(listId, { statuses: list.statuses, at: Date.now() });
    return list.statuses;
}

/**
 * Sends a request to the ClickUp API and returns the JSON body.
 * After a 429 response, the function waits until the rate limit resets and sends the request again.
 * It does this at most RATE_LIMIT_RETRIES times, and only when the wait is not longer than `maxWaitMs`.
 */
async function clickup(method, path, body, maxWaitMs = MAX_RATE_LIMIT_WAIT_MS) {
    let response;
    for (let attempt = 0; ; attempt++) {
        try {
            response = await fetch(`${API}${path}`, {
                method,
                headers: {
                    Authorization: token,
                    Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                body: body ? JSON.stringify(body) : undefined
            });
        } catch (error) {
            throw new Error(`ShipWarden cannot connect to ClickUp: ${networkDetail(error)}`);
        }
        if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) {
            break;
        }
        const wait = rateLimitWait(response.headers);
        if (wait > maxWaitMs) {
            break;
        }
        log(`ClickUp rate limit reached for ${method} ${path}. The plugin sends the request again in ${Math.ceil(wait / 1000)} seconds.`);
        await new Promise(resolve => setTimeout(resolve, wait));
    }
    if (!response.ok) {
        let detail = '';
        try {
            const error = await response.json();
            detail = error.err ?? error.error ?? '';
        } catch {
            // The error has no JSON body.
        }
        if (response.status === 401) {
            throw new Error(`ClickUp did not accept the API token. ${detail}`.trim());
        }
        throw new Error(`ClickUp returned ${response.status} for ${method} ${path}. ${detail}`.trim());
    }
    return response.json();
}

/**
 * Loads the lists of all spaces in the scope's workspaces as collections. The list with the most tasks of the user is the default.
 * Stores the result in collectionsCache.
 */
async function loadCollections() {
    const assignedTasks = [];
    const perTeam = await Promise.all(
        teams.map(async team => {
            const [{ spaces }, assigned] = await Promise.all([
                clickup('GET', `/team/${team.id}/space?archived=false`),
                clickup('GET', `/team/${team.id}/task?assignees[]=${userId}&order_by=updated&subtasks=true`).catch(() => ({ tasks: [] }))
            ]);
            assignedTasks.push(...assigned.tasks);
            const hierarchy = await eachLimited(spaces, SPACE_CONCURRENCY, async space => {
                const [folders, lists] = await Promise.all([
                    clickup('GET', `/space/${space.id}/folder?archived=false`),
                    clickup('GET', `/space/${space.id}/list?archived=false`)
                ]);
                return { space, folders: folders.folders, lists: lists.lists };
            });
            return { team, hierarchy };
        })
    );
    const busiest = busiestList(assignedTasks);
    const collections = perTeam.flatMap(({ team, hierarchy }) => toCollections(team.id, hierarchy, busiest, teams.length > 1 ? team.name : undefined));
    collectionsCache = { collections, at: Date.now() };
    return collections;
}

runPlugin({
    async initialize({ settings, scope }) {
        token = String(settings.apiToken ?? '').trim();
        if (!token) {
            throw new Error('The ClickUp connection needs an API token. Add it in Settings > Task managers.');
        }
        userId = (await clickup('GET', '/user', undefined, MAX_INITIALIZE_WAIT_MS)).user.id;
        allTeams = (await clickup('GET', '/team', undefined, MAX_INITIALIZE_WAIT_MS)).teams;
        if (allTeams.length === 0) {
            throw new Error('This ClickUp account has no workspace.');
        }
        teams = scope ? allTeams.filter(team => scope.includes(String(team.id))) : allTeams;
        if (teams.length === 0) {
            throw new Error('The token has no access to the selected ClickUp workspaces. Change the workspaces in Settings > Task managers.');
        }
        log(`ClickUp plugin ready for ${teams.map(team => `"${team.name}"`).join(', ')}.`);
        return {
            // The assignee filter of ShipWarden selects the people in the loaded tasks, so the filters select only open or closed tasks.
            capabilities: { edit: true, subtasks: true },
            filters: [
                { id: 'open', label: 'Open tasks', default: true },
                { id: 'closed', label: 'Closed tasks' },
                { id: 'all', label: 'Open and closed tasks' }
            ]
        };
    },

    /** The workspaces of the token. The settings page lets the user restrict the connection to some of them. */
    async listScopes() {
        return allTeams.map(team => ({ id: String(team.id), name: team.name }));
    },

    /**
     * Each ClickUp list in the scope's workspaces is a collection. With more than one workspace, the path starts with
     * the workspace name. The list with the most tasks of the user is the default.
     */
    async listCollections() {
        if (collectionsCache && Date.now() - collectionsCache.at < LIST_CACHE_MS) {
            return collectionsCache.collections;
        }
        collectionsLoad ??= loadCollections().finally(() => {
            collectionsLoad = undefined;
        });
        return collectionsLoad;
    },

    /** "open": the open tasks. "closed": the closed and done tasks. "all": both. ShipWarden filters the assignees itself. */
    async listTasks({ collection, filter = 'open', query, cursor }) {
        if (!collection) {
            throw new Error('Select a ClickUp list.');
        }
        const page = Number(cursor ?? 0);
        const includeClosed = filter === 'all' || filter === 'closed';
        // ClickUp sets "date_done" when a task gets a closed or done status, so "date_done_gt=0" gives only those tasks.
        const doneOnly = filter === 'closed' ? '&date_done_gt=0' : '';
        const result = await clickup('GET', `/list/${collection}/task?page=${page}&order_by=updated&subtasks=true&include_closed=${includeClosed}${doneOnly}`);
        const closed = task => task.status?.type === 'closed' || task.status?.type === 'done';
        for (const task of result.tasks) rememberPlace(task);
        return {
            tasks: result.tasks.filter(task => matchesQuery(task, query) && (filter !== 'closed' || closed(task))).map(task => toTask(task)),
            // ClickUp returns 100 tasks per page. "last_page" is true on the last page.
            nextCursor: result.last_page === false ? String(page + 1) : undefined
        };
    },

    async getTask({ id }) {
        return loadTask(id);
    },

    /**
     * Makes a task in a ClickUp list. With `parent`, the task is a subtask. ClickUp needs a subtask in the list of
     * its parent, so the plugin uses that list and not `collection`.
     */
    async createTask({ collection, title, description, status, parent }) {
        const name = String(title ?? '').trim();
        if (!name) throw new Error('A task must have a title.');
        const listId = parent ? (await placeOf(parent)).listId : collection;
        if (!listId) throw new Error('Select a ClickUp list.');
        const body = { name, ...(description ? { markdown_content: description } : {}), ...(status ? { status } : {}), ...(parent ? { parent } : {}) };
        const created = await clickup('POST', `/list/${listId}/task`, body);
        rememberPlace(created);
        // The response is the new task without its Markdown description. The plugin knows the description, so it sends no second request.
        return { ...fullTask(created), description: description ?? '' };
    },

    /**
     * Changes one or more parts of a task. The tags, the custom fields and the checklist items have their own
     * requests. The other parts go in one PUT request.
     */
    async updateTask(params) {
        const { id } = params;
        const body = {};
        if (params.status !== undefined) body.status = params.status;
        if (params.title !== undefined) {
            const name = String(params.title).trim();
            if (!name) throw new Error('A task must have a title.');
            body.name = name;
        }
        if (params.description !== undefined) body.markdown_content = params.description;
        if (params.priority !== undefined) body.priority = params.priority === null ? null : Number(params.priority);
        if (params.startDate !== undefined) {
            body.start_date = dayToMilliseconds(params.startDate);
            body.start_date_time = false;
        }
        if (params.dueDate !== undefined) {
            body.due_date = dayToMilliseconds(params.dueDate);
            body.due_date_time = false;
        }
        // ClickUp clears the estimate with 0.
        if (params.timeEstimate !== undefined) body.time_estimate = params.timeEstimate === null ? 0 : Math.round(params.timeEstimate);

        // The assignees, the tags and the custom fields change from their current values, so the plugin reads the task first.
        const needsCurrent = params.assignees !== undefined || params.labels !== undefined || params.customField !== undefined;
        const current = needsCurrent ? await fetchTask(id) : undefined;
        if (params.assignees !== undefined) {
            body.assignees = listChange(
                (current.assignees ?? []).map(user => user.id),
                params.assignees
            );
        }
        if (Object.keys(body).length) {
            await clickup('PUT', `/task/${id}`, body);
        }
        if (params.labels !== undefined) {
            await setTags(current, params.labels);
        }
        if (params.customField) {
            const field = (current.custom_fields ?? []).find(item => String(item.id) === params.customField.id);
            if (!field) throw new Error('The task does not have this custom field.');
            const request = customFieldRequest(field, params.customField.value);
            await (request.clear ? clickup('DELETE', `/task/${id}/field/${field.id}`) : clickup('POST', `/task/${id}/field/${field.id}`, request.body));
        }
        if (params.checklistItem) {
            const { checklistId, itemId } = parseChecklistItemId(params.checklistItem.id);
            await clickup('PUT', `/checklist/${checklistId}/checklist_item/${itemId}`, { resolved: params.checklistItem.done === true });
        }
        return loadTask(id);
    },

    /**
     * The choices for a part of a task. The assignees and a "people" field: the members of the list.
     * The labels: the tags of the space. The user can type a new tag. The priority: the four ClickUp priorities.
     */
    async listOptions({ id, part }) {
        if (part === 'priority') {
            return { options: PRIORITIES };
        }
        const place = await placeOf(id);
        if (part === 'labels') {
            if (!place.spaceId) return { options: [], create: true };
            const tags = await tagsOfSpace(place.spaceId);
            return { options: tags.map(tag => ({ id: tag.name, ...toLabel(tag) })), create: true };
        }
        if (part === 'assignees' || String(part).startsWith('custom:')) {
            const members = await membersOfList(place.listId);
            return { options: members.map(toPerson).filter(person => person.id) };
        }
        throw new Error(`The plugin has no options for "${part}".`);
    },

    /** The members of the list: the people that can be assignees of its tasks. */
    async listPeople({ collection }) {
        if (!collection) {
            return { people: [], me: String(userId) };
        }
        const members = await membersOfList(collection);
        return { people: members.map(toPerson), me: String(userId) };
    },

    /** The statuses of the list, in its workflow order. */
    async statusOrder({ collection }) {
        return { statuses: listStatusOrder(await statusesOfList(collection)) };
    },

    /** The statuses come from the list of the task, because each ClickUp list can have its own statuses. */
    async listStatuses({ id }) {
        if (!id) {
            return [];
        }
        const task = await clickup('GET', `/task/${id}`);
        const list = await clickup('GET', `/list/${task.list.id}`);
        return [...list.statuses].sort((a, b) => a.orderindex - b.orderindex).map(toStatus);
    },

    async listComments({ taskId }) {
        const result = await clickup('GET', `/task/${taskId}/comment`);
        // ClickUp returns the newest comment first. The task view shows the oldest first.
        return result.comments.map(toComment).reverse();
    },

    /**
     * The Dashboard: comments from other people on the tasks assigned to the user, newer than `since`.
     * ClickUp has no API for its inbox, so the plugin reads the comments of the assigned tasks that changed.
     */
    async listActivity({ since }) {
        const sinceMs = Date.parse(since);
        if (!Number.isFinite(sinceMs)) {
            throw new Error('activity/list needs "since" as an ISO time.');
        }
        const perTeam = await Promise.all(
            teams.map(team =>
                clickup(
                    'GET',
                    `/team/${team.id}/task?assignees[]=${userId}&date_updated_gt=${sinceMs}&order_by=updated&subtasks=true&include_closed=true`
                ).then(result => result.tasks.slice(0, ACTIVITY_TASKS))
            )
        );
        const tasks = perTeam.flat();
        const perTask = await eachLimited(tasks, 4, async task => {
            const cached = commentCache.get(task.id);
            let comments = cached?.updated === task.date_updated ? cached.comments : undefined;
            if (!comments) {
                comments = await commentsWithReplies(task.id);
                commentCache.set(task.id, { updated: task.date_updated, comments });
            }
            const own = comments.filter(comment => String(comment.user?.id) === String(userId)).map(comment => Number(comment.date));
            const after = Math.max(sinceMs, ...own);
            return comments
                .filter(comment => comment.user && String(comment.user.id) !== String(userId) && Number(comment.date) > after)
                .map(comment => ({
                    id: String(comment.id),
                    taskId: String(task.id),
                    taskKey: task.custom_id ?? undefined,
                    taskTitle: task.name,
                    taskUrl: task.url,
                    author: comment.user.username ?? comment.user.email,
                    body: comment.comment_text ?? '',
                    createdAt: new Date(Number(comment.date)).toISOString()
                }));
        });
        return { comments: perTask.flat() };
    },

    /**
     * Adds a comment. A mention becomes a ClickUp tag, so the person gets a notification. A task reference becomes the
     * URL of the task, and ClickUp shows it as a link to the task. When ClickUp refuses the parts, the plugin sends the
     * plain text.
     */
    async createComment({ taskId, body, mentions = [], references = [] }) {
        let created;
        if (mentions.length || references.length) {
            const parts = commentParts(body, mentions, references);
            try {
                created = await clickup('POST', `/task/${taskId}/comment`, { comment: parts, notify_all: false });
            } catch (error) {
                log(`ClickUp did not accept the comment with mentions. The plugin sends the plain text. ${error.message}`);
                created = await clickup('POST', `/task/${taskId}/comment`, { comment_text: plainComment(parts, mentions), notify_all: false });
            }
        } else {
            created = await clickup('POST', `/task/${taskId}/comment`, { comment_text: body, notify_all: false });
        }
        return { id: String(created.id), body, createdAt: created.date ? new Date(Number(created.date)).toISOString() : undefined };
    }
});
