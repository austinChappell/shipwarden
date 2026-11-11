// Converts ClickUp API v2 tasks and comments to ShipWarden task protocol types.

/** ClickUp status types: open, custom, done, closed. */
export function statusCategory(type) {
    switch (type) {
        case 'open':
            return 'todo';
        case 'done':
        case 'closed':
            return 'done';
        default:
            return 'in_progress';
    }
}

/** ClickUp changes a status by its name, so the status ID is the name. */
export function toStatus(status) {
    return {
        id: status.status,
        name: status.status,
        color: status.color || undefined,
        category: statusCategory(status.type),
        // ClickUp's position of the status in its list.
        order: typeof status.orderindex === 'number' ? status.orderindex : undefined
    };
}

function isoDate(milliseconds) {
    return milliseconds ? new Date(Number(milliseconds)).toISOString() : undefined;
}

/** A ClickUp user as a person. The ID lets ShipWarden filter the tasks by assignee. */
export function toPerson(user) {
    return {
        id: user.id === undefined || user.id === null ? undefined : String(user.id),
        name: user.username || user.email || 'Unknown',
        avatarUrl: user.profilePicture || undefined
    };
}

/**
 * A ClickUp date as an ISO time. When `hasTime` is false, ClickUp stores only a day, so the function returns
 * "YYYY-MM-DD" in the local time zone of the computer.
 */
export function dayOrTime(milliseconds, hasTime) {
    if (!milliseconds) return undefined;
    const date = new Date(Number(milliseconds));
    if (hasTime) return date.toISOString();
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The URL of a ClickUp task from its ID. */
export function taskUrl(id) {
    return `https://app.clickup.com/t/${id}`;
}

/** The option of a drop-down or labels field: ClickUp sends the option ID, or the "orderindex" for a drop-down. */
function fieldOption(field, value) {
    const options = field.type_config?.options ?? [];
    return options.find(option => option.id === value) ?? options.find(option => Number(option.orderindex) === Number(value));
}

function optionLabel(option) {
    return { id: String(option.id), name: option.name ?? option.label ?? '', color: option.color || undefined };
}

/** The options of a drop-down or labels field, for the task details. */
function fieldOptions(field) {
    return (field.type_config?.options ?? []).map(optionLabel);
}

/** The ClickUp field types that the plugin can change, with the type of the task details. */
const TEXT_TYPES = new Set(['text', 'short_text', 'email', 'phone']);

/** Converts a ClickUp custom field and its value. An empty field has no value. */
export function toCustomField(field) {
    const base = { id: String(field.id), label: field.name };
    const editable = { editable: true };
    const value = field.value;
    const empty = value === undefined || value === null || value === '';
    switch (field.type) {
        case 'number':
            return { ...base, ...editable, type: 'number', ...(empty ? {} : { value: Number(value) }) };
        case 'currency': {
            if (empty) return { ...base, type: 'text' };
            const currency = field.type_config?.currency_type;
            let text = String(value);
            try {
                text = currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(value)) : String(value);
            } catch {
                // An unknown currency code keeps the plain number.
            }
            return { ...base, type: 'text', value: text };
        }
        case 'emoji':
            return { ...base, ...editable, type: 'rating', max: Number(field.type_config?.count) || 5, ...(empty ? {} : { value: Number(value) }) };
        case 'checkbox':
            return { ...base, ...editable, type: 'boolean', value: value === true || value === 'true' };
        case 'date':
            return { ...base, ...editable, type: 'date', ...(empty ? {} : { value: dayOrTime(value, field.value_options?.time === true) }) };
        case 'url':
            return { ...base, ...editable, type: 'url', ...(empty ? {} : { value: String(value) }) };
        case 'drop_down': {
            const option = empty ? undefined : fieldOption(field, value);
            return { ...base, ...editable, type: 'labels', options: fieldOptions(field), ...(option ? { labels: [optionLabel(option)] } : {}) };
        }
        case 'labels': {
            const labels = (Array.isArray(value) ? value : [])
                .map(id => fieldOption(field, id))
                .filter(Boolean)
                .map(optionLabel);
            return { ...base, ...editable, type: 'labels', multiple: true, options: fieldOptions(field), ...(labels.length ? { labels } : {}) };
        }
        case 'users': {
            const people = (Array.isArray(value) ? value : []).filter(user => user && typeof user === 'object').map(toPerson);
            return { ...base, ...editable, type: 'people', ...(people.length ? { people } : {}) };
        }
        case 'tasks': {
            const names = (Array.isArray(value) ? value : []).map(item => item?.name).filter(Boolean);
            return { ...base, type: 'text', ...(names.length ? { value: names.join(', ') } : {}) };
        }
        case 'progress':
        case 'manual_progress':
        case 'automatic_progress': {
            const percent = Number(value?.percent_completed ?? value?.current ?? value);
            // Only a manual progress bar can change. ClickUp calculates the other progress bars.
            const manual = field.type === 'manual_progress' ? editable : {};
            return { ...base, ...manual, type: 'progress', ...(Number.isFinite(percent) && !empty ? { value: percent } : {}) };
        }
        case 'location':
            return { ...base, type: 'text', ...(value?.formatted_address ? { value: value.formatted_address } : {}) };
        default:
            return {
                ...base,
                ...(TEXT_TYPES.has(field.type) ? editable : {}),
                type: 'text',
                ...(empty || typeof value === 'object' ? {} : { value: String(value) })
            };
    }
}

