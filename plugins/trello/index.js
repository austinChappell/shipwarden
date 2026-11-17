// A ShipWarden task plugin for Trello. Each Trello board is a collection, and each list on the board is a status.
// The plugin uses the Trello REST API through the HTTP client of Node.js. It has no dependencies.
import { log, networkDetail, runPlugin } from '../sdk/index.js';
import {
    activityComments,
    boardScope,
    boardStatusOrder,
    busiestBoard,
    CARD_FIELDS,
    cardUpdate,
    commentText,
    customFieldBody,
    filterCards,
    MEMBER_FIELDS,
    oldestFirst,
    priorityField,
    priorityOptionId,
    priorityOptions,
    retryDelay,
    toCollections,
    toComment,
    toLabel,
    toPerson,
    toScopes,
    toStatus,
    toTask
} from './map.js';

const API = 'https://api.trello.com/1';
/** The plugin keeps the boards, the lists, the labels, the members and the custom fields for 10 minutes. */
const CACHE_MS = 10 * 60 * 1000;
/** The plugin waits for a rate limit only when the wait is shorter than this time. */
const MAX_RETRY_WAIT_MS = 15 * 1000;
/** The number of retries after a rate limit. */
const MAX_RETRIES = 2;
/** The time limit of one request. */
const REQUEST_TIMEOUT_MS = 30 * 1000;
/** The Dashboard reads the comments of this number of recently changed cards, at most. */
const ACTIVITY_CARDS = 40;

let authorization;
/** The user of the token. */
let me;
/** All open boards of the user. The settings page lists their workspaces as scopes. */
let allBoards = [];
/** The scope IDs of the connection (workspace IDs or "personal"). Undefined means all boards. */
let scopeIds;
/** The collections, with the time of the load. */
let collectionsCache;
/** The lists of each board, with the time of the load. */
const boardLists = new Map();
/** The custom field definitions of each board, with the time of the load. */
const boardFields = new Map();
/** The labels of each board, with the time of the load. */
const boardLabels = new Map();
/** The members of each board, with the time of the load. */
const boardMembers = new Map();
/** The board ID of each card that the plugin loaded. The options of a card come from its board. */
const boardOfCard = new Map();

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sends a request to the Trello REST API and returns the JSON result.
 * `query` goes in the URL. `body` is a JSON body for POST and PUT. It waits and tries again after a rate limit.
 */
async function trello(method, path, { query, body } = {}, attempt = 0) {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) {
            url.searchParams.set(key, String(value));
        }
    }
    let response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                // The OAuth header holds the key and the token, so the URL does not contain them.
                Authorization: authorization,
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        throw new Error(`ShipWarden cannot connect to Trello: ${networkDetail(error)}`);
    }
    const text = await response.text().catch(() => '');
    if (response.status === 429) {
        const delay = retryDelay(response.headers, Number.POSITIVE_INFINITY);
        if (attempt < MAX_RETRIES && delay <= MAX_RETRY_WAIT_MS) {
            log(`Trello limits the request rate. The plugin waits ${Math.round(delay / 1000)} seconds.`);
            await wait(delay);
            return trello(method, path, { query, body }, attempt + 1);
        }
        throw new Error('Trello limits the request rate. Try again in a few seconds.');
    }
    if (response.status === 401) {
        throw new Error('Trello did not accept the API key or the token. Make a new token. Then change the token in Settings > Task managers.');
    }
    if (!response.ok) {
        throw new Error(`Trello returned an error (${response.status}): ${errorText(text) || response.statusText}`);
    }
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('Trello returned a response that is not JSON.');
    }
}

/** Returns the error text of a Trello response. Trello sends plain text or JSON with a "message". */
function errorText(text) {
    try {
        const body = JSON.parse(text);
        return body?.message ?? body?.error ?? text;
    } catch {
        return text.trim();
    }
}

/** Returns the value of `key` in `cache`. When the value is absent or older than 10 minutes, the plugin calls `load` again. */
async function cached(cache, key, load) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.at < CACHE_MS) {
        return entry.value;
    }
    const value = await load();
    cache.set(key, { value, at: Date.now() });
    return value;
}

async function loadBoards() {
    return trello('GET', '/members/me/boards', {
        query: { filter: 'open', fields: 'name,url,idOrganization,closed', organization: 'true', organization_fields: 'displayName,name' }
    });
}

