import { describe, expect, it } from 'vitest';
import { createHandlers } from './handlers.js';

const SITE = 'https://acme.atlassian.net';
const SETTINGS = { site: 'acme', email: 'ann@acme.com', apiToken: 'tok' };
const statusOf = (id, name, key) => ({ id, name, statusCategory: { key, colorName: 'blue-gray' } });

const issue = (id, key, extra = {}) => ({
    id,
    key,
    fields: { summary: `Issue ${key}`, status: statusOf('1', 'To Do', 'new'), project: { id: '10000', key: 'ENG', name: 'Engineering' }, ...extra }
});

/**
 * Makes a fetch that answers from routes. A route key is "METHOD /path" after "/rest/api/3". A route value is a
 * response body, or a function that gets the URL and the request and returns a body or a Response.
 * The fetch records each call.
 */
function fixtureFetch(routes) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const parsed = new URL(url);
        const path = parsed.pathname.replace('/rest/api/3', '');
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, path, query: Object.fromEntries(parsed.searchParams), body, headers: init.headers });
        const route = routes[`${method} ${path}`];
        if (route === undefined) {
            return new Response(JSON.stringify({ errorMessages: [`No fixture for ${method} ${path}`] }), { status: 404 });
        }
        const result = typeof route === 'function' ? await route(parsed, body, calls) : route;
        if (result instanceof Response) {
            return result;
        }
        return result === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(result), { status: 200 });
    };
    return { fetch, calls };
}

const BASE_ROUTES = {
    'GET /myself': { accountId: 'acc-me', displayName: 'Me' },
    'GET /field': [{ id: 'customfield_10020', name: 'Sprint', schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }],
    'GET /project/search': url =>
        url.searchParams.get('startAt') === '0'
            ? { values: [{ id: '10000', key: 'ENG', name: 'Engineering' }], isLast: false }
            : { values: [{ id: '10001', key: 'OPS', name: 'Operations' }], isLast: true }
};

async function start(routes = {}, params = {}) {
    const { fetch, calls } = fixtureFetch({ ...BASE_ROUTES, ...routes });
    const waits = [];
    const { handlers } = createHandlers({ fetch, now: () => Date.parse('2026-11-19T12:00:00Z'), wait: async ms => waits.push(ms) });
    const result = await handlers.initialize({ settings: SETTINGS, protocolVersion: 3, context: { repositories: [] }, ...params });
    return { handlers, calls, waits, result };
}

