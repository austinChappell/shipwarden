import { describe, expect, it } from 'vitest';
import * as jira from './map.js';

const SITE = 'https://acme.atlassian.net';
const category = (key, colorName) => ({ key, colorName });
const status = (id, name, key) => ({ id, name, statusCategory: category(key, { new: 'blue-gray', indeterminate: 'yellow', done: 'green' }[key]) });
const fieldIds = { sprint: 'customfield_10020', storyPoints: 'customfield_10016' };
const ann = { accountId: 'acc-ann', displayName: 'Ann Lee', avatarUrls: { '48x48': 'https://example.com/ann.png' } };

const issue = {
    id: '10042',
    key: 'ENG-42',
    fields: {
        summary: 'Fix the login page',
        status: status('3', 'In Progress', 'indeterminate'),
        assignee: ann,
        labels: ['frontend', 'auth'],
        priority: { id: '2', name: 'High' },
        updated: '2026-11-07T10:00:00.000+0000',
        issuetype: { id: '10001', name: 'Bug' },
        components: [{ name: 'Web' }, { name: 'API' }],
        duedate: '2026-11-20',
        project: { id: '10000', key: 'ENG', name: 'Engineering' },
        customfield_10020: [
            { id: 1, name: 'Sprint 11', state: 'closed' },
            { id: 2, name: 'Sprint 12', state: 'active' }
        ],
        customfield_10016: 3,
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Steps' }] }] },
        reporter: { accountId: 'acc-bob', displayName: 'Bob' },
        created: '2026-11-01T09:00:00.000+0000',
        timeoriginalestimate: 7200,
        timespent: 3600,
        parent: { id: '10001', key: 'ENG-1', fields: { summary: 'Auth epic', status: status('1', 'To Do', 'new') } },
        subtasks: [{ id: '10043', key: 'ENG-43', fields: { summary: 'Add a test', status: status('10', 'Done', 'done') } }],
        issuelinks: [
            {
                type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
                outwardIssue: { id: '10050', key: 'ENG-50', fields: { summary: 'Release' } }
            },
            { type: { name: 'Blocks' }, inwardIssue: { id: '10051', key: 'ENG-51', fields: { summary: 'Design' } } },
            { type: { name: 'Relates' }, outwardIssue: { id: '10052', key: 'ENG-52', fields: { summary: 'Docs' } } }
        ],
        attachment: [
            { filename: 'screen.png', content: `${SITE}/rest/api/3/attachment/content/1`, size: 2048, thumbnail: `${SITE}/thumb/1`, created: '2026-11-02' }
        ]
    }
};

describe('Jira site and auth', () => {
    it('accepts the site name, the host, or a URL', () => {
        expect(jira.parseSite('acme')).toBe(SITE);
        expect(jira.parseSite('acme.atlassian.net')).toBe(SITE);
        expect(jira.parseSite(' https://ACME.atlassian.net/jira/software/projects ')).toBe(SITE);
    });

    it('refuses an empty site and http', () => {
        expect(() => jira.parseSite('')).toThrow('site URL');
        expect(() => jira.parseSite('http://acme.atlassian.net')).toThrow('https');
    });

    it('makes a Basic auth header from the email and the token', () => {
        expect(jira.basicAuth('ann@acme.com', 'tok')).toBe(`Basic ${Buffer.from('ann@acme.com:tok').toString('base64')}`);
    });
});

