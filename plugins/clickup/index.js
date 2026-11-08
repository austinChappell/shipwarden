// A ShipWarden task plugin for ClickUp. Each ClickUp list is a collection.
import { log, networkDetail, runPlugin } from '../sdk/index.js';
import { busiestList, listStatusOrder, matchesQuery, toCollections, toComment, toStatus, toTask } from './map.js';

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
/** The statuses of each list, with the time of the load. */
const listStatuses = new Map();
const LIST_CACHE_MS = 10 * 60 * 1000;
/** The comments of each task, with the "date_updated" of the task at the load. A task without a change needs no new request. */
const commentCache = new Map();
/** The Dashboard reads the comments of this number of recently changed tasks, at most, in each workspace. */
const ACTIVITY_TASKS = 40;

/** Returns the comments of a task with the replies of each comment. */
async function commentsWithReplies(taskId) {
    const { comments } = await clickup('GET', `/task/${taskId}/comment`);
    const replies = await Promise.all(comments
        .filter(comment => Number(comment.reply_count) > 0)
        .slice(0, 10)
        .map(comment => clickup('GET', `/comment/${comment.id}/reply`).then(result => result.comments ?? [], () => [])));
    return [...comments, ...replies.flat()];
}

/** Runs `work` for each item, with at most `limit` at the same time. */
async function eachLimited(items, limit, work) {
    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index]);
        }
    }));
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

async function clickup(method, path, body) {
    let response;
    try {
        response = await fetch(`${API}${path}`, {
            method,
            headers: {
                'Authorization': token,
                'Accept': 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        });
    } catch (error) {
        throw new Error(`ShipWarden cannot connect to ClickUp: ${networkDetail(error)}`);
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

runPlugin({
    async initialize({ settings, scope }) {
        token = String(settings.apiToken ?? '').trim();
        if (!token) {
            throw new Error('The ClickUp connection needs an API token. Add it in Settings > Task managers.');
        }
        userId = (await clickup('GET', '/user')).user.id;
        allTeams = (await clickup('GET', '/team')).teams;
        if (allTeams.length === 0) {
            throw new Error('This ClickUp account has no workspace.');
        }
        teams = scope ? allTeams.filter(team => scope.includes(String(team.id))) : allTeams;
        if (teams.length === 0) {
            throw new Error('The token has no access to the selected ClickUp workspaces. Change the workspaces in Settings > Task managers.');
        }
        log(`ClickUp plugin ready for ${teams.map(team => `"${team.name}"`).join(', ')}.`);
        return {
            fields: [
                { id: 'dueDate', label: 'Due', type: 'date' }
            ],
            filters: [
                { id: 'assigned', label: 'Assigned to me', default: true },
                { id: 'open', label: 'All open tasks' },
                { id: 'all', label: 'All tasks, with closed' }
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
        const assignedTasks = [];
        const perTeam = await Promise.all(teams.map(async team => {
            const [{ spaces }, assigned] = await Promise.all([
                clickup('GET', `/team/${team.id}/space?archived=false`),
                clickup('GET', `/team/${team.id}/task?assignees[]=${userId}&order_by=updated&subtasks=true`).catch(() => ({ tasks: [] }))
            ]);
            assignedTasks.push(...assigned.tasks);
            const hierarchy = await Promise.all(spaces.map(async space => {
                const [folders, lists] = await Promise.all([
                    clickup('GET', `/space/${space.id}/folder?archived=false`),
                    clickup('GET', `/space/${space.id}/list?archived=false`)
                ]);
                return { space, folders: folders.folders, lists: lists.lists };
            }));
            return { team, hierarchy };
        }));
        const busiest = busiestList(assignedTasks);
        const collections = perTeam.flatMap(({ team, hierarchy }) =>
            toCollections(team.id, hierarchy, busiest, teams.length > 1 ? team.name : undefined));
        collectionsCache = { collections, at: Date.now() };
        return collections;
    },

    async listTasks({ collection, filter = 'assigned', query, cursor }) {
        if (!collection) {
            throw new Error('Select a ClickUp list.');
        }
        const page = Number(cursor ?? 0);
        const assignee = filter === 'assigned' ? `&assignees[]=${userId}` : '';
        const includeClosed = filter === 'all';
        const result = await clickup('GET', `/list/${collection}/task?page=${page}&order_by=updated&subtasks=true&include_closed=${includeClosed}${assignee}`);
        return {
            tasks: result.tasks.filter(task => matchesQuery(task, query)).map(task => toTask(task)),
            // ClickUp returns 100 tasks per page. "last_page" is true on the last page.
            nextCursor: result.last_page === false ? String(page + 1) : undefined
        };
    },

    async getTask({ id }) {
        return toTask(await clickup('GET', `/task/${id}?include_markdown_description=true`), { withDescription: true });
    },

    async updateTask({ id, status }) {
        await clickup('PUT', `/task/${id}`, { status });
        return toTask(await clickup('GET', `/task/${id}?include_markdown_description=true`), { withDescription: true });
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
        const perTeam = await Promise.all(teams.map(team =>
            clickup('GET', `/team/${team.id}/task?assignees[]=${userId}&date_updated_gt=${sinceMs}&order_by=updated&subtasks=true&include_closed=true`)
                .then(result => result.tasks.slice(0, ACTIVITY_TASKS))));
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

    async createComment({ taskId, body }) {
        const created = await clickup('POST', `/task/${taskId}/comment`, { comment_text: body, notify_all: false });
        return { id: String(created.id), body, createdAt: created.date ? new Date(Number(created.date)).toISOString() : undefined };
    }
});