/** A short reference to another ClickUp task. */
function toRef(task) {
    return {
        id: String(task.id),
        key: task.custom_id || undefined,
        title: task.name,
        url: task.url || taskUrl(task.id),
        status: task.status ? toStatus(task.status) : undefined,
        assignees: (task.assignees ?? []).map(toPerson)
    };
}

/**
 * The links of a task to other tasks. A dependency has "task_id" (the task that waits) and "depends_on" (the task that it waits on).
 * A linked task has "task_id" and "link_id". ClickUp sends only the IDs, so ShipWarden finds the titles.
 */
export function toLinks(task) {
    const id = String(task.id);
    const links = [];
    for (const dependency of task.dependencies ?? []) {
        if (String(dependency.task_id) === id) {
            links.push({ relation: 'blocked_by', task: { id: String(dependency.depends_on), url: taskUrl(dependency.depends_on) } });
        } else if (String(dependency.depends_on) === id) {
            links.push({ relation: 'blocks', task: { id: String(dependency.task_id), url: taskUrl(dependency.task_id) } });
        }
    }
    for (const link of task.linked_tasks ?? []) {
        const other = String(link.task_id) === id ? link.link_id : link.task_id;
        if (other) links.push({ relation: 'related', task: { id: String(other), url: taskUrl(other) } });
    }
    return links;
}

/** The facts of one task for the task details. `location` is the path of the list, for example "Engineering / Projects / Sprint 12". */
export function toDetails(task, location) {
    const nonEmpty = list => (list?.length ? list : undefined);
    return {
        location,
        creator: task.creator ? toPerson(task.creator) : undefined,
        createdAt: isoDate(task.date_created),
        startDate: dayOrTime(task.start_date, task.start_date_time === true),
        dueDate: dayOrTime(task.due_date, task.due_date_time === true),
        timeEstimate: task.time_estimate ? Number(task.time_estimate) : undefined,
        timeSpent: task.time_spent ? Number(task.time_spent) : undefined,
        watchers: nonEmpty((task.watchers ?? []).map(toPerson)),
        parent: task.parent ? { id: String(task.parent), url: taskUrl(task.parent) } : undefined,
        subtasks: nonEmpty((task.subtasks ?? []).map(toRef)),
        links: nonEmpty(toLinks(task)),
        checklists: nonEmpty(
            (task.checklists ?? []).map(checklist => ({
                name: checklist.name,
                items: [...(checklist.items ?? [])]
                    .sort((a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0))
                    .map(item => ({
                        id: checklistItemId(checklist.id, item.id),
                        name: item.name,
                        done: item.resolved === true,
                        assignee: item.assignee ? toPerson(item.assignee) : undefined
                    }))
            }))
        ),
        attachments: nonEmpty(
            (task.attachments ?? [])
                .filter(item => item.url)
                .map(item => ({
                    name: item.title || item.url.split('/').pop(),
                    url: item.url,
                    size: Number(item.size) || undefined,
                    thumbnailUrl: item.thumbnail_small || item.thumbnail_medium || undefined,
                    createdAt: isoDate(item.date)
                }))
        ),
        customFields: nonEmpty((task.custom_fields ?? []).map(toCustomField))
    };
}