describe('Jira statuses', () => {
    it('maps the status categories, with backlog and canceled names', () => {
        expect(
            [
                status('1', 'Backlog', 'new'),
                status('2', 'To Do', 'new'),
                status('3', 'In Review', 'indeterminate'),
                status('4', 'Done', 'done'),
                status('5', "Won't Do", 'done'),
                { id: '6', name: 'Odd' }
            ].map(jira.statusCategory)
        ).toEqual(['backlog', 'todo', 'in_progress', 'done', 'canceled', 'todo']);
    });

    it('merges the statuses of the issue types of a project in category order', () => {
        const order = jira.projectStatusOrder([
            { name: 'Bug', statuses: [status('10', 'Done', 'done'), status('1', 'To Do', 'new'), status('3', 'In Progress', 'indeterminate')] },
            { name: 'Task', statuses: [status('1', 'To Do', 'new'), status('4', 'In Review', 'indeterminate')] }
        ]);
        expect(order.map(item => item.name)).toEqual(['To Do', 'In Progress', 'In Review', 'Done']);
        expect(order[0]).toEqual({ id: '1', name: 'To Do', color: '#8590a2', category: 'todo' });
    });

    it('lists the current status and the targets of the transitions', () => {
        const statuses = jira.transitionStatuses(status('3', 'In Progress', 'indeterminate'), [
            { id: '31', name: 'Finish', to: status('10', 'Done', 'done') },
            { id: '11', name: 'Stop', to: status('1', 'To Do', 'new') },
            { id: '41', name: 'Stay', to: status('3', 'In Progress', 'indeterminate') }
        ]);
        expect(statuses.map(item => item.id)).toEqual(['1', '3', '10']);
    });

    it('finds the transition to a status', () => {
        const transitions = [{ id: '31', name: 'Finish', to: status('10', 'Done', 'done') }];
        expect(jira.findTransition(transitions, '10').id).toBe('31');
        expect(() => jira.findTransition(transitions, '99', 'To Do')).toThrow('no transition from "To Do" to this status. The possible statuses are: Done.');
        expect(() => jira.findTransition([], '99')).toThrow('no transition that you can use');
    });
});

describe('Jira issues', () => {
    it('maps an issue to a task with the type, the sprint, the components, and the story points as fields', () => {
        const task = jira.toTask(issue, { site: SITE, fieldIds });
        expect(task).toEqual({
            id: '10042',
            key: 'ENG-42',
            title: 'Fix the login page',
            url: `${SITE}/browse/ENG-42`,
            status: { id: '3', name: 'In Progress', color: '#1d7afc', category: 'in_progress', order: 1000 },
            assignees: [{ id: 'acc-ann', name: 'Ann Lee', avatarUrl: 'https://example.com/ann.png' }],
            labels: [
                { id: 'frontend', name: 'frontend' },
                { id: 'auth', name: 'auth' }
            ],
            priority: { name: 'High', level: 2 },
            updatedAt: '2026-11-07T10:00:00.000Z',
            description: undefined,
            fields: { type: 'Bug', sprint: 'Sprint 12', components: 'Web, API', storyPoints: 3, dueDate: '2026-11-20' }
        });
    });

    it('adds the description as Markdown, the details, and the editable parts for tasks/get', () => {
        const task = jira.toTask(issue, { site: SITE, fieldIds, withDetails: true });
        expect(task.description).toBe('Steps');
        expect(task.editable).toEqual({ title: true, description: true, assignees: true, labels: true, priority: true, dueDate: true });
        expect(task.details).toEqual({
            location: 'Engineering',
            creator: { id: 'acc-bob', name: 'Bob', avatarUrl: undefined },
            createdAt: '2026-11-01T09:00:00.000+0000',
            dueDate: '2026-11-20',
            timeEstimate: 7200000,
            timeSpent: 3600000,
            parent: {
                id: '10001',
                key: 'ENG-1',
                title: 'Auth epic',
                url: `${SITE}/browse/ENG-1`,
                status: { id: '1', name: 'To Do', color: '#8590a2', category: 'todo', order: 0 }
            },
            subtasks: [
                {
                    id: '10043',
                    key: 'ENG-43',
                    title: 'Add a test',
                    url: `${SITE}/browse/ENG-43`,
                    status: { id: '10', name: 'Done', color: '#22a06b', category: 'done', order: 2000 }
                }
            ],
            links: [
                { relation: 'blocks', task: { id: '10050', key: 'ENG-50', title: 'Release', url: `${SITE}/browse/ENG-50` } },
                { relation: 'blocked_by', task: { id: '10051', key: 'ENG-51', title: 'Design', url: `${SITE}/browse/ENG-51` } },
                { relation: 'related', task: { id: '10052', key: 'ENG-52', title: 'Docs', url: `${SITE}/browse/ENG-52` } }
            ],
            attachments: [
                { name: 'screen.png', url: `${SITE}/rest/api/3/attachment/content/1`, size: 2048, thumbnailUrl: `${SITE}/thumb/1`, createdAt: '2026-11-02' }
            ]
        });
    });

    it('locks the description when an edit would lose an attachment', () => {
        const withMedia = {
            ...issue,
            fields: {
                ...issue.fields,
                description: { type: 'doc', version: 1, content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] }] }
            }
        };
        const task = jira.toTask(withMedia, { site: SITE, fieldIds, withDetails: true });
        expect(task.description).toBe('[Attachment]');
        expect(task.editable.description).toBe(false);
    });

    it('leaves the sprint and the story points empty without the custom fields', () => {
        expect(jira.toTask(issue, { site: SITE }).fields).toMatchObject({ sprint: null, storyPoints: null });
    });

    it('finds the custom fields of the sprint and the story points', () => {
        expect(
            jira.findFieldIds([
                { id: 'summary', name: 'Summary', schema: { type: 'string' } },
                { id: 'customfield_10020', name: 'Sprint', schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
                { id: 'customfield_10016', name: 'Story point estimate', schema: { type: 'number', custom: 'com.pyxis.greenhopper.jira:jsw-story-points' } }
            ])
        ).toEqual(fieldIds);
        expect(jira.findFieldIds([{ id: 'customfield_1', name: 'Story Points', schema: { type: 'number' } }])).toEqual({
            sprint: undefined,
            storyPoints: 'customfield_1'
        });
    });

    it('uses the last sprint when no sprint is active', () => {
        expect(
            jira.sprintName([
                { name: 'A', state: 'closed' },
                { name: 'B', state: 'future' }
            ])
        ).toBe('B');
        expect(jira.sprintName(null)).toBeNull();
    });
});

