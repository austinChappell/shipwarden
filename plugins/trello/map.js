// Converts Trello REST API objects to ShipWarden task protocol types.
// The API: https://developer.atlassian.com/cloud/trello/rest/

/** The card fields that `toTask` reads in a task list. */
export const CARD_FIELDS = 'name,idShort,shortUrl,idList,idBoard,idMembers,labels,due,start,dueComplete,dateLastActivity,closed';

/** The member fields that `toPerson` reads. */
export const MEMBER_FIELDS = 'fullName,username,avatarUrl';

/** The ID of the scope for the boards that are not in a workspace. */
export const PERSONAL_SCOPE = 'personal';

/** The name of the custom field that gives the task priority. */
const PRIORITY_FIELD = 'priority';

/** The CSS color of each Trello color name. Labels and custom field options use these names. A "_dark" or "_light" color uses the base color. */
const COLORS = {
    green: '#4bce97',
    yellow: '#f5cd47',
    orange: '#fea362',
    red: '#f87168',
    purple: '#9f8fef',
    blue: '#579dff',
    sky: '#6cc3e0',
    lime: '#94c748',
    pink: '#e774bb',
    black: '#8590a2'
};

/** Converts a Trello color name, for example "sky" or "red_dark", to a CSS color. "none" and null give undefined. */
export function cssColor(color) {
    if (!color || color === 'none') {
        return undefined;
    }
    return COLORS[String(color).replace(/_(dark|light)$/, '')];
}

/**
 * Returns the status category of a Trello list. Trello lists have no type, so the plugin reads the list name.
 * The order of the checks is important. "Released" gives "done", but "In Release Train" gives "in_progress".
 */
export function statusCategory(listName) {
    const name = String(listName ?? '').toLowerCase();
    if (/\b(done|complete|completed|released|shipped|closed|finished)\b/.test(name)) {
        return 'done';
    }
    if (/\b(cancell?ed|won.?t do|rejected|abandoned)\b/.test(name)) {
        return 'canceled';
    }
    if (/\b(in progress|progress|doing|review|reviewing|merged|release|testing|qa|blocked|waiting|staging|deploy|deploying)\b/.test(name)) {
        return 'in_progress';
    }
    if (/\b(backlog|icebox|someday|ideas)\b/.test(name)) {
        return 'backlog';
    }
    return 'todo';
}

/** Converts a Trello list to a status. The order is the position of the list on the board. */
export function toStatus(list) {
    return {
        id: list.id,
        name: list.name,
        color: cssColor(list.color),
        category: statusCategory(list.name),
        order: Number(list.pos) || 0
    };
}

/** Returns the open lists of a board in board order, as statuses without the order field. */
export function boardStatusOrder(lists) {
    return lists
        .filter(list => !list.closed)
        .sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0))
        .map(list => {
            const { order: _order, ...rest } = toStatus(list);
            return rest;
        });
}

/** The status of a card in a list that the plugin does not know, for example a list on a different board. */
const UNKNOWN_STATUS = { id: 'unknown', name: 'Unknown list', category: 'todo' };

/** Returns the status of a card. An archived card has the category "canceled". */
export function cardStatus(card, listsById) {
    const list = listsById.get(card.idList);
    const status = list ? toStatus(list) : { ...UNKNOWN_STATUS, id: card.idList ?? UNKNOWN_STATUS.id };
    return card.closed ? { ...status, category: 'canceled' } : status;
}

/** Converts a Trello member to a person or an option. The avatar URL needs a size. */
export function toPerson(member) {
    if (!member) {
        return undefined;
    }
    return {
        id: member.id,
        name: member.fullName || member.username || 'Unknown',
        avatarUrl: member.avatarUrl ? `${member.avatarUrl}/170.png` : undefined
    };
}

/** Converts a Trello label to a task label or an option. A label with no name shows its color. */
export function toLabel(label) {
    return { id: label.id, name: label.name || label.color || 'Label', color: cssColor(label.color) };
}

/** Returns the time of a Trello ID. The first 8 hex digits of an ID are the time of creation in seconds. */
export function idTime(id) {
    const seconds = Number.parseInt(String(id ?? '').slice(0, 8), 16);
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

/** Returns the "Priority" dropdown custom field of a board, or undefined. */
export function priorityField(customFields) {
    return (customFields ?? []).find(field => field.type === 'list' && String(field.name).trim().toLowerCase() === PRIORITY_FIELD);
}

/** Returns the options of a dropdown custom field in board order. */
function sortedOptions(field) {
    return [...(field?.options ?? [])].sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0));
}