/** Returns the boards in the connection's scope. */
function boardsInScope() {
    return scopeIds ? allBoards.filter(board => scopeIds.includes(boardScope(board))) : allBoards;
}

/** Returns all lists of a board, also the archived lists, because an archived card can be in an archived list. */
function listsOfBoard(boardId) {
    return cached(boardLists, boardId, () => trello('GET', `/boards/${boardId}/lists`, { query: { filter: 'all', fields: 'name,pos,closed,color' } }));
}

function customFieldsOfBoard(boardId) {
    return cached(boardFields, boardId, () => trello('GET', `/boards/${boardId}/customFields`));
}

function labelsOfBoard(boardId) {
    return cached(boardLabels, boardId, () => trello('GET', `/boards/${boardId}/labels`, { query: { fields: 'name,color', limit: 1000 } }));
}

function membersOfBoard(boardId) {
    return cached(boardMembers, boardId, () => trello('GET', `/boards/${boardId}/members`, { query: { fields: MEMBER_FIELDS } }));
}

/** Returns what `toTask` needs about a board: the name, the lists by ID and the custom fields. */
async function boardContext(boardId) {
    const [lists, customFields] = await Promise.all([listsOfBoard(boardId), customFieldsOfBoard(boardId)]);
    const name = allBoards.find(board => board.id === boardId)?.name;
    return { name, listsById: new Map(lists.map(list => [list.id, list])), customFields };
}

/** Returns the board ID of a card. */
async function boardOf(cardId) {
    const known = boardOfCard.get(cardId);
    if (known) {
        return known;
    }
    const card = await trello('GET', `/cards/${cardId}`, { query: { fields: 'idBoard' } });
    boardOfCard.set(cardId, card.idBoard);
    return card.idBoard;
}

/** Loads a card with its description, members, checklists, attachments and custom field values, as a task. */
async function loadCard(id) {
    const card = await trello('GET', `/cards/${id}`, {
        query: {
            fields: `${CARD_FIELDS},desc`,
            members: 'true',
            member_fields: MEMBER_FIELDS,
            checklists: 'all',
            checklist_fields: 'name,pos',
            attachments: 'true',
            attachment_fields: 'name,url,bytes,date',
            customFieldItems: 'true'
        }
    });
    boardOfCard.set(card.id, card.idBoard);
    return toTask(card, await boardContext(card.idBoard), { withDescription: true });
}

/** Returns the label IDs for tasks/update. A name that is not a label of the board becomes a new label. */
async function labelIds(boardId, values) {
    const labels = await labelsOfBoard(boardId);
    const ids = [];
    for (const value of values ?? []) {
        const known = labels.find(label => label.id === value) ?? labels.find(label => label.name && label.name.toLowerCase() === String(value).toLowerCase());
        if (known) {
            ids.push(known.id);
            continue;
        }
        const created = await trello('POST', `/boards/${boardId}/labels`, { body: { name: String(value), color: null } });
        boardLabels.delete(boardId);
        ids.push(created.id);
    }
    return ids;
}

/** Sets a custom field of a card. `field` is the definition. */
function setCustomField(cardId, field, value) {
    return trello('PUT', `/cards/${cardId}/customField/${field.id}/item`, { body: customFieldBody(field, value) });
}

