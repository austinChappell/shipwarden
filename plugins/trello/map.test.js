import { describe, expect, it } from 'vitest';
import * as trello from './map.js';

const list = (id, name, pos, extra = {}) => ({ id, name, pos, closed: false, ...extra });
const lists = [
    list('l-next', 'Up Next', 100),
    list('l-progress', 'In Progress', 200),
    list('l-done', 'Done 🎉', 300),
    list('l-old', 'Old', 50, { closed: true })
];

const priority = {
    id: 'cf-priority',
    name: 'Priority',
    type: 'list',
    pos: 1,
    options: [
        { id: 'o-low', value: { text: 'Low' }, color: 'sky', pos: 3 },
        { id: 'o-high', value: { text: 'High' }, color: 'red', pos: 1 },
        { id: 'o-medium', value: { text: 'Medium' }, color: 'yellow', pos: 2 }
    ]
};
const duration = { id: 'cf-duration', name: 'Estimated Duration', type: 'text', pos: 2 };
const estimate = { id: 'cf-estimate', name: 'Estimate', type: 'number', pos: 3 };
const shipped = { id: 'cf-shipped', name: 'Shipped', type: 'checkbox', pos: 4 };
const completed = { id: 'cf-completed', name: 'Completed Date', type: 'date', pos: 5 };
const customFields = [estimate, priority, duration, shipped, completed];

const board = { name: 'Waffling Doughnut$', listsById: new Map(lists.map(item => [item.id, item])), customFields };

const card = {
    id: '68cc57b8046e250ea61fe457',
    idShort: 42,
    name: 'Fix the login page',
    shortUrl: 'https://trello.com/c/abc123',
    idList: 'l-progress',
    idBoard: 'b1',
    idMembers: ['m1'],
    members: [{ id: 'm1', fullName: 'Ann Lee', username: 'annlee', avatarUrl: 'https://trello-members.s3.amazonaws.com/m1/abc' }],
    labels: [
        { id: 'lb1', name: 'Bug', color: 'red' },
        { id: 'lb2', name: '', color: 'green_dark' }
    ],
    due: '2026-11-20T12:00:00.000Z',
    start: null,
    dateLastActivity: '2026-11-07T10:00:00.000Z',
    closed: false,
    desc: '## Steps',
    customFieldItems: [
        { idCustomField: 'cf-priority', idValue: 'o-medium' },
        { idCustomField: 'cf-duration', value: { text: '3 days' } },
        { idCustomField: 'cf-estimate', value: { number: '5' } },
        { idCustomField: 'cf-shipped', value: { checked: 'true' } }
    ],
    checklists: [
        {
            name: 'QA',
            pos: 1,
            checkItems: [
                { id: 'ci2', name: 'Test', state: 'incomplete', pos: 2 },
                { id: 'ci1', name: 'Build', state: 'complete', pos: 1 }
            ]
        }
    ],
    attachments: [{ name: 'spec.pdf', url: 'https://example.com/spec.pdf', bytes: 1200, date: '2026-11-01T00:00:00.000Z' }]
};

describe('Trello status categories', () => {
    it('reads the category from the list name', () => {
        const names = {
            'Done 🎉': 'done',
            'Done October 2026': 'done',
            Released: 'done',
            'Merged to Main': 'in_progress',
            'In BE Release Train': 'in_progress',
            'In Progress': 'in_progress',
            'In Review': 'in_progress',
            Blocked: 'in_progress',
            'Waiting on API Customers': 'in_progress',
            'Backend Backlog': 'backlog',
            'Frontend Backlog': 'backlog',
            'Up Next': 'todo',
            'Deactivated Numbers FE': 'todo',
            "Won't do": 'canceled',
            Cancelled: 'canceled'
        };
        for (const [name, category] of Object.entries(names)) {
            expect([name, trello.statusCategory(name)]).toEqual([name, category]);
        }
    });

    it('returns the open lists in board order', () => {
        expect(trello.boardStatusOrder(lists).map(item => item.name)).toEqual(['Up Next', 'In Progress', 'Done 🎉']);
        expect(trello.boardStatusOrder(lists)[0]).toEqual({ id: 'l-next', name: 'Up Next', color: undefined, category: 'todo' });
    });

    it('marks an archived card as canceled', () => {
        expect(trello.cardStatus({ idList: 'l-next', closed: true }, board.listsById).category).toBe('canceled');
        expect(trello.cardStatus({ idList: 'l-gone' }, board.listsById)).toEqual({ id: 'l-gone', name: 'Unknown list', category: 'todo' });
    });
});