/** Returns the priority options of a board. The ID is the level. Level 1 is the first option, which is the highest priority. */
export function priorityOptions(customFields) {
    return sortedOptions(priorityField(customFields)).map((option, index) => ({
        id: String(index + 1),
        name: option.value?.text ?? '',
        color: cssColor(option.color)
    }));
}

/** Returns the priority of a card from the "Priority" custom field, or undefined. */
export function cardPriority(card, customFields) {
    const field = priorityField(customFields);
    const item = field && (card.customFieldItems ?? []).find(entry => entry.idCustomField === field.id);
    if (!item?.idValue) {
        return undefined;
    }
    const options = sortedOptions(field);
    const index = options.findIndex(option => option.id === item.idValue);
    return index === -1 ? undefined : { name: options[index].value?.text ?? '', level: index + 1 };
}

/** Returns the option ID of a priority level, or an empty string for no priority. */
export function priorityOptionId(level, customFields) {
    if (level === null || level === undefined || level === '') {
        return '';
    }
    const option = sortedOptions(priorityField(customFields))[Number(level) - 1];
    if (!option) {
        throw new Error(`The priority "${level}" does not exist on this Trello board.`);
    }
    return option.id;
}

/** The ShipWarden types of the Trello custom field types. */
const FIELD_TYPES = { text: 'text', number: 'number', date: 'date', checkbox: 'boolean', list: 'labels' };

/**
 * Converts the custom fields of a board and the values of a card to custom fields for the task details.
 * The "Priority" field is not in the result, because the task priority shows it.
 */
export function toCustomFields(customFields, items) {
    const values = new Map((items ?? []).map(item => [item.idCustomField, item]));
    const priority = priorityField(customFields);
    return [...(customFields ?? [])]
        .filter(field => field !== priority && FIELD_TYPES[field.type])
        .sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0))
        .map(field => {
            const item = values.get(field.id);
            const result = { id: field.id, label: field.name, type: FIELD_TYPES[field.type], editable: true };
            if (field.type === 'list') {
                const options = sortedOptions(field).map(option => ({ id: option.id, name: option.value?.text ?? '', color: cssColor(option.color) }));
                const selected = options.find(option => option.id === item?.idValue);
                return { ...result, multiple: false, options, labels: selected ? [selected] : [] };
            }
            const value = item?.value;
            if (!value) {
                return result;
            }
            switch (field.type) {
                case 'number':
                    return { ...result, value: Number(value.number) };
                case 'date':
                    return { ...result, value: value.date };
                case 'checkbox':
                    return { ...result, value: value.checked === 'true' };
                default:
                    return { ...result, value: value.text ?? '' };
            }
        });
}

/** Returns the request body that sets a custom field of a card. `value` comes from tasks/update. */
export function customFieldBody(field, value) {
    if (!field) {
        throw new Error('The custom field does not exist on this Trello board.');
    }
    if (field.type === 'list') {
        const id = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
        return { idValue: String(id) };
    }
    if (value === null || value === undefined || value === '') {
        return { value: '' };
    }
    switch (field.type) {
        case 'number':
            if (!Number.isFinite(Number(value))) {
                throw new Error(`"${value}" is not a number.`);
            }
            return { value: { number: String(value) } };
        case 'date':
            return { value: { date: dueValue(String(value)) } };
        case 'checkbox':
            return { value: { checked: value === true || value === 'true' ? 'true' : 'false' } };
        default:
            return { value: { text: String(value) } };
    }
}

/**
 * Converts a date of tasks/update ("YYYY-MM-DD") to a Trello date and time. Null clears the date.
 * The plugin does not know the time zone of the user, so it uses noon UTC. Then the day is the same in most time zones.
 */
export function dueValue(day) {
    if (day === null || day === undefined || day === '') {
        return null;
    }
    const text = String(day);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return `${text}T12:00:00.000Z`;
    }
    if (Number.isFinite(Date.parse(text))) {
        return new Date(text).toISOString();
    }
    throw new Error(`The date "${day}" is not valid. Use the form YYYY-MM-DD.`);
}