runPlugin({
    async initialize({ settings, scope }) {
        const apiKey = String(settings.apiKey ?? '').trim();
        const token = String(settings.token ?? '').trim();
        if (!apiKey || !token) {
            throw new Error('The Trello connection needs an API key and a token. Add them in Settings > Task managers.');
        }
        authorization = `OAuth oauth_consumer_key="${apiKey}", oauth_token="${token}"`;
        me = await trello('GET', '/members/me', { query: { fields: `id,${MEMBER_FIELDS}` } });
        allBoards = await loadBoards();
        if (allBoards.length === 0) {
            throw new Error('The Trello token has no access to an open board.');
        }
        scopeIds = scope;
        if (boardsInScope().length === 0) {
            throw new Error('The token has no access to boards in the selected Trello workspaces. Change the workspaces in Settings > Task managers.');
        }
        log(`The Trello plugin is ready for ${me.fullName || me.username}.`);
        return {
            capabilities: { edit: true },
            fields: [
                { id: 'list', label: 'List', type: 'text' },
                { id: 'due', label: 'Due', type: 'date' }
            ],
            actions: [
                { id: 'assign-me', label: 'Add me to the card' },
                { id: 'unassign-me', label: 'Remove me from the card' },
                { id: 'archive', label: 'Archive the card', confirm: 'Archive this card in Trello?' }
            ],
            filters: [
                { id: 'assigned', label: 'Assigned to me', default: true },
                { id: 'open', label: 'All open cards' },
                { id: 'all', label: 'All cards, with done and archived cards' }
            ]
        };
    },

    /** The workspaces of the user's boards. The settings page lets the user restrict the connection to some of them. */
    async listScopes() {
        return toScopes(allBoards);
    },

    /** Each board in the scope is a collection. The board with the most open cards of the user is the default. */
    async listCollections() {
        if (collectionsCache && Date.now() - collectionsCache.at < CACHE_MS) {
            return collectionsCache.collections;
        }
        const boards = boardsInScope();
        const ids = new Set(boards.map(board => board.id));
        const cards = await trello('GET', '/members/me/cards', { query: { filter: 'open', fields: 'idBoard' } }).catch(error => {
            log(`The plugin cannot find the default board: ${error.message}`);
            return [];
        });
        const busiest = busiestBoard(cards.filter(card => ids.has(card.idBoard)));
        const collections = toCollections(boards, busiest);
        collectionsCache = { collections, at: Date.now() };
        return collections;
    },

    /** Trello sends all cards of a board in one response, so the list has no next page. */
    async listTasks({ collection, filter = 'assigned', query }) {
        if (!collection) {
            throw new Error('Select a Trello board.');
        }
        const [cards, board] = await Promise.all([
            trello('GET', `/boards/${collection}/cards/${filter === 'all' ? 'all' : 'open'}`, {
                query: { fields: `${CARD_FIELDS},desc`, members: 'true', member_fields: MEMBER_FIELDS, customFieldItems: 'true' }
            }),
            boardContext(collection)
        ]);
        for (const card of cards) {
            boardOfCard.set(card.id, card.idBoard);
        }
        return {
            tasks: filterCards(cards, { filter, query, meId: me.id, listsById: board.listsById }).map(card => toTask(card, board))
        };
    },

    async getTask({ id }) {
        return loadCard(id);
    },

    /** Makes a card at the top of a list. `status` is a list ID. Without it, the card goes in the first open list. */
    async createTask({ collection, title, description, status }) {
        const name = String(title ?? '').trim();
        if (!name) {
            throw new Error('A card must have a title.');
        }
        if (!collection && !status) {
            throw new Error('Select a Trello board.');
        }
        const idList = status || boardStatusOrder(await listsOfBoard(collection))[0]?.id;
        if (!idList) {
            throw new Error('The Trello board has no open list. Add a list in Trello first.');
        }
        const card = await trello('POST', '/cards', { body: { idList, name, desc: description ?? '', pos: 'top' } });
        return loadCard(card.id);
    },

    /**
     * Changes one part of a card. The part is the list, the title, the description, the members, the labels or a date.
     * It can also be the priority, a custom field or a checklist item.
     */
    async updateTask(params) {
        const { id, labels, priority, customField, checklistItem, ...rest } = params;
        const boardId = await boardOf(id);
        const body = cardUpdate(rest);
        if (labels !== undefined) {
            body.idLabels = (await labelIds(boardId, labels)).join(',');
        }
        if (Object.keys(body).length > 0) {
            await trello('PUT', `/cards/${id}`, { body });
        }
        if (priority !== undefined) {
            const fields = await customFieldsOfBoard(boardId);
            const field = priorityField(fields);
            if (!field) {
                throw new Error('This Trello board has no "Priority" dropdown custom field.');
            }
            await setCustomField(id, field, priorityOptionId(priority, fields));
        }
        if (customField) {
            const field = (await customFieldsOfBoard(boardId)).find(item => item.id === customField.id);
            await setCustomField(id, field, customField.value);
        }
        if (checklistItem) {
            await trello('PUT', `/cards/${id}/checkItem/${checklistItem.id}`, { body: { state: checklistItem.done ? 'complete' : 'incomplete' } });
        }
        return loadCard(id);
    },

    /**
     * Returns the choices for a part of a card. The assignee choices are the members of the board.
     * The label choices are the labels of the board, and the user can type a new label.
     * The priority choices are the options of the "Priority" custom field.
     */
    async listOptions({ id, part }) {
        const boardId = await boardOf(id);
        if (part === 'assignees') {
            return { options: (await membersOfBoard(boardId)).map(toPerson).sort((a, b) => a.name.localeCompare(b.name)) };
        }
        if (part === 'labels') {
            return { options: (await labelsOfBoard(boardId)).map(toLabel).sort((a, b) => a.name.localeCompare(b.name)), create: true };
        }
        if (part === 'priority') {
            return { options: priorityOptions(await customFieldsOfBoard(boardId)) };
        }
        throw new Error(`Trello cards have no options for "${part}".`);
    },

    /** The members of the board can be assignees. */
    async listPeople({ collection }) {
        const members = await membersOfBoard(collection);
        return { people: members.map(toPerson), me: me.id };
    },

    /** The open lists of the board, in board order. */
    async statusOrder({ collection }) {
        return { statuses: boardStatusOrder(await listsOfBoard(collection)) };
    },

    /** The statuses of a card are the open lists of its board. */
    async listStatuses({ id }) {
        if (!id) {
            return [];
        }
        const lists = await listsOfBoard(await boardOf(id));
        return lists
            .filter(list => !list.closed)
            .map(toStatus)
            .sort((a, b) => a.order - b.order);
    },

    async listComments({ taskId }) {
        const actions = await trello('GET', `/cards/${taskId}/actions`, {
            query: { filter: 'commentCard', limit: 1000, memberCreator_fields: MEMBER_FIELDS }
        });
        return oldestFirst(actions).map(toComment);
    },

    /** Adds a comment. A mention becomes a Trello "@username" mention, so Trello notifies the person. */
    async createComment({ taskId, body, mentions, references }) {
        let usernames = new Map();
        if (mentions?.length) {
            const members = await membersOfBoard(await boardOf(taskId)).catch(() => []);
            usernames = new Map(members.map(member => [member.id, member.username]));
        }
        const text = commentText(body, { mentions, references, usernames });
        const action = await trello('POST', `/cards/${taskId}/actions/comments`, { body: { text } });
        return toComment({ ...action, memberCreator: action.memberCreator ?? me });
    },

    async runAction({ taskId, actionId }) {
        switch (actionId) {
            case 'assign-me': {
                const card = await trello('GET', `/cards/${taskId}`, { query: { fields: 'idMembers' } });
                if (!card.idMembers.includes(me.id)) {
                    await trello('POST', `/cards/${taskId}/idMembers`, { query: { value: me.id } });
                }
                return { message: 'You are a member of the card now.' };
            }
            case 'unassign-me': {
                const card = await trello('GET', `/cards/${taskId}`, { query: { fields: 'idMembers' } });
                if (card.idMembers.includes(me.id)) {
                    await trello('DELETE', `/cards/${taskId}/idMembers/${me.id}`);
                }
                return { message: 'You are not a member of the card now.' };
            }
            case 'archive':
                await trello('PUT', `/cards/${taskId}`, { body: { closed: true } });
                return { message: 'Trello archived the card. You can restore it in Trello.' };
            default:
                throw new Error(`The action "${actionId}" does not exist for Trello cards.`);
        }
    },

    /** Returns the comments for the Dashboard. These are comments from other people on the cards of the user, newer than `since`. */
    async listActivity({ since }) {
        const sinceMs = Date.parse(since);
        if (!Number.isFinite(sinceMs)) {
            throw new Error('activity/list needs "since" as an ISO time.');
        }
        const boards = new Set(boardsInScope().map(board => board.id));
        const cards = await trello('GET', '/members/me/cards', { query: { filter: 'open', fields: 'name,idShort,shortUrl,idBoard,dateLastActivity' } });
        const recent = cards
            .filter(card => boards.has(card.idBoard) && Date.parse(card.dateLastActivity) > sinceMs)
            .sort((a, b) => Date.parse(b.dateLastActivity) - Date.parse(a.dateLastActivity))
            .slice(0, ACTIVITY_CARDS);
        const sinceIso = new Date(sinceMs).toISOString();
        const withComments = await Promise.all(
            recent.map(async card => ({
                ...card,
                comments: await trello('GET', `/cards/${card.id}/actions`, {
                    query: { filter: 'commentCard', since: sinceIso, memberCreator_fields: MEMBER_FIELDS }
                })
            }))
        );
        return { comments: activityComments(withComments, me.id, sinceMs) };
    }
});