describe('Trello card mapping', () => {
    it('maps a card in a list to a task', () => {
        expect(trello.toTask(card, board)).toEqual({
            id: card.id,
            key: '#42',
            title: 'Fix the login page',
            url: 'https://trello.com/c/abc123',
            status: { id: 'l-progress', name: 'In Progress', color: undefined, category: 'in_progress', order: 200 },
            assignees: [{ id: 'm1', name: 'Ann Lee', avatarUrl: 'https://trello-members.s3.amazonaws.com/m1/abc/170.png' }],
            labels: [
                { id: 'lb1', name: 'Bug', color: '#f87168' },
                { id: 'lb2', name: 'green_dark', color: '#4bce97' }
            ],
            priority: { name: 'Medium', level: 2 },
            updatedAt: '2026-11-07T10:00:00.000Z',
            fields: { list: 'In Progress', due: '2026-11-20T12:00:00.000Z' }
        });
    });

    it('adds the description, the details and the editable parts for tasks/get', () => {
        const task = trello.toTask(card, board, { withDescription: true });
        expect(task.description).toBe('## Steps');
        expect(task.editable).toEqual({
            title: true,
            description: true,
            assignees: true,
            labels: true,
            priority: true,
            startDate: true,
            dueDate: true,
            checklists: true
        });
        expect(task.details.location).toBe('Waffling Doughnut$ / In Progress');
        expect(task.details.createdAt).toBe('2025-09-18T19:04:24.000Z');
        expect(task.details.dueDate).toBe('2026-11-20T12:00:00.000Z');
        expect(task.details.checklists).toEqual([
            {
                name: 'QA',
                items: [
                    { id: 'ci1', name: 'Build', done: true },
                    { id: 'ci2', name: 'Test', done: false }
                ]
            }
        ]);
        expect(task.details.attachments).toEqual([
            { name: 'spec.pdf', url: 'https://example.com/spec.pdf', size: 1200, createdAt: '2026-11-01T00:00:00.000Z' }
        ]);
    });

    it('maps the custom fields without the priority field', () => {
        expect(trello.toCustomFields(customFields, card.customFieldItems)).toEqual([
            { id: 'cf-duration', label: 'Estimated Duration', type: 'text', editable: true, value: '3 days' },
            { id: 'cf-estimate', label: 'Estimate', type: 'number', editable: true, value: 5 },
            { id: 'cf-shipped', label: 'Shipped', type: 'boolean', editable: true, value: true },
            { id: 'cf-completed', label: 'Completed Date', type: 'date', editable: true }
        ]);
    });

    it('maps a dropdown custom field to labels with its options', () => {
        const team = { id: 'cf-team', name: 'Team', type: 'list', pos: 1, options: [{ id: 'o-a', value: { text: 'Donut Holes' }, color: 'purple', pos: 1 }] };
        expect(trello.toCustomFields([team], [{ idCustomField: 'cf-team', idValue: 'o-a' }])).toEqual([
            {
                id: 'cf-team',
                label: 'Team',
                type: 'labels',
                editable: true,
                multiple: false,
                options: [{ id: 'o-a', name: 'Donut Holes', color: '#9f8fef' }],
                labels: [{ id: 'o-a', name: 'Donut Holes', color: '#9f8fef' }]
            }
        ]);
    });

    it('has no priority without a "Priority" dropdown field', () => {
        const task = trello.toTask(card, { ...board, customFields: [duration] }, { withDescription: true });
        expect(task.priority).toBeUndefined();
        expect(task.editable.priority).toBe(false);
    });
});

