// Converts the content of a local task file to ShipWarden task protocol types.
import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** The statuses when the "statuses" setting is empty. */
export const DEFAULT_STATUSES = 'To do, In progress, Done';

/** The letters before the task number in the key, for example "T-12". */
export const KEY_PREFIX = 'T';

const CATEGORY_COLORS = {
    backlog: '#8b949e',
    todo: '#d3d3d3',
    in_progress: '#4c8dff',
    done: '#3fb950',
    canceled: '#8b949e'
};

/** The words in a status name that give its category. The first match applies. */
const CATEGORY_WORDS = [
    ['canceled', /cancel|won'?t|abandon|reject|not planned|obsolete/i],
    ['backlog', /backlog|icebox|someday|later/i],
    ['done', /done|complete|closed|finished|shipped|resolved|merged/i],
    ['todo', /^\s*(to ?do|open|new|ready)\s*$/i]
];

/** Makes an ID from a name, for example "In progress" → "in-progress". */
export function slug(text) {
    return String(text)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Reads the "statuses" setting: status names with commas or new lines between them, in workflow order.
 * The category of a status comes from its name (for example "Done" or "Canceled"). Else the first status is "todo",
 * the last status is "done" and the other statuses are "in_progress".
 */
export function parseStatuses(text) {
    const names = String(text ?? '')
        .split(/[,\n]/)
        .map(name => name.trim())
        .filter(Boolean);
    const unique = [];
    for (const name of names.length > 0 ? names : DEFAULT_STATUSES.split(',').map(name => name.trim())) {
        const id = slug(name);
        if (id && !unique.some(status => status.id === id)) {
            unique.push({ id, name });
        }
    }
    if (unique.length === 0) {
        return parseStatuses(DEFAULT_STATUSES);
    }
    return unique.map((status, index) => {
        const named = CATEGORY_WORDS.find(([, pattern]) => pattern.test(status.name))?.[0];
        const category = named ?? (index === 0 ? 'todo' : index === unique.length - 1 && unique.length > 1 ? 'done' : 'in_progress');
        return { id: status.id, name: status.name, color: CATEGORY_COLORS[category], category, order: index };
    });
}

/** Returns the status with an ID. A status that the settings do not have any more shows with its ID as the name. */
export function statusFor(statuses, id) {
    return (
        statuses.find(status => status.id === id) ?? { id: String(id), name: String(id), color: CATEGORY_COLORS.todo, category: 'todo', order: statuses.length }
    );
}

/**
 * Returns the path of the task file of a repository.
 * - In the repository: "<repository>/.shipwarden/tasks.json". A team can commit this file.
 * - Else: "<home>/.shipwarden/tasks/<repository name>-<hash>.json". The hash of the full path keeps two repositories with the same name apart.
 */
export function taskFilePath(root, { inRepository, home }) {
    if (inRepository) {
        return path.join(root, '.shipwarden', 'tasks.json');
    }
    const hash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 8);
    return path.join(home, '.shipwarden', 'tasks', `${slug(path.basename(root)) || 'repository'}-${hash}.json`);
}

/** Makes a task ID from the collection ID (the repository path) and the task number. */
export function taskId(collection, number) {
    return `${collection}#${number}`;
}

/** Splits a task ID into the collection ID and the task number. */
export function parseTaskId(id) {
    const text = String(id);
    const index = text.lastIndexOf('#');
    const number = Number(text.slice(index + 1));
    if (index <= 0 || !Number.isInteger(number) || number < 1) {
        throw new Error(`The task ID "${id}" is not valid. A local task ID is "<repository path>#<number>".`);
    }
    return { collection: text.slice(0, index), number };
}

/** The option ID of the "archived" label. The label shows the state of the task. The user cannot add or remove it. */
export const ARCHIVED_LABEL_ID = ':archived';

/** The priorities of a local task. The ID is the level. */
export const PRIORITIES = [
    { id: '1', name: 'Urgent', color: '#f07178' },
    { id: '2', name: 'High', color: '#e6b450' },
    { id: '3', name: 'Normal', color: '#59c2ff' },
    { id: '4', name: 'Low', color: '#8b949e' }
];

/** The parts of a local task that tasks/update can change. */
export const EDITABLE = { title: true, description: true, labels: true, priority: true, startDate: true, dueDate: true, timeEstimate: true };

/** Converts a stored task to a protocol task. `withDescription`: the result of tasks/get, with the details. */
export function toTask(stored, collection, statuses, { withDescription = false } = {}) {
    const priority = PRIORITIES.find(item => item.id === String(stored.priority));
    // The field "createdAt" shows the time of creation, so the details do not have it.
    const details = {
        startDate: stored.startDate,
        dueDate: stored.dueDate,
        timeEstimate: stored.timeEstimate
    };
    return {
        id: taskId(collection, stored.number),
        key: `${KEY_PREFIX}-${stored.number}`,
        title: stored.title,
        status: statusFor(statuses, stored.status),
        labels: [
            ...(Array.isArray(stored.labels) ? stored.labels : []).map(name => ({ name: String(name) })),
            ...(stored.archived ? [{ id: ARCHIVED_LABEL_ID, name: 'archived', color: CATEGORY_COLORS.canceled }] : [])
        ],
        ...(priority ? { priority: { name: priority.name, level: Number(priority.id) } } : {}),
        updatedAt: stored.updatedAt,
        description: withDescription ? (stored.description ?? '') : undefined,
        fields: {
            createdAt: stored.createdAt ?? null,
            comments: stored.comments?.length ?? 0
        },
        ...(withDescription ? { details, editable: EDITABLE } : {})
    };
}

/** Returns a clean list of label names: without the "archived" label, empty names and duplicates. */
export function cleanLabels(labels) {
    if (!Array.isArray(labels)) {
        throw new Error('The labels must be a list.');
    }
    const names = labels
        .filter(label => label !== ARCHIVED_LABEL_ID)
        .map(label => String(label).replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    return [...new Map(names.map(name => [name.toLowerCase(), name])).values()];
}

/** Returns a valid day "YYYY-MM-DD", or undefined for null. */
export function cleanDay(day) {
    if (day === null) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
        throw new Error(`The date "${day}" is not valid. Use the form YYYY-MM-DD.`);
    }
    return String(day);
}

export function toComment(stored) {
    return {
        id: stored.id,
        author: stored.author ? { name: stored.author } : undefined,
        body: stored.body,
        createdAt: stored.createdAt
    };
}

/** True when the task matches the filter: "active" (the default), "archived" or "all". */
export function matchesFilter(stored, filter = 'active') {
    if (filter === 'all') return true;
    if (filter === 'archived') return !!stored.archived;
    return !stored.archived;
}

/** True when each word of the query is in the key, the title, the description or a comment. The search is not case sensitive. */
export function matchesQuery(stored, query) {
    const words = String(query ?? '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    if (words.length === 0) return true;
    const text = [`${KEY_PREFIX}-${stored.number}`, stored.title, stored.description ?? '', ...(stored.comments ?? []).map(comment => comment.body)]
        .join(' ')
        .toLowerCase();
    return words.every(word => text.includes(word));
}

/** Returns a trimmed title. Throws an error for an empty title. */
export function cleanTitle(title) {
    const value = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    if (!value) {
        throw new Error('A task must have a title.');
    }
    return value;
}