describe('Jira updates', () => {
    it('converts an update to the fields of the edit request', () => {
        expect(
            jira.issueFields({ title: ' New ', description: '**Hi**', assignees: ['a', 'b'], labels: ['x', 'x', 'y'], priority: '3', dueDate: null })
        ).toEqual({
            summary: 'New',
            description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks: [{ type: 'strong' }] }] }] },
            assignee: { accountId: 'b' },
            labels: ['x', 'y'],
            priority: { id: '3' },
            duedate: null
        });
        expect(jira.issueFields({ assignees: [], description: '' })).toEqual({ assignee: null, description: null });
    });

    it('refuses the parts that the plugin cannot change and values that Jira refuses', () => {
        expect(() => jira.issueFields({ startDate: '2026-01-01' })).toThrow('start date');
        expect(() => jira.issueFields({ title: ' ' })).toThrow('summary');
        expect(() => jira.issueFields({ labels: ['two words'] })).toThrow('cannot contain spaces');
        expect(() => jira.issueFields({ priority: null })).toThrow('must have a priority');
        expect(() => jira.issueFields({ dueDate: '20/11/2026' })).toThrow('YYYY-MM-DD');
    });

    it('selects the issue type for a new issue and for a subtask', () => {
        const types = [
            { id: '1', name: 'Epic', subtask: false, hierarchyLevel: 1 },
            { id: '2', name: 'Story', subtask: false, hierarchyLevel: 0 },
            { id: '3', name: 'Task', subtask: false, hierarchyLevel: 0 },
            { id: '4', name: 'Subtask', subtask: true, hierarchyLevel: -1 }
        ];
        expect(jira.pickIssueType(types).id).toBe('3');
        expect(jira.pickIssueType(types.filter(type => type.name !== 'Task')).id).toBe('2');
        expect(jira.pickIssueType(types, { subtask: true }).id).toBe('4');
        expect(() => jira.pickIssueType([types[2]], { subtask: true })).toThrow('no subtask');
    });

    it('maps the priorities to options with the level as the ID', () => {
        expect(jira.priorityOptions([{ id: '1', name: 'Highest', statusColor: '#d04437' }])).toEqual([{ id: '1', name: 'Highest', color: '#d04437' }]);
        expect(jira.toPriority({ id: '1', name: 'Highest' })).toEqual({ name: 'Highest', level: 1 });
    });
});

