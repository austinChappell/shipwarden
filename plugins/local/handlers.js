// The request handlers of the local task plugin. Each repository of the project is a collection with its own task file.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { cleanTitle, matchesFilter, matchesQuery, parseStatuses, parseTaskId, taskFilePath, toComment, toTask } from './map.js';
import { TaskFile } from './store.js';

/**
 * Makes the handlers for `runPlugin`.
 * - `home`: the home folder. The task files that are not in a repository go in "<home>/.shipwarden/tasks".
 * - `author()`: returns the name for new comments.
 */
export function createHandlers({ home, author = async () => undefined }) {
    let statuses = parseStatuses();
    /** The collections, by collection ID (the repository path). */
    let collections = new Map();

    const fileOf = collection => {
        const entry = collections.get(collection);
        if (!entry) {
            throw new Error(`The repository "${collection}" is not in this ShipWarden project.`);
        }
        return entry.file;
    };

    /** Finds a stored task in the data of a file. Throws an error when the task does not exist. */
    const find = (data, id) => {
        const { number } = parseTaskId(id);
        const task = data.tasks.find(item => item.number === number);
        if (!task) {
            throw new Error(`The task ${id} does not exist. Possibly a different person or process deleted it.`);
        }
        return task;
    };

    /** Reads the task with an ID. */
    const read = async id => {
        const { collection } = parseTaskId(id);
        return { collection, task: find(await fileOf(collection).read(), id) };
    };

    /** Changes the task with an ID and returns it as a protocol task. */
    const change = async (id, apply) => {
        const { collection } = parseTaskId(id);
        const task = await fileOf(collection).update(async data => {
            const stored = find(data, id);
            await apply(stored, data);
            stored.updatedAt = new Date().toISOString();
            return stored;
        });
        return toTask(task, collection, statuses, { withDescription: true });
    };

    const handlers = {
        async initialize({ settings = {}, context }) {
            statuses = parseStatuses(typeof settings.statuses === 'string' ? settings.statuses : '');
            const inRepository = settings.inRepository === true || settings.inRepository === 'true';
            collections = new Map(
                (context?.repositories ?? []).map(repo => [
                    repo.root,
                    { name: path.basename(repo.root), file: new TaskFile(taskFilePath(repo.root, { inRepository, home })) }
                ])
            );
            return {
                capabilities: { edit: true },
                fields: [
                    { id: 'createdAt', label: 'Created', type: 'date' },
                    { id: 'comments', label: 'Comments', type: 'number' }
                ],
                filters: [
                    { id: 'active', label: 'Active tasks', default: true },
                    { id: 'archived', label: 'Archived tasks' },
                    { id: 'all', label: 'All tasks' }
                ],
                actions: [
                    { id: 'archive', label: 'Archive' },
                    { id: 'restore', label: 'Restore' }
                ]
            };
        },

        /** Each repository of the project is a collection. The first repository is the default. */
        async listCollections() {
            return [...collections.entries()].map(([id, entry], index) => ({
                id,
                name: entry.name,
                path: path.dirname(id),
                ...(index === 0 ? { default: true } : {})
            }));
        },

        async listTasks({ collection, filter, query }) {
            const data = await fileOf(collection).read();
            const tasks = data.tasks
                .filter(task => matchesFilter(task, filter) && matchesQuery(task, query))
                .sort((a, b) => b.number - a.number)
                .map(task => toTask(task, collection, statuses));
            return { tasks };
        },

        async getTask({ id }) {
            const { collection, task } = await read(id);
            return toTask(task, collection, statuses, { withDescription: true });
        },

        async createTask({ collection, title, description, status }) {
            const name = cleanTitle(title);
            const statusId = status ?? statuses[0].id;
            if (!statuses.some(item => item.id === statusId)) {
                throw new Error(`The status "${statusId}" does not exist. Use a status from the settings of the task manager.`);
            }
            const task = await fileOf(collection).update(data => {
                const now = new Date().toISOString();
                const created = {
                    number: data.nextNumber,
                    title: name,
                    description: typeof description === 'string' ? description : '',
                    status: statusId,
                    createdAt: now,
                    updatedAt: now,
                    comments: []
                };
                data.nextNumber += 1;
                data.tasks.push(created);
                return created;
            });
            return toTask(task, collection, statuses, { withDescription: true });
        },

        async updateTask({ id, status, title, description }) {
            if (status !== undefined && !statuses.some(item => item.id === status)) {
                throw new Error(`The status "${status}" does not exist. Use a status from the settings of the task manager.`);
            }
            const name = title !== undefined ? cleanTitle(title) : undefined;
            return change(id, stored => {
                if (status !== undefined) stored.status = status;
                if (name !== undefined) stored.title = name;
                if (typeof description === 'string') stored.description = description;
            });
        },

        async deleteTask({ id }) {
            const { collection, number } = parseTaskId(id);
            await fileOf(collection).update(data => {
                find(data, id);
                data.tasks = data.tasks.filter(task => task.number !== number);
            });
            return null;
        },

        async listStatuses() {
            return statuses;
        },

        async statusOrder() {
            return { statuses };
        },

        async listComments({ taskId }) {
            const { task } = await read(taskId);
            return task.comments.map(toComment);
        },

        async createComment({ taskId, body }) {
            const text = typeof body === 'string' ? body.trim() : '';
            if (!text) {
                throw new Error('A comment must have text.');
            }
            const name = await author();
            let comment;
            await change(taskId, stored => {
                comment = { id: randomUUID(), ...(name ? { author: name } : {}), body: text, createdAt: new Date().toISOString() };
                stored.comments.push(comment);
            });
            return toComment(comment);
        },

        async runAction({ taskId, actionId }) {
            if (actionId !== 'archive' && actionId !== 'restore') {
                throw new Error(`The action "${actionId}" does not exist.`);
            }
            const archive = actionId === 'archive';
            const { task } = await read(taskId);
            if (!!task.archived === archive) {
                return { message: archive ? 'The task is already archived.' : 'The task is not archived.' };
            }
            await change(taskId, stored => {
                if (archive) stored.archived = true;
                else delete stored.archived;
            });
            return { message: archive ? 'The task is archived. Select "Archived tasks" to see it.' : 'The task is active again.' };
        }
    };

    /** The task files of the collections. The plugin watches them for changes by other processes. */
    const files = () => [...collections.values()].map(entry => entry.file);

    return { handlers, files };
}