export function toTask(task, { withDescription = false } = {}) {
    return {
        id: task.id,
        key: task.custom_id || undefined,
        title: task.name,
        url: task.url,
        status: toStatus(task.status),
        assignees: (task.assignees ?? []).map(toPerson),
        labels: (task.tags ?? []).map(toLabel),
        // ClickUp priorities: 1 urgent, 2 high, 3 normal, 4 low.
        priority: task.priority ? { name: task.priority.priority, level: Number(task.priority.id) } : undefined,
        updatedAt: isoDate(task.date_updated),
        description: withDescription ? (task.markdown_description ?? task.description ?? '') : undefined
    };
}

/** A ClickUp tag as a label. ClickUp changes the tags of a task by name, so the name is the option ID. */
export function toLabel(tag) {
    return { name: tag.name, color: tag.tag_bg || undefined };
}

/** The parts of a ClickUp task that the plugin can change. */
export const EDITABLE = {
    title: true,
    description: true,
    assignees: true,
    labels: true,
    priority: true,
    startDate: true,
    dueDate: true,
    timeEstimate: true,
    checklists: true
};

/** The ClickUp priorities. The ID is the level. */
export const PRIORITIES = [
    { id: '1', name: 'Urgent', color: '#f50000' },
    { id: '2', name: 'High', color: '#ffcc00' },
    { id: '3', name: 'Normal', color: '#6fddff' },
    { id: '4', name: 'Low', color: '#d8d8d8' }
];

/** The ID of a checklist item for tasks/update: ClickUp needs the checklist ID and the item ID. */
export function checklistItemId(checklistId, itemId) {
    return `${checklistId}/${itemId}`;
}

/** Splits the ID of a checklist item into the checklist ID and the item ID. */
export function parseChecklistItemId(id) {
    const index = String(id).indexOf('/');
    if (index <= 0) {
        throw new Error(`The checklist item ID "${id}" is not valid.`);
    }
    return { checklistId: id.slice(0, index), itemId: id.slice(index + 1) };
}

/**
 * Converts a day "YYYY-MM-DD" to ClickUp milliseconds: noon in the time zone of the computer.
 * Noon keeps the same day when the time zone of the ClickUp account is a few hours different. Null stays null.
 */
export function dayToMilliseconds(day) {
    if (day === null) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
    if (!match) {
        throw new Error(`The date "${day}" is not valid. Use the form YYYY-MM-DD.`);
    }
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getTime();
}

/** Returns the IDs to add and to remove, so that the list `current` becomes `wanted`. */
export function listChange(current, wanted) {
    const before = new Set(current.map(String));
    const after = new Set(wanted.map(String));
    return { add: [...after].filter(id => !before.has(id)), rem: [...before].filter(id => !after.has(id)) };
}

/**
 * Returns the request for a new custom field value, or { clear: true } for an empty value.
 * `field` is the ClickUp field of the task, with its type and current value.
 */
