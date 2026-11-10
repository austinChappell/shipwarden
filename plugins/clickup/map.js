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

export function toTask(task, { withDescription = false } = {}) {
    return {
        id: task.id,
        key: task.custom_id || undefined,
        title: task.name,
        url: task.url,
        status: toStatus(task.status),
        assignees: (task.assignees ?? []).map(user => ({ name: user.username ?? user.email, avatarUrl: user.profilePicture ?? undefined })),
        labels: (task.tags ?? []).map(tag => ({ name: tag.name, color: tag.tag_bg || undefined })),
        // ClickUp priorities: 1 urgent, 2 high, 3 normal, 4 low.
        priority: task.priority ? { name: task.priority.priority, level: Number(task.priority.id) } : undefined,
        updatedAt: isoDate(task.date_updated),
        description: withDescription ? (task.markdown_description ?? task.description ?? '') : undefined,
        fields: {
            dueDate: isoDate(task.due_date) ?? null
        }
    };
}

export function toComment(comment) {
    return {
        id: String(comment.id),
        author: comment.user ? { name: comment.user.username ?? comment.user.email, avatarUrl: comment.user.profilePicture ?? undefined } : undefined,
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