/**
 * Converts a card to a task. `board` has the lists (`listsById`) and the custom fields of the board.
 * `withDescription` also adds the description, the details and the editable parts. Only tasks/get and tasks/update use it.
 */
export function toTask(card, board, { withDescription = false } = {}) {
    const customFields = board.customFields ?? [];
    const list = board.listsById.get(card.idList);
    const task = {
        id: card.id,
        key: `#${card.idShort}`,
        title: card.name,
        url: card.shortUrl ?? card.url,
        status: cardStatus(card, board.listsById),
        assignees: (card.members ?? []).map(toPerson),
        labels: (card.labels ?? []).map(toLabel),
        priority: cardPriority(card, customFields),
        updatedAt: card.dateLastActivity,
        fields: { list: list?.name ?? null, due: card.due ?? null }
    };
    if (!withDescription) {
        return task;
    }
    return {
        ...task,
        description: card.desc ?? '',
        details: toDetails(card, board),
        editable: {
            title: true,
            description: true,
            assignees: true,
            labels: true,
            priority: !!priorityField(customFields),
            startDate: true,
            dueDate: true,
            checklists: true
        }
    };
}

/** Returns the details of a card for tasks/get: the place, the dates, the checklists, the attachments and the custom fields. */
export function toDetails(card, board) {
    const list = board.listsById.get(card.idList);
    const checklists = [...(card.checklists ?? [])]
        .sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0))
        .map(checklist => ({
            name: checklist.name,
            items: [...(checklist.checkItems ?? [])]
                .sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0))
                .map(item => ({ id: item.id, name: item.name, done: item.state === 'complete' }))
        }));
    const attachments = (card.attachments ?? []).map(attachment => ({
        name: attachment.name || attachment.url,
        url: attachment.url,
        ...(attachment.bytes ? { size: attachment.bytes } : {}),
        ...(attachment.date ? { createdAt: attachment.date } : {})
    }));
    const customFields = toCustomFields(board.customFields, card.customFieldItems);
    const location = [board.name, list?.name].filter(Boolean).join(' / ');
    return {
        ...(location ? { location } : {}),
        ...(idTime(card.id) ? { createdAt: idTime(card.id) } : {}),
        ...(card.start ? { startDate: card.start } : {}),
        ...(card.due ? { dueDate: card.due } : {}),
        ...(checklists.length ? { checklists } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(customFields.length ? { customFields } : {})
    };
}

/**
 * Converts the card parts of a tasks/update request to the body of PUT /cards/{id}. An empty result means no change.
 * The labels, the priority, the custom fields and the checklist items need other requests. The caller sends them.
 */
export function cardUpdate({ status, title, description, assignees, labels, startDate, dueDate, timeEstimate }) {
    if (timeEstimate !== undefined) {
        throw new Error('Trello cards do not have an estimate in time. Use a custom field.');
    }
    const body = {};
    if (status) {
        body.idList = status;
    }
    if (title !== undefined) {
        if (!String(title ?? '').trim()) {
            throw new Error('A card must have a title.');
        }
        body.name = String(title).trim();
    }
    if (description !== undefined) {
        body.desc = description ?? '';
    }
    if (assignees !== undefined) {
        body.idMembers = (assignees ?? []).join(',');
    }
    if (labels !== undefined) {
        body.idLabels = (labels ?? []).join(',');
    }
    if (startDate !== undefined) {
        body.start = dueValue(startDate);
    }
    if (dueDate !== undefined) {
        body.due = dueValue(dueDate);
    }
    return body;
}

/** Returns true when a card matches the search text: the title, the number (for example "#42" or "42") or the description. */
export function matchesQuery(card, query) {
    const text = String(query ?? '')
        .trim()
        .toLowerCase();
    if (!text) {
        return true;
    }
    const number = /^#?(\d+)$/.exec(text);
    if (number && String(card.idShort) === number[1]) {
        return true;
    }
    return (
        String(card.name ?? '')
            .toLowerCase()
            .includes(text) ||
        String(card.desc ?? '')
            .toLowerCase()
            .includes(text)
    );
}