describe('Jira plugin handlers', () => {
    it('signs in with Basic auth, reads all pages of the projects, and finds the sprint field', async () => {
        const { handlers, calls, result } = await start();
        expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('ann@acme.com:tok').toString('base64')}`);
        expect(calls.filter(call => call.path === '/project/search').map(call => call.query.startAt)).toEqual(['0', '1']);
        expect(result.filters.map(filter => filter.id)).toEqual(['assigned', 'sprint', 'open', 'all']);
        expect(await handlers.listScopes({})).toEqual([
            { id: '10000', name: 'Engineering', detail: 'ENG' },
            { id: '10001', name: 'Operations', detail: 'OPS' }
        ]);
    });

    it('refuses a connection without an email or a token', async () => {
        const { handlers } = createHandlers({ fetch: async () => new Response('{}') });
        await expect(handlers.initialize({ settings: { site: 'acme', email: '', apiToken: '' } })).rejects.toThrow(
            'email of your Atlassian account and an API token'
        );
    });

    it('explains a refused token', async () => {
        const { fetch } = fixtureFetch({ 'GET /myself': () => new Response('Unauthorized', { status: 401 }) });
        const { handlers } = createHandlers({ fetch });
        await expect(handlers.initialize({ settings: SETTINGS })).rejects.toThrow('Jira did not accept the email and the API token');
    });

    it('explains a certificate error of a network that inspects TLS', async () => {
        const fetch = async () => {
            throw new TypeError('fetch failed', { cause: Object.assign(new Error('self-signed certificate'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) });
        };
        const { handlers } = createHandlers({ fetch });
        await expect(handlers.initialize({ settings: SETTINGS })).rejects.toThrow(/cannot connect to Jira.*SELF_SIGNED_CERT_IN_CHAIN.*Settings › Network/);
    });

    it('waits and tries again after a rate limit', async () => {
        let count = 0;
        const { handlers, waits } = await start({
            'GET /project/10000/statuses': () =>
                ++count === 1
                    ? new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })
                    : [{ name: 'Task', statuses: [statusOf('1', 'To Do', 'new')] }]
        });
        expect(await handlers.statusOrder({ collection: '10000' })).toEqual({ statuses: [{ id: '1', name: 'To Do', color: '#8590a2', category: 'todo' }] });
        expect(waits).toEqual([2000]);
    });

    it('limits the connection to the projects of the scope', async () => {
        const { handlers, calls } = await start({ 'POST /search/jql': { issues: [], isLast: true } }, { scope: ['10001'] });
        const collections = await handlers.listCollections({});
        expect(collections.map(collection => collection.id)).toEqual(['10001']);
        expect(calls.at(-1).body.jql).toContain('project in ("10001")');
    });

    it('lists tasks with the enhanced JQL search and pages with nextPageToken', async () => {
        const { handlers, calls } = await start({
            'POST /search/jql': (_url, body) =>
                body.nextPageToken ? { issues: [issue('2', 'ENG-2')], isLast: true } : { issues: [issue('1', 'ENG-1')], nextPageToken: 'page-2', isLast: false }
        });
        const first = await handlers.listTasks({ collection: '10000', filter: 'open' });
        expect(first.tasks.map(task => task.key)).toEqual(['ENG-1']);
        expect(first.nextCursor).toBe('page-2');
        const search = calls.at(-1);
        expect(search.body.jql).toBe('project = "10000" AND statusCategory != Done ORDER BY updated DESC');
        expect(search.body.fields).toContain('customfield_10020');
        expect(search.body.nextPageToken).toBeUndefined();

        const second = await handlers.listTasks({ collection: '10000', filter: 'open', cursor: 'page-2' });
        expect(calls.at(-1).body.nextPageToken).toBe('page-2');
        expect(second).toMatchObject({ tasks: [{ key: 'ENG-2' }], nextCursor: undefined });
    });

    it('adds the issue of a key query to the first page', async () => {
        const { handlers } = await start({
            'POST /search/jql': { issues: [issue('1', 'ENG-1')], isLast: true },
            'GET /issue/ENG-12': issue('12', 'ENG-12')
        });
        const page = await handlers.listTasks({ collection: '10000', filter: 'all', query: 'eng-12' });
        expect(page.tasks.map(task => task.key)).toEqual(['ENG-12', 'ENG-1']);
    });

    it('changes the status with the transition that goes to it', async () => {
        const { handlers, calls } = await start({
            'GET /issue/10042/transitions': { transitions: [{ id: '31', name: 'Finish', to: statusOf('10', 'Done', 'done') }] },
            'GET /issue/10042': issue('10042', 'ENG-42'),
            'POST /issue/10042/transitions': null
        });
        const task = await handlers.updateTask({ id: '10042', status: '10' });
        expect(calls.find(call => call.method === 'POST').body).toEqual({ transition: { id: '31' } });
        expect(task.key).toBe('ENG-42');
    });

    it('refuses a status without a transition', async () => {
        const { handlers } = await start({
            'GET /issue/10042/transitions': { transitions: [{ id: '31', name: 'Finish', to: statusOf('10', 'Done', 'done') }] },
            'GET /issue/10042': issue('10042', 'ENG-42')
        });
        await expect(handlers.updateTask({ id: '10042', status: '99' })).rejects.toThrow('The possible statuses are: Done.');
    });

    it('sends the description as ADF', async () => {
        const { handlers, calls } = await start({ 'PUT /issue/10042': null, 'GET /issue/10042': issue('10042', 'ENG-42') });
        await handlers.updateTask({ id: '10042', description: '- One\n- Two' });
        const put = calls.find(call => call.method === 'PUT');
        expect(put.body.fields.description.content[0].type).toBe('bulletList');
    });

    it('lists the statuses that the issue can go to', async () => {
        const { handlers } = await start({
            'GET /issue/10042/transitions': { transitions: [{ id: '31', to: statusOf('10', 'Done', 'done') }] },
            'GET /issue/10042': issue('10042', 'ENG-42')
        });
        expect((await handlers.listStatuses({ id: '10042' })).map(status => status.name)).toEqual(['To Do', 'Done']);
    });

    it('makes a subtask with the subtask type in the project of the parent', async () => {
        const { handlers, calls } = await start({
            'GET /issue/10042': issue('10042', 'ENG-42'),
            'GET /issue/createmeta/10000/issuetypes': {
                issueTypes: [
                    { id: '3', name: 'Task', subtask: false },
                    { id: '5', name: 'Subtask', subtask: true }
                ],
                total: 2
            },
            'POST /issue': { id: '10099', key: 'ENG-99' },
            'GET /issue/10099': issue('10099', 'ENG-99')
        });
        const task = await handlers.createTask({ collection: '10001', title: 'Child', parent: '10042' });
        expect(calls.find(call => call.method === 'POST' && call.path === '/issue').body.fields).toEqual({
            project: { id: '10000' },
            issuetype: { id: '5' },
            summary: 'Child',
            parent: { id: '10042' }
        });
        expect(task.key).toBe('ENG-99');
    });

    it('reads all pages of the comments and posts a comment with a native mention', async () => {
        const body = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
        const { handlers, calls } = await start({
            'GET /issue/10042/comment': url =>
                url.searchParams.get('startAt') === '0'
                    ? {
                          comments: Array.from({ length: 50 }, (_, index) => ({ id: String(index), created: '2026-11-07T10:00:00.000+0000', body: body('x') })),
                          total: 51
                      }
                    : { comments: [{ id: '50', created: '2026-11-08T10:00:00.000+0000', body: body('Last') }], total: 51 },
            'POST /issue/10042/comment': (_url, request) => ({
                id: '77',
                author: { accountId: 'acc-me', displayName: 'Me' },
                created: '2026-11-19T12:00:00.000+0000',
                body: request.body
            })
        });
        const comments = await handlers.listComments({ taskId: '10042' });
        expect(comments).toHaveLength(51);
        expect(comments.at(-1).body).toBe('Last');

        const created = await handlers.createComment({ taskId: '10042', body: 'Thanks @Ann Lee', mentions: [{ id: 'acc-ann', name: 'Ann Lee' }] });
        expect(calls.at(-1).body.body.content[0].content).toEqual([
            { type: 'text', text: 'Thanks ' },
            { type: 'mention', attrs: { id: 'acc-ann', text: '@Ann Lee' } }
        ]);
        expect(created.body).toBe('Thanks @Ann Lee');
    });

    it('lists the people of a project and the user ID', async () => {
        const { handlers, calls } = await start({
            'GET /user/assignable/search': [
                { accountId: 'acc-ann', displayName: 'Ann', active: true },
                { accountId: 'bot', displayName: 'Bot', accountType: 'app' }
            ]
        });
        expect(await handlers.listPeople({ collection: '10000' })).toEqual({ people: [{ id: 'acc-ann', name: 'Ann', avatarUrl: undefined }], me: 'acc-me' });
        expect(calls.at(-1).query).toMatchObject({ project: '10000', startAt: '0', maxResults: '50' });
    });

    it('reads the Dashboard comments with one search', async () => {
        const { handlers, calls } = await start({
            'POST /search/jql': {
                issues: [
                    {
                        id: '1',
                        key: 'ENG-1',
                        fields: {
                            summary: 'One',
                            comment: {
                                comments: [{ id: 'c', author: { accountId: 'bob', displayName: 'Bob' }, created: '2026-11-19T11:30:00.000+0000', body: null }]
                            }
                        }
                    }
                ],
                isLast: true
            }
        });
        const { comments } = await handlers.listActivity({ since: '2026-11-19T11:00:00Z' });
        expect(calls.at(-1).body).toMatchObject({ jql: 'assignee = currentUser() AND updated >= -60m ORDER BY updated DESC', fields: ['summary', 'comment'] });
        expect(comments).toMatchObject([{ id: 'c', taskKey: 'ENG-1', author: 'Bob', taskUrl: `${SITE}/browse/ENG-1` }]);
    });
});