describe('Jira JQL', () => {
    it('makes the JQL of each filter', () => {
        expect(jira.issueJql('10000', 'assigned')).toBe('project = "10000" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
        expect(jira.issueJql('10000', 'sprint')).toBe('project = "10000" AND sprint in openSprints() ORDER BY updated DESC');
        expect(jira.issueJql('10000', 'open')).toBe('project = "10000" AND statusCategory != Done ORDER BY updated DESC');
        expect(jira.issueJql('10000', 'all')).toBe('project = "10000" ORDER BY updated DESC');
    });

    it('searches the summary and removes the special characters of the text search', () => {
        expect(jira.issueJql('10000', 'all', ' log-in "page" ')).toBe('project = "10000" AND summary ~ "log in page*" ORDER BY updated DESC');
        expect(jira.issueJql('10000', 'all', '???')).toBe('project = "10000" ORDER BY updated DESC');
    });

    it('escapes JQL strings and finds issue keys', () => {
        expect(jira.jqlString('a"b\\c')).toBe('"a\\"b\\\\c"');
        expect(jira.isIssueKey('eng-12')).toBe(true);
        expect(jira.isIssueKey('login')).toBe(false);
    });

    it('makes the JQL of the Dashboard with relative minutes', () => {
        const now = Date.parse('2026-11-19T12:00:00Z');
        expect(jira.activityJql(now - 90 * 60 * 1000 - 1, now, ['1', '2'])).toBe(
            'assignee = currentUser() AND updated >= -91m AND project in ("1", "2") ORDER BY updated DESC'
        );
    });
});

describe('Jira comments and projects', () => {
    const comment = (id, accountId, created, text) => ({
        id,
        author: { accountId, displayName: accountId },
        created,
        body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
    });

    it('converts a comment body to Markdown', () => {
        expect(jira.toComment(comment('1', 'ann', '2026-11-07T10:00:00.000+0000', 'Hello'))).toEqual({
            id: '1',
            author: { id: 'ann', name: 'ann', avatarUrl: undefined },
            body: 'Hello',
            createdAt: '2026-11-07T10:00:00.000Z'
        });
    });

    it('returns the new comments of other people after the last comment of the user', () => {
        const since = Date.parse('2026-11-07T00:00:00Z');
        const issues = [
            {
                id: '1',
                key: 'ENG-1',
                fields: {
                    summary: 'One',
                    comment: {
                        comments: [
                            comment('a', 'bob', '2026-11-07T01:00:00.000+0000', 'Old'),
                            comment('b', 'me', '2026-11-07T02:00:00.000+0000', 'Mine'),
                            comment('c', 'bob', '2026-11-07T03:00:00.000+0000', 'New'),
                            comment('d', 'bob', '2026-11-06T03:00:00.000+0000', 'Before since')
                        ]
                    }
                }
            }
        ];
        expect(jira.activityComments(issues, SITE, 'me', since)).toEqual([
            {
                id: 'c',
                taskId: '1',
                taskKey: 'ENG-1',
                taskTitle: 'One',
                taskUrl: `${SITE}/browse/ENG-1`,
                author: 'bob',
                body: 'New',
                createdAt: '2026-11-07T03:00:00.000Z'
            }
        ]);
    });

    it('maps the projects to collections and marks the busiest project', () => {
        const projects = [
            { id: '1', key: 'ENG', name: 'Engineering', projectCategory: { name: 'Product' } },
            { id: '2', key: 'OPS', name: 'Operations' }
        ];
        const busiest = jira.busiestProject([{ fields: { project: { id: '2' } } }, { fields: { project: { id: '2' } } }, { fields: { project: { id: '1' } } }]);
        expect(jira.toCollections(projects, SITE, busiest)).toEqual([
            { id: '1', name: 'Engineering', path: 'Product', url: `${SITE}/browse/ENG` },
            { id: '2', name: 'Operations', path: 'OPS', url: `${SITE}/browse/OPS`, default: true }
        ]);
    });

    it('reads the error messages of a Jira error response', () => {
        expect(jira.errorText({ errorMessages: ['Issue does not exist.'], errors: { summary: 'Field is required.' } })).toBe(
            'Issue does not exist. summary: Field is required.'
        );
        expect(jira.errorText(null)).toBe('');
    });

    it('waits for the Retry-After time', () => {
        expect(jira.retryDelay(new Headers({ 'retry-after': '7' }), 60000)).toBe(7000);
        expect(jira.retryDelay(new Headers(), 60000)).toBe(5000);
    });
});