export function customFieldRequest(field, value) {
    const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0);
    switch (field.type) {
        case 'users': {
            const current = (Array.isArray(field.value) ? field.value : []).map(user => user?.id).filter(id => id !== undefined);
            return { body: { value: listChange(current, Array.isArray(value) ? value : []) } };
        }
        case 'checkbox':
            return { body: { value: value === true } };
        default:
            if (empty) return { clear: true };
    }
    switch (field.type) {
        case 'number':
        case 'currency':
        case 'emoji': {
            const number = Number(value);
            if (!Number.isFinite(number)) {
                throw new Error(`"${value}" is not a number.`);
            }
            return { body: { value: number } };
        }
        case 'manual_progress':
            return { body: { value: { current: Number(value) } } };
        case 'date':
            return { body: { value: dayToMilliseconds(value), value_options: { time: false } } };
        case 'drop_down':
            return { body: { value: Array.isArray(value) ? value[0] : value } };
        case 'labels':
            return { body: { value: Array.isArray(value) ? value : [value] } };
        default:
            return { body: { value: String(value) } };
    }
}

export function toComment(comment) {
    return {
        id: String(comment.id),
        author: comment.user ? toPerson(comment.user) : undefined,
        body: comment.comment_text ?? '',
        createdAt: isoDate(comment.date)
    };
}

/** Returns the statuses of one list in its workflow order ("orderindex"), without the per-task order field. */
export function listStatusOrder(statuses) {
    return [...statuses]
        .sort((a, b) => a.orderindex - b.orderindex)
        .map(status => {
            const { order: _order, ...rest } = toStatus(status);
            return rest;
        });
}

/**
 * Converts the ClickUp hierarchy to collections: one collection for each list.
 * `spaces` is a list of { space, folders, lists }: the folders of the space (each with its lists) and the lists outside a folder.
 * The path is "Space" or "Space / Folder", after `prefix` (the workspace name when there are several workspaces).
 * `defaultListId` marks the list that the picker selects first.
 */
export function toCollections(teamId, spaces, defaultListId, prefix) {
    const collections = [];
    const at = path => (prefix ? `${prefix} / ${path}` : path);
    const add = (list, path) =>
        collections.push({
            id: String(list.id),
            name: list.name,
            path,
            url: `https://app.clickup.com/${teamId}/v/li/${list.id}`,
            ...(String(list.id) === String(defaultListId) ? { default: true } : {})
        });
    for (const { space, folders, lists } of spaces) {
        for (const list of lists ?? []) {
            add(list, at(space.name));
        }
        for (const folder of folders ?? []) {
            for (const list of folder.lists ?? []) {
                // A list outside a folder can also come back in a hidden folder. It belongs to the space.
                add(list, at(folder.hidden ? space.name : `${space.name} / ${folder.name}`));
            }
        }
    }
    return collections;
}

/** Returns the ID of the list that has the most of the tasks, or undefined for no tasks. */
export function busiestList(tasks) {
    const counts = new Map();
    for (const task of tasks) {
        if (task.list?.id) {
            counts.set(String(task.list.id), (counts.get(String(task.list.id)) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** ClickUp's list task endpoint has no text search. The plugin filters the page by the task name and custom ID. */
export function matchesQuery(task, query) {
    const needle = query?.trim().toLowerCase();
    if (!needle) {
        return true;
    }
    return task.name.toLowerCase().includes(needle) || (task.custom_id ?? '').toLowerCase().includes(needle);
}

/** The wait after a 429 response when ClickUp sends no reset time. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 10_000;

/**
 * Returns the time in milliseconds to wait after a 429 response of ClickUp.
 * ClickUp sends the reset time of the rate limit in "X-RateLimit-Reset" as Unix seconds.
 * A "Retry-After" header in seconds has priority.
 */
export function rateLimitWait(headers, now = Date.now()) {
    const retryAfter = Number(headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return retryAfter * 1000;
    }
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
        // Add a half second, because the clocks of ClickUp and of this computer can be different.
        return Math.max(1000, reset * 1000 - now + 500);
    }
    return DEFAULT_RATE_LIMIT_WAIT_MS;
}