describe('Trello priority', () => {
    it('uses the option order as the level', () => {
        expect(trello.priorityOptions(customFields)).toEqual([
            { id: '1', name: 'High', color: '#f87168' },
            { id: '2', name: 'Medium', color: '#f5cd47' },
            { id: '3', name: 'Low', color: '#6cc3e0' }
        ]);
        expect(trello.priorityOptionId('3', customFields)).toBe('o-low');
        expect(trello.priorityOptionId(null, customFields)).toBe('');
        expect(() => trello.priorityOptionId('9', customFields)).toThrow('does not exist');
    });
});

describe('Trello updates', () => {
    it('converts the card parts of tasks/update to a card body', () => {
        expect(trello.cardUpdate({ status: 'l-done' })).toEqual({ idList: 'l-done' });
        expect(trello.cardUpdate({ title: '  New title ', description: null })).toEqual({ name: 'New title', desc: '' });
        expect(trello.cardUpdate({ assignees: ['m1', 'm2'] })).toEqual({ idMembers: 'm1,m2' });
        expect(trello.cardUpdate({ assignees: [] })).toEqual({ idMembers: '' });
        expect(trello.cardUpdate({ dueDate: '2026-12-01', startDate: null })).toEqual({ due: '2026-12-01T12:00:00.000Z', start: null });
        expect(trello.cardUpdate({})).toEqual({});
    });

    it('refuses an empty title, a bad date and a time estimate', () => {
        expect(() => trello.cardUpdate({ title: ' ' })).toThrow('must have a title');
        expect(() => trello.cardUpdate({ dueDate: 'soon' })).toThrow('not valid');
        expect(() => trello.cardUpdate({ timeEstimate: 1000 })).toThrow('estimate');
    });

    it('makes the body that sets each type of custom field', () => {
        expect(trello.customFieldBody(duration, '2 days')).toEqual({ value: { text: '2 days' } });
        expect(trello.customFieldBody(estimate, 8)).toEqual({ value: { number: '8' } });
        expect(trello.customFieldBody(shipped, false)).toEqual({ value: { checked: 'false' } });
        expect(trello.customFieldBody(completed, '2026-11-17')).toEqual({ value: { date: '2026-11-17T12:00:00.000Z' } });
        expect(trello.customFieldBody(priority, ['o-high'])).toEqual({ idValue: 'o-high' });
        expect(trello.customFieldBody(priority, [])).toEqual({ idValue: '' });
        expect(trello.customFieldBody(duration, null)).toEqual({ value: '' });
        expect(() => trello.customFieldBody(estimate, 'many')).toThrow('not a number');
        expect(() => trello.customFieldBody(undefined, 'x')).toThrow('does not exist');
    });
});

describe('Trello task list', () => {
    const cards = [
        { ...card, id: 'c1', idShort: 1, idList: 'l-next', idMembers: ['me'], name: 'Mine' },
        { ...card, id: 'c2', idShort: 2, idList: 'l-next', idMembers: ['other'], name: 'Theirs' },
        { ...card, id: 'c3', idShort: 3, idList: 'l-done', idMembers: ['me'], name: 'Mine and done' },
        { ...card, id: 'c4', idShort: 4, idList: 'l-next', idMembers: ['me'], name: 'Archived', closed: true }
    ];
    const ids = (filter, query) => trello.filterCards(cards, { filter, query, meId: 'me', listsById: board.listsById }).map(item => item.id);

    it('filters the cards', () => {
        expect(ids('assigned')).toEqual(['c1']);
        expect(ids('open')).toEqual(['c1', 'c2']);
        expect(ids('all')).toEqual(['c1', 'c2', 'c3', 'c4']);
    });

    it('searches the title, the number and the description', () => {
        expect(ids('all', 'theirs')).toEqual(['c2']);
        expect(ids('all', '#3')).toEqual(['c3']);
        expect(ids('open', 'steps')).toEqual(['c1', 'c2']);
    });
});

