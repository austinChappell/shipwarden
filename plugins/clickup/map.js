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

/**
 * Converts the body of a comment into ClickUp comment parts. The body is Markdown. "@" and the name of a mentioned
 * person becomes a tag. The text of a task reference becomes the URL of the task. Code and link text keep these tokens.
 */
export function commentParts(body, mentions = [], references = []) {
    return tokenParts(markdownParts(String(body)), mentions, references);
}

/**
 * Converts the body of a comment into plain text parts, without Markdown. The plugin sends this text when ClickUp
 * refuses the formatted parts.
 */
export function plainCommentParts(body, mentions = [], references = []) {
    return tokenParts([{ text: String(body) }], mentions, references);
}

/** Replaces the mentions and the task references in the text parts. Parts with code or a link stay the same. */
function tokenParts(source, mentions, references) {
    const tokens = [
        ...mentions.map(person => ({ text: `@${person.name}`, part: { type: 'tag', user: { id: Number(person.id) } } })),
        ...references.map(reference => ({ text: reference.text, part: { text: reference.url ?? taskUrl(reference.id) } }))
    ]
        .filter(token => token.text.length > 1)
        // A longer token wins over a shorter token that starts at the same place, for example "@Ann Lee" over "@Ann".
        .sort((a, b) => b.text.length - a.text.length);
    const parts = [];
    for (const item of source) {
        const attributes = item.attributes;
        if (item.type !== undefined || attributes?.code || attributes?.link || attributes?.['code-block']) {
            pushPart(parts, item);
            continue;
        }
        let rest = item.text;
        while (rest) {
            let best;
            for (const token of tokens) {
                const index = rest.indexOf(token.text);
                if (index >= 0 && (best === undefined || index < best.index)) best = { index, token };
            }
            if (!best) {
                pushText(parts, rest, attributes);
                break;
            }
            pushText(parts, rest.slice(0, best.index), attributes);
            if (best.token.part.type) parts.push(best.token.part);
            else pushText(parts, best.token.part.text, attributes);
            rest = rest.slice(best.index + best.token.text.length);
        }
    }
    return parts;
}

/** Adds a text part. Text with the same attributes as the last part joins that part. */
function pushText(parts, text, attributes) {
    if (!text) return;
    pushPart(parts, attributes && Object.keys(attributes).length > 0 ? { text, attributes } : { text });
}

/** Adds a part. A text part joins the last part when the two parts have the same attributes. */
function pushPart(parts, part) {
    const last = parts[parts.length - 1];
    if (
        part.type === undefined &&
        last &&
        last.type === undefined &&
        typeof last.text === 'string' &&
        JSON.stringify(last.attributes ?? {}) === JSON.stringify(part.attributes ?? {})
    ) {
        last.text += part.text;
    } else {
        parts.push({ ...part });
    }
}

/** ClickUp shows headings 1 to 4 only. */
const MAX_HEADER = 4;

/**
 * Converts Markdown into ClickUp comment parts. ClickUp uses the Quill format: a text part has inline attributes,
 * and the "\n" part at the end of a line has the attributes of the line (a heading, a list item, a quote or code).
 * The function knows headings, lists, task lists, quotes, code blocks, bold, italic, strikethrough, inline code and links.
 * Other text stays text.
 */
