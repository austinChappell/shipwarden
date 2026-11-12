// The request handlers of the local task plugin. Each repository of the projects is a collection with its own task file.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
    cleanDay,
    cleanLabels,
    cleanTitle,
    matchesFilter,
    matchesQuery,
    PRIORITIES,
    parseStatuses,
    parseTaskId,
    taskFilePath,
    toComment,
    toTask
} from './map.js';
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
            throw new Error(`The repository "${collection}" is not in a ShipWarden project.`);
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

    /** Reads the task with an ID, and all tasks of its file. */
    const read = async id => {
        const { collection } = parseTaskId(id);
        const data = await fileOf(collection).read();
        return { collection, task: find(data, id), tasks: data.tasks };
    };

    /** Converts a stored task to a protocol task with the description and the details. */
    const fullTask = (stored, collection, tasks) => toTask(stored, collection, statuses, { withDescription: true, tasks });

    /** Changes the task with an ID and returns it as a protocol task. */
    const change = async (id, apply) => {
        const { collection } = parseTaskId(id);
        const { stored, tasks } = await fileOf(collection).update(async data => {
            const stored = find(data, id);
            await apply(stored, data);
            stored.updatedAt = new Date().toISOString();
            return { stored, tasks: data.tasks };
        });
        return fullTask(stored, collection, tasks);
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
                capabilities: { edit: true, subtasks: true },
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

        /** Each repository of the projects is a collection. The first repository is the default. */
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
            const { collection, task, tasks } = await read(id);
            return fullTask(task, collection, tasks);
        },

        /** Makes a task. With `parent`, the task is a subtask in the file of the parent. */
        async createTask({ collection, title, description, status, parent }) {
            const name = cleanTitle(title);
            const statusId = status ?? statuses[0].id;
            if (!statuses.some(item => item.id === statusId)) {
                throw new Error(`The status "${statusId}" does not exist. Use a status from the settings of the task manager.`);
            }
            const target = parent ? parseTaskId(parent).collection : collection;
            const { created, tasks } = await fileOf(target).update(data => {
                const parentNumber = parent ? find(data, parent).number : undefined;
                const now = new Date().toISOString();
                const created = {
                    number: data.nextNumber,
                    title: name,
                    description: typeof description === 'string' ? description : '',
                    status: statusId,
                    ...(parentNumber ? { parent: parentNumber } : {}),
                    createdAt: now,
                    updatedAt: now,
                    comments: []
                };
                data.nextNumber += 1;
                data.tasks.push(created);
                return { created, tasks: data.tasks };
            });
            return fullTask(created, target, tasks);
        },

        async updateTask({ id, status, title, description, labels, priority, startDate, dueDate, timeEstimate }) {
            if (status !== undefined && !statuses.some(item => item.id === status)) {
                throw new Error(`The status "${status}" does not exist. Use a status from the settings of the task manager.`);
            }
            if (priority !== undefined && priority !== null && !PRIORITIES.some(item => item.id === String(priority))) {
                throw new Error(`The priority "${priority}" does not exist.`);
            }
            if (timeEstimate !== undefined && timeEstimate !== null && !(Number.isFinite(timeEstimate) && timeEstimate >= 0)) {
                throw new Error('The estimate must be a positive number of milliseconds.');
            }
            const name = title !== undefined ? cleanTitle(title) : undefined;
            const names = labels !== undefined ? cleanLabels(labels) : undefined;
            const start = startDate !== undefined ? cleanDay(startDate) : undefined;
            const due = dueDate !== undefined ? cleanDay(dueDate) : undefined;
            /** Sets a part of the stored task. An undefined value removes the part. */
            const set = (stored, key, value) => {
                if (value === undefined || value === null) delete stored[key];
                else stored[key] = value;
            };
            return change(id, stored => {
                if (status !== undefined) stored.status = status;
                if (name !== undefined) stored.title = name;
                if (typeof description === 'string') stored.description = description;
                if (names !== undefined) set(stored, 'labels', names.length ? names : undefined);
                if (priority !== undefined) set(stored, 'priority', priority === null ? undefined : Number(priority));
                if (startDate !== undefined) set(stored, 'startDate', start);
                if (dueDate !== undefined) set(stored, 'dueDate', due);
                if (timeEstimate !== undefined) set(stored, 'timeEstimate', timeEstimate === null ? undefined : Math.round(timeEstimate));
            });
        },

        /** The labels: all labels of the tasks in the collection. The user can type a new label. The priority: four levels. */
        async listOptions({ id, part }) {
            if (part === 'priority') {
                return { options: PRIORITIES };
            }
            if (part === 'labels') {
                const { collection } = parseTaskId(id);
                const data = await fileOf(collection).read();
                const names = cleanLabels(data.tasks.flatMap(task => (Array.isArray(task.labels) ? task.labels : [])));
                return { options: names.sort((a, b) => a.localeCompare(b)).map(name => ({ id: name, name })), create: true };
            }
            throw new Error(`The local task manager has no options for "${part}".`);
        },

        async deleteTask({ id }) {
            const { collection, number } = parseTaskId(id);
            await fileOf(collection).update(data => {
                find(data, id);
                data.tasks = data.tasks.filter(task => task.number !== number);
                // The subtasks of a deleted task stay. They have no parent now.
                for (const task of data.tasks) {
                    if (task.parent === number) delete task.parent;
                }
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