describe('Trello collections and scopes', () => {
    const boards = [
        { id: 'b1', name: 'Waffling Doughnut$', url: 'https://trello.com/b/1', idOrganization: 'org1', organization: { displayName: 'Text-Em-All' } },
        { id: 'b2', name: 'Groceries', url: 'https://trello.com/b/2', idOrganization: null }
    ];

    it('maps boards to collections with the workspace as the path', () => {
        expect(trello.toCollections(boards, 'b1')).toEqual([
            { id: 'b1', name: 'Waffling Doughnut$', path: 'Text-Em-All', url: 'https://trello.com/b/1', default: true },
            { id: 'b2', name: 'Groceries', path: 'Personal boards', url: 'https://trello.com/b/2' }
        ]);
    });

    it('lists the workspaces and the personal boards as scopes', () => {
        expect(trello.toScopes(boards)).toEqual([
            { id: 'personal', name: 'Personal boards', detail: 'Boards that are not in a workspace' },
            { id: 'org1', name: 'Text-Em-All' }
        ]);
        expect(trello.boardScope(boards[1])).toBe('personal');
    });

    it('finds the board with the most cards', () => {
        expect(trello.busiestBoard([{ idBoard: 'b1' }, { idBoard: 'b2' }, { idBoard: 'b2' }])).toBe('b2');
        expect(trello.busiestBoard([])).toBeUndefined();
    });
});

describe('Trello comments', () => {
    const comment = (id, idMemberCreator, date, text = 'Hi') => ({
        id,
        idMemberCreator,
        date,
        data: { text },
        memberCreator: { id: idMemberCreator, fullName: idMemberCreator === 'me' ? 'Mike' : 'Ann Lee', avatarUrl: null }
    });

    it('maps a comment action', () => {
        expect(trello.toComment(comment('a1', 'ann', '2026-11-07T10:00:00.000Z'))).toEqual({
            id: 'a1',
            author: { id: 'ann', name: 'Ann Lee', avatarUrl: undefined },
            body: 'Hi',
            createdAt: '2026-11-07T10:00:00.000Z'
        });
    });

    it('changes mentions to usernames and adds the URL of a reference', () => {
        const text = trello.commentText('@Ann Lee see #12', {
            mentions: [{ id: 'm1', name: 'Ann Lee' }],
            references: [{ id: 'c12', text: '#12', url: 'https://trello.com/c/xyz' }],
            usernames: new Map([['m1', 'annlee']])
        });
        expect(text).toBe('@annlee see #12 (https://trello.com/c/xyz)');
    });

    it('returns the new comments from other people after the last own comment', () => {
        const since = Date.parse('2026-11-01T00:00:00.000Z');
        const cards = [
            {
                id: 'c1',
                idShort: 7,
                name: 'Fix login',
                shortUrl: 'https://trello.com/c/c1',
                comments: [
                    comment('a1', 'ann', '2026-11-02T00:00:00.000Z', 'Seen'),
                    comment('a2', 'me', '2026-11-03T00:00:00.000Z', 'Mine'),
                    comment('a3', 'ann', '2026-11-04T00:00:00.000Z', 'New')
                ]
            }
        ];
        expect(trello.activityComments(cards, 'me', since)).toEqual([
            {
                id: 'a3',
                taskId: 'c1',
                taskKey: '#7',
                taskTitle: 'Fix login',
                taskUrl: 'https://trello.com/c/c1',
                author: 'Ann Lee',
                body: 'New',
                createdAt: '2026-11-04T00:00:00.000Z'
            }
        ]);
    });
});

describe('Trello rate limit', () => {
    it('uses Retry-After, else waits 5 seconds', () => {
        expect(trello.retryDelay(new Headers({ 'Retry-After': '3' }), 60_000)).toBe(3000);
        expect(trello.retryDelay(new Headers({}), 60_000)).toBe(5000);
        expect(trello.retryDelay(new Headers({ 'Retry-After': '120' }), 10_000)).toBe(10_000);
    });

    it('converts color names to CSS colors', () => {
        expect(trello.cssColor('sky_light')).toBe('#6cc3e0');
        expect(trello.cssColor('none')).toBeUndefined();
        expect(trello.cssColor(null)).toBeUndefined();
    });
});