export function markdownParts(markdown) {
    const parts = [];
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    let fence;
    lines.forEach((line, index) => {
        const last = index === lines.length - 1;
        const fenceMatch = /^\s*(```|~~~)/.exec(line);
        if (fence) {
            if (fenceMatch && fenceMatch[1] === fence) {
                fence = undefined;
                return;
            }
            pushText(parts, line);
            pushText(parts, '\n', { 'code-block': { 'code-block': 'plain' } });
            return;
        }
        if (fenceMatch) {
            fence = fenceMatch[1];
            return;
        }
        const block = blockOf(line);
        if (block) {
            inlineParts(block.text, {}, parts);
            pushText(parts, '\n', block.attributes);
            return;
        }
        inlineParts(line, {}, parts);
        if (!last) pushText(parts, '\n');
    });
    return parts;
}

/** The attributes and the text of a line that is a heading, a list item or a quote. Undefined for other lines. */
function blockOf(line) {
    let match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) return { text: match[2], attributes: { header: Math.min(match[1].length, MAX_HEADER) } };
    match = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (match) return listItem(match[1], match[2] === ' ' ? 'unchecked' : 'checked', match[3]);
    match = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (match) return listItem(match[1], 'bullet', match[2]);
    match = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (match) return listItem(match[1], 'ordered', match[2]);
    match = /^\s*>\s?(.*)$/.exec(line);
    if (match) return { text: match[1], attributes: { blockquote: {} } };
    return undefined;
}

/** A list item. Each 2 spaces before the marker add one level of indent. */
function listItem(space, list, text) {
    const indent = Math.floor(space.replace(/\t/g, '  ').length / 2);
    return { text, attributes: indent > 0 ? { list: { list }, indent } : { list: { list } } };
}

/**
 * The inline Markdown. The groups in order: an escaped character, inline code, a link, an autolink, bold, bold,
 * strikethrough, italic and italic. An "_" inside a word does not start italic text.
 */
const INLINE =
    /\\([\\`*_{}[\]()#+\-.!~>|])|`([^`\n]+)`|\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^)\s]+))\)|<(https?:\/\/[^>\s]+)>|\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__|~~(?=\S)(.+?)~~|\*(?=[^\s*])(.+?)\*|(?<![A-Za-z0-9])_(?=[^\s_])(.+?)_(?![A-Za-z0-9])/g;

/** Adds the parts of one line of inline Markdown. `attributes` are the attributes of the text around the line. */
function inlineParts(text, attributes, parts) {
    const pattern = new RegExp(INLINE.source, 'g');
    let at = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        pushText(parts, text.slice(at, match.index), attributes);
        at = match.index + match[0].length;
        const [, escaped, code, label, angleUrl, url, autolink, bold, bold2, strike, italic, italic2] = match;
        if (escaped !== undefined) pushText(parts, escaped, attributes);
        else if (code !== undefined) pushText(parts, code, { ...attributes, code: true });
        else if (label !== undefined) {
            const target = angleUrl ?? url;
            if (isWebUrl(target)) inlineParts(label, { ...attributes, link: target }, parts);
            else pushText(parts, match[0], attributes);
        } else if (autolink !== undefined) pushText(parts, autolink, { ...attributes, link: autolink });
        else if (bold !== undefined || bold2 !== undefined) inlineParts(bold ?? bold2, { ...attributes, bold: true }, parts);
        else if (strike !== undefined) inlineParts(strike, { ...attributes, strike: true }, parts);
        else inlineParts(italic ?? italic2, { ...attributes, italic: true }, parts);
    }
    pushText(parts, text.slice(at), attributes);
}

/** The plain text of comment parts. A tag becomes "@" and the name of the person again. */
export function plainComment(parts, mentions = []) {
    return parts
        .map(part => (part.type === 'tag' ? `@${mentions.find(person => Number(person.id) === part.user.id)?.name ?? part.user.id}` : part.text))
        .join('');
}

/** Returns true when the URL starts with "http://" or "https://". */
function isWebUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** Makes a Markdown link. The angle brackets let the URL contain parentheses. */
function markdownLink(text, url) {
    const target = url.replace(/[\s<>]/g, character => encodeURIComponent(character));
    const label = text.trim();
    if (!label || label === url) return `<${target}>`;
    return `[${label.replace(/([\\[\]])/g, '\\$1')}](<${target}>)`;
}

/**
 * Returns the body of a ClickUp comment as Markdown.
 * "comment_text" has only the text of a link, so the function uses the comment parts when a part has a link.
 * A text part with "attributes.link" becomes a Markdown link. A bookmark or a link mention becomes its URL.
 * When a part has an unknown type and no text, the function returns "comment_text", so no text is lost.
 */
export function commentBody(comment) {
    const fallback = comment.comment_text ?? '';
    const parts = Array.isArray(comment.comment) ? comment.comment : [];
    const linkOf = part => {
        const url = part.attributes?.link ?? part.bookmark?.url ?? part.link_mention?.url;
        return isWebUrl(url) ? url : undefined;
    };
    if (!parts.some(linkOf)) return fallback;
    let body = '';
    for (const part of parts) {
        const url = linkOf(part);
        if (url) {
            body += markdownLink(typeof part.text === 'string' ? part.text : '', url);
        } else if (part.type === 'tag' && part.user?.username) {
            body += `@${part.user.username}`;
        } else if (typeof part.text === 'string') {
            body += part.text;
        } else {
            return fallback;
        }
    }
    return body;
}

export function toComment(comment) {
    return {
        id: String(comment.id),
        author: comment.user ? toPerson(comment.user) : undefined,
        body: commentBody(comment),
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

/**
 * Converts ClickUp chat channels to ShipWarden channels. The ID contains the workspace, because the post request needs
 * it: "teamId:channelId". `prefix` is the workspace name when there are several workspaces. Only the items of the type
 * "CHANNEL" with a name show. Direct messages and group messages do not show.
 */
export function toChannels(teamId, channels, prefix) {
    return channels
        .filter(channel => (channel.type === undefined || channel.type === 'CHANNEL') && typeof channel.name === 'string' && channel.name.trim())
        .map(channel => ({
            id: `${teamId}:${channel.id}`,
            name: channel.name.trim(),
            ...(prefix ? { path: prefix } : {})
        }));
}

/** Splits a channel ID of `toChannels` into the workspace and the ClickUp channel. */
export function parseChannelId(id) {
    const text = String(id ?? '');
    const colon = text.indexOf(':');
    if (colon <= 0 || colon === text.length - 1) {
        throw new Error(`The channel "${text}" is not a ClickUp channel. Select the channel again.`);
    }
    return { teamId: text.slice(0, colon), channelId: text.slice(colon + 1) };
}