/**
 * Filters the cards of a board for the task list. Filters: "assigned" (open cards of the user),
 * "open" (cards that are not in a done or canceled list) and "all" (all cards, also archived cards).
 */
export function filterCards(cards, { filter = 'assigned', query, meId, listsById }) {
    return cards.filter(card => {
        if (filter !== 'all') {
            const category = cardStatus(card, listsById).category;
            if (category === 'done' || category === 'canceled') {
                return false;
            }
        }
        if (filter === 'assigned' && !(card.idMembers ?? []).includes(meId)) {
            return false;
        }
        return matchesQuery(card, query);
    });
}

/**
 * Converts boards to collections. The path is the name of the workspace. `defaultBoardId` marks the board that the
 * picker selects first.
 */
export function toCollections(boards, defaultBoardId) {
    return boards.map(board => ({
        id: board.id,
        name: board.name,
        path: board.organization?.displayName ?? 'Personal boards',
        url: board.url,
        ...(board.id === defaultBoardId ? { default: true } : {})
    }));
}

/** Returns the scope ID of a board: the workspace ID, or "personal" for a board that is not in a workspace. */
export function boardScope(board) {
    return board.idOrganization || PERSONAL_SCOPE;
}

/** Returns the scopes of the boards: one for each workspace, and one for the boards that are not in a workspace. */
export function toScopes(boards) {
    const scopes = new Map();
    for (const board of boards) {
        const id = boardScope(board);
        if (!scopes.has(id)) {
            scopes.set(
                id,
                id === PERSONAL_SCOPE
                    ? { id, name: 'Personal boards', detail: 'Boards that are not in a workspace' }
                    : { id, name: board.organization?.displayName ?? id }
            );
        }
    }
    return [...scopes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns the ID of the board that has the most cards, or undefined for no cards. */
export function busiestBoard(cards) {
    const counts = new Map();
    for (const card of cards) {
        if (card.idBoard) {
            counts.set(card.idBoard, (counts.get(card.idBoard) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Converts a "commentCard" action to a comment. */
export function toComment(action) {
    return {
        id: action.id,
        author: toPerson(action.memberCreator),
        body: action.data?.text ?? '',
        createdAt: action.date
    };
}

/** Returns the actions with the oldest first. The task view shows the oldest first. */
export function oldestFirst(actions) {
    return [...actions].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/**
 * Returns the text of a new comment. A mention "@Full Name" becomes "@username", so Trello notifies the person.
 * A reference with a URL gets the URL after its text, because Trello has no links to other cards in comments.
 */
export function commentText(body, { mentions = [], references = [], usernames = new Map() } = {}) {
    let text = String(body ?? '');
    for (const mention of mentions) {
        const username = usernames.get(mention.id);
        if (username) {
            text = text.split(`@${mention.name}`).join(`@${username}`);
        }
    }
    for (const reference of references) {
        if (reference.url && reference.text && !reference.text.includes(reference.url)) {
            text = text.split(reference.text).join(`${reference.text} (${reference.url})`);
        }
    }
    return text;
}

/**
 * Returns the Dashboard comments of the cards: comments from other people, newer than `sinceMs` and newer than the
 * user's own last comment on the same card. Each card has its "commentCard" actions in `comments`.
 */
export function activityComments(cards, meId, sinceMs) {
    return cards.flatMap(card => {
        const comments = card.comments ?? [];
        const own = comments.filter(action => action.idMemberCreator === meId).map(action => Date.parse(action.date));
        const after = Math.max(sinceMs, ...own);
        return oldestFirst(comments)
            .filter(action => action.idMemberCreator !== meId && Date.parse(action.date) > after)
            .map(action => ({
                id: action.id,
                taskId: card.id,
                taskKey: `#${card.idShort}`,
                taskTitle: card.name,
                taskUrl: card.shortUrl,
                author: toPerson(action.memberCreator)?.name,
                body: action.data?.text ?? '',
                createdAt: action.date
            }));
    });
}

/**
 * Returns the time in milliseconds to wait after a rate limit. Trello limits the requests in windows of 10 seconds.
 * It uses the "Retry-After" header (seconds), else 5 seconds. The result is between 1 second and `maxMs`.
 */
export function retryDelay(headers, maxMs) {
    const retryAfter = Number(headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000;
    return Math.min(Math.max(delay, 1000), maxMs);
}
