import { describe, expect, it } from 'vitest';
import { createMessageParser, encodeMessage, runPlugin } from './sdk/index.js';
import * as github from './github-issues/map.js';
import * as clickup from './clickup/map.js';
import * as azure from './azure-devops/map.js';

describe('SDK message framing', () => {
    it('parses messages that arrive in parts and together', () => {
        const parse = createMessageParser();
        const a = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'tasks/list' });
        const b = encodeMessage({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'é' } });
        const all = Buffer.from(a + b);
        expect(parse(all.subarray(0, 10))).toEqual([]);
        expect(parse(all.subarray(10, a.length + 5))).toEqual([{ jsonrpc: '2.0', id: 1, method: 'tasks/list' }]);
        expect(parse(all.subarray(a.length + 5))).toEqual([{ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'é' } }]);
    });

    it('counts bytes, not characters, in Content-Length', () => {
        expect(encodeMessage({ v: 'é' })).toBe('Content-Length: 10\r\n\r\n{"v":"é"}');
    });
});

describe('SDK handlers', () => {
    it('refuses a plugin without collections', () => {
        const handlers = { initialize: async () => ({}), listTasks: async () => ({ tasks: [] }), getTask: async () => ({}) };
        expect(() => runPlugin(handlers, { input: { on() {} }, output: { write() {} }, exit() {} })).toThrow('listCollections');
    });
});

describe('GitHub Issues mapping', () => {
    const issue = {
        number: 7,
        repository_url: 'https://api.github.com/repos/o/r',
        title: 'Fix login',
        html_url: 'https://github.com/o/r/issues/7',
        state: 'closed',
        state_reason: 'not_planned',
        assignees: [{ login: 'ann', avatar_url: 'a.png' }],
        labels: [{ name: 'bug', color: 'd73a4a' }],
        updated_at: '2026-11-07T00:00:00Z',
        body: 'Body',
        user: { login: 'bob' },
        comments: 2,
        milestone: null
    };

    it('maps an issue to a task', () => {
        expect(github.toTask(issue, { withDescription: true })).toEqual({
            id: 'o/r#7',
            key: '#7',
            title: 'Fix login',
            url: 'https://github.com/o/r/issues/7',
            status: github.STATUSES.notPlanned,
            assignees: [{ id: 'ann', name: 'ann', avatarUrl: 'a.png' }],
            labels: [{ name: 'bug', color: '#d73a4a' }],
            updatedAt: '2026-11-07T00:00:00Z',
            description: 'Body',
            fields: { author: 'bob', comments: 2, milestone: null }
        });
    });

    it('reads task IDs with the repository, and a bare number from protocol version 1', () => {
        expect(github.parseTaskId('o/r#7')).toEqual({ repo: 'o/r', number: '7' });
        expect(github.parseTaskId('7', 'o/r')).toEqual({ repo: 'o/r', number: '7' });
        expect(() => github.parseTaskId('7')).toThrow('not valid');
        expect(() => github.parseTaskId('o/r/x#7')).toThrow('not valid');
    });

    it('maps repositories with issues to collections and marks the workspace repository', () => {
        const repos = [
            { full_name: 'o/r', name: 'r', owner: { login: 'o' }, html_url: 'https://github.com/o/r', has_issues: true, archived: false },
            { full_name: 'o/old', name: 'old', owner: { login: 'o' }, has_issues: true, archived: true },
            { full_name: 'o/wiki', name: 'wiki', owner: { login: 'o' }, has_issues: false, archived: false }
        ];
        expect(github.toCollections(repos, 'O/R')).toEqual([{ id: 'o/r', name: 'r', path: 'o', url: 'https://github.com/o/r', default: true }]);
    });

    it('removes pull requests and maps status changes', () => {
        expect(github.onlyIssues([{ number: 1 }, { number: 2, pull_request: {} }])).toEqual([{ number: 1 }]);
        expect(github.stateChange('closed')).toEqual({ state: 'closed', state_reason: 'completed' });
        expect(() => github.stateChange('done')).toThrow('does not exist');
    });
});

describe('GitHub Issues repository pages', () => {
    const pages = sizes => {
        const calls = [];
        const fetchPage = async page => {
            calls.push(page);
            return Array.from({ length: sizes[page - 1] ?? 0 }, (_, index) => `${page}-${index}`);
        };
        return { calls, fetchPage };
    };

    it('loads one page when the first page is not full', async () => {
        const { calls, fetchPage } = pages([40]);
        expect(await github.loadPages(fetchPage, 3)).toHaveLength(40);
        expect(calls).toEqual([1]);
    });

    it('loads the other pages at the same time after a full first page', async () => {
        const { calls, fetchPage } = pages([100, 100, 7]);
        expect(await github.loadPages(fetchPage, 3)).toHaveLength(207);
        expect(calls).toEqual([1, 2, 3]);
    });

    it('stops at the first page that is not full', async () => {
        const { fetchPage } = pages([100, 30, 100]);
        expect(await github.loadPages(fetchPage, 3)).toHaveLength(130);
    });
});

describe('ClickUp mapping', () => {
    const task = {
        id: 'abc123',
        custom_id: 'ABC-1684',
        name: 'Fix the login page',
        url: 'https://app.clickup.com/t/abc123',
        status: { status: 'in review', color: '#ff00ff', type: 'custom', orderindex: 3 },
        assignees: [{ username: 'Austin', profilePicture: null }],
        tags: [{ name: 'frontend', tag_bg: '#00ff00' }],
        priority: { id: '2', priority: 'high' },
        date_updated: '1762473600000',
        markdown_description: '# Steps',
        list: { id: 901, name: 'Sprint 12' },
        folder: { name: 'Engineering', hidden: false },
        due_date: null
    };

    it('maps a task with its custom ID as the key', () => {
        const result = clickup.toTask(task, { withDescription: true });
        expect(result.key).toBe('ABC-1684');
        expect(result.status).toEqual({ id: 'in review', name: 'in review', color: '#ff00ff', category: 'in_progress', order: 3 });
        expect(result.priority).toEqual({ name: 'high', level: 2 });
        expect(result.updatedAt).toBe('2025-11-07T00:00:00.000Z');
        expect(result.description).toBe('# Steps');
        expect(result.fields).toBeUndefined();
        expect(result.assignees).toEqual([{ id: undefined, name: 'Austin', avatarUrl: undefined }]);
    });

    it('maps the status types to categories', () => {
        expect(['open', 'custom', 'done', 'closed'].map(clickup.statusCategory)).toEqual(['todo', 'in_progress', 'done', 'done']);
    });

    it('returns the statuses of a list in workflow order, without the per-task order field', () => {
        const status = (name, orderindex, type = 'custom') => ({ status: name, orderindex, type, color: '#000' });
        const statuses = clickup.listStatusOrder([status('done', 2, 'closed'), status('to do', 0, 'open'), status('blocked', 1)]);
        expect(statuses.map(item => item.name)).toEqual(['to do', 'blocked', 'done']);
        expect(statuses[0]).toEqual({ id: 'to do', name: 'to do', color: '#000', category: 'todo' });
    });

    it('maps the hierarchy to collections with the space and folder as the path', () => {
        const spaces = [
            {
                space: { id: 's1', name: 'Engineering' },
                lists: [{ id: 1, name: 'Inbox' }],
                folders: [
                    { id: 'f1', name: 'Sprints', lists: [{ id: 2, name: 'Sprint 12' }] },
                    { id: 'f2', name: 'hidden', hidden: true, lists: [{ id: 3, name: 'Loose' }] }
                ]
            }
        ];
        expect(clickup.toCollections('9', spaces, '2')).toEqual([
            { id: '1', name: 'Inbox', path: 'Engineering', url: 'https://app.clickup.com/9/v/li/1' },
            { id: '2', name: 'Sprint 12', path: 'Engineering / Sprints', url: 'https://app.clickup.com/9/v/li/2', default: true },
            { id: '3', name: 'Loose', path: 'Engineering', url: 'https://app.clickup.com/9/v/li/3' }
        ]);
    });

    it('starts the path with the workspace name when there are several workspaces', () => {
        const spaces = [{ space: { id: 's', name: 'Engineering' }, lists: [{ id: 1, name: 'Inbox' }], folders: [] }];
        expect(clickup.toCollections('9', spaces, undefined, 'Acme')[0].path).toBe('Acme / Engineering');
    });

    it('finds the list with the most tasks', () => {
        expect(clickup.busiestList([{ list: { id: 1 } }, { list: { id: 2 } }, { list: { id: 2 } }])).toBe('2');
        expect(clickup.busiestList([])).toBeUndefined();
    });

    it('filters by the name and the custom ID', () => {
        expect(clickup.matchesQuery(task, 'abc-16')).toBe(true);
        expect(clickup.matchesQuery(task, 'login')).toBe(true);
        expect(clickup.matchesQuery(task, 'billing')).toBe(false);
    });
});

describe('ClickUp rate limit', () => {
    const headers = values => new Headers(values);

    it('waits until the reset time of the rate limit', () => {
        const now = 1_700_000_000_000;
        expect(clickup.rateLimitWait(headers({ 'X-RateLimit-Reset': String(now / 1000 + 12) }), now)).toBe(12_500);
        // A reset time in the past gives the shortest wait.
        expect(clickup.rateLimitWait(headers({ 'X-RateLimit-Reset': String(now / 1000 - 5) }), now)).toBe(1000);
    });

    it('prefers Retry-After and has a default wait', () => {
        expect(clickup.rateLimitWait(headers({ 'Retry-After': '3', 'X-RateLimit-Reset': '1' }))).toBe(3000);
        expect(clickup.rateLimitWait(headers({}))).toBe(10_000);
    });
});

describe('Azure DevOps mapping', () => {
    const states = [
        { name: 'New', color: 'b2b2b2', category: 'Proposed' },
        { name: 'Active', color: '007acc', category: 'InProgress' },
        { name: 'Resolved', color: 'ff9d00', category: 'Resolved' },
        { name: 'Closed', color: '339933', category: 'Completed' },
        { name: 'Removed', color: 'ffffff', category: 'Removed' }
    ];
    const item = {
        id: 299,
        rev: 4,
        fields: {
            'System.Id': 299,
            'System.Title': 'Fix the login page',
            'System.State': 'Active',
            'System.WorkItemType': 'Bug',
            'System.TeamProject': 'Fabrikam Fiber',
            'System.AreaPath': 'Fabrikam Fiber\\Web',
            'System.IterationPath': 'Fabrikam Fiber\\Sprint 12',
            'System.AssignedTo': { displayName: 'Jamal Hartnett', uniqueName: 'jamal@example.com', id: 'u1', imageUrl: 'https://example.com/a.png' },
            'System.Tags': 'frontend; urgent',
            'System.ChangedDate': '2026-11-07T10:00:00.12Z',
            'Microsoft.VSTS.Common.Priority': 2,
            'System.Description': '<div><b>Steps</b></div><ol><li>Open the page</li><li>Sign in</li></ol>',
            'Microsoft.VSTS.TCM.ReproSteps': '<p>It fails &amp; shows an error.</p>'
        }
    };

    it('reads the organization setting as a name or a URL', () => {
        expect(azure.parseOrganization('contoso')).toEqual({ baseUrl: 'https://dev.azure.com/contoso', name: 'contoso' });
        expect(azure.parseOrganization('https://dev.azure.com/contoso/Web/')).toEqual({ baseUrl: 'https://dev.azure.com/contoso', name: 'contoso' });
        expect(azure.parseOrganization('dev.azure.com/contoso')).toEqual({ baseUrl: 'https://dev.azure.com/contoso', name: 'contoso' });
        expect(azure.parseOrganization('https://contoso.visualstudio.com')).toEqual({ baseUrl: 'https://contoso.visualstudio.com', name: 'contoso' });
        expect(azure.parseOrganization('https://tfs.example.com/tfs/DefaultCollection')).toEqual({
            baseUrl: 'https://tfs.example.com/tfs/DefaultCollection',
            name: 'DefaultCollection'
        });
        expect(() => azure.parseOrganization(' ')).toThrow('needs an organization');
        expect(() => azure.parseOrganization('https://dev.azure.com/')).toThrow('no organization name');
    });

    it('finds the project of an Azure Repos remote', () => {
        expect(azure.projectOfRemote('https://contoso@dev.azure.com/contoso/Fabrikam%20Fiber/_git/web')).toBe('Fabrikam Fiber');
        expect(azure.projectOfRemote('git@ssh.dev.azure.com:v3/contoso/Fabrikam/web')).toBe('Fabrikam');
        expect(azure.projectOfRemote('https://contoso.visualstudio.com/Fabrikam/_git/web')).toBe('Fabrikam');
        expect(azure.projectOfRemote('git@github.com:o/r.git')).toBeUndefined();
    });

    it('maps a work item to a task', () => {
        const task = azure.toTask(item, { baseUrl: 'https://dev.azure.com/contoso', states, withDescription: true });
        expect(task).toEqual({
            id: '299',
            key: 'AB#299',
            title: 'Fix the login page',
            url: 'https://dev.azure.com/contoso/Fabrikam%20Fiber/_workitems/edit/299',
            status: { id: 'Active', name: 'Active', color: '#007acc', category: 'in_progress' },
            assignees: [{ id: 'jamal@example.com', name: 'Jamal Hartnett' }],
            labels: [{ name: 'frontend' }, { name: 'urgent' }],
            priority: { name: 'High', level: 2 },
            updatedAt: '2026-11-07T10:00:00.12Z',
            description: '**Steps**\n\n1. Open the page\n2. Sign in\n\n## Repro steps\n\nIt fails & shows an error.',
            fields: { type: 'Bug', area: 'Fabrikam Fiber\\Web', iteration: 'Fabrikam Fiber\\Sprint 12' }
        });
    });

    it('guesses the status category without the type states', () => {
        const task = azure.toTask({ id: 1, fields: { 'System.State': 'Closed', 'System.Title': 'T' } });
        expect(task.status).toEqual({ id: 'Closed', name: 'Closed', color: undefined, category: 'done' });
        expect(task.description).toBeUndefined();
        expect(task.url).toBeUndefined();
        expect(task.assignees).toEqual([]);
    });

    it('keeps a Markdown description as it is', () => {
        const markdown = { id: 1, fields: { 'System.Description': '# Title\n\n- a' }, multilineFieldsFormat: { 'System.Description': 'Markdown' } };
        expect(azure.description(markdown)).toBe('# Title\n\n- a');
    });

    it('maps the state categories', () => {
        expect(['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed', 'Other'].map(azure.statusCategory)).toEqual([
            'todo',
            'in_progress',
            'in_progress',
            'done',
            'canceled',
            'in_progress'
        ]);
    });

    it('merges the states of the work item types in workflow order', () => {
        const task = [
            { name: 'To Do', category: 'Proposed' },
            { name: 'Doing', category: 'InProgress' },
            { name: 'Done', category: 'Completed' }
        ];
        const bug = [
            { name: 'New', category: 'Proposed' },
            { name: 'Done', category: 'Completed' },
            { name: 'Removed', category: 'Removed' },
            { name: 'Committed', category: 'InProgress' }
        ];
        expect(azure.mergeStates([task, bug]).map(status => status.name)).toEqual(['To Do', 'New', 'Doing', 'Committed', 'Done', 'Removed']);
        expect(azure.closedStateNames([task, bug])).toEqual(['Done', 'Removed']);
    });

    it('leaves out the hidden and disabled work item types', () => {
        const types = [{ name: 'Bug' }, { name: 'Code Review Request' }, { name: 'Old', isDisabled: true }];
        const categories = [{ referenceName: 'Microsoft.HiddenCategory', workItemTypes: [{ name: 'Code Review Request' }] }];
        expect(azure.visibleTypes(types, categories)).toEqual(['Bug']);
    });

    it('makes WIQL queries with escaped text', () => {
        expect(azure.listQuery({ filter: 'assigned', query: "it's", closedStates: ['Closed'], areaPath: 'Web\\UI', types: ['Bug'] })).toBe(
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('Bug') AND [System.AssignedTo] = @Me" +
                " AND [System.State] NOT IN ('Closed') AND [System.AreaPath] UNDER 'Web\\UI' AND [System.Title] CONTAINS 'it''s' ORDER BY [System.ChangedDate] DESC"
        );
        expect(azure.listQuery({ filter: 'all', query: 'AB#42', closedStates: ['Closed'] })).toBe(
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ([System.Id] = 42 OR [System.Title] CONTAINS '42') ORDER BY [System.ChangedDate] DESC"
        );
        expect(azure.activityQuery('2026-11-07T00:00:00Z', ['A'])).toBe(
            "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.ChangedDate] > '2026-11-07T00:00:00.000Z' AND [System.TeamProject] IN ('A') ORDER BY [System.ChangedDate] DESC"
        );
    });

    it('maps HTML and Markdown comments', () => {
        expect(
            azure.toComment({
                id: 50,
                text: '<div>See <a href="https://example.com">the log</a>.<br>Thanks</div>',
                createdBy: { displayName: 'Jamal' },
                createdDate: '2026-11-07T00:00:00Z'
            })
        ).toEqual({ id: '50', author: { name: 'Jamal' }, body: 'See [the log](https://example.com).\nThanks', createdAt: '2026-11-07T00:00:00Z' });
        expect(azure.toComment({ id: 51, format: 'markdown', text: '**ok**' }).body).toBe('**ok**');
    });

    it('selects the new comments from other people after the last comment of the user', () => {
        const comment = (id, user, date) => ({ id, createdBy: { id: user }, createdDate: date });
        const comments = [
            comment(1, 'other', '2026-11-07T01:00:00Z'),
            comment(2, 'me', '2026-11-07T02:00:00Z'),
            comment(3, 'other', '2026-11-07T03:00:00Z'),
            { ...comment(4, 'other', '2026-11-07T04:00:00Z'), isDeleted: true }
        ];
        expect(azure.newComments(comments, 'me', '2026-11-07T00:00:00Z').map(entry => entry.id)).toEqual([3]);
        expect(azure.sortComments([comment(2, 'a', '2026-11-08T00:00:00Z'), comment(1, 'a', '2026-11-07T00:00:00Z')]).map(entry => entry.id)).toEqual([1, 2]);
    });

    it('converts rich text HTML to Markdown', () => {
        expect(azure.htmlToMarkdown('<h2>Plan</h2><ul><li>One<ul><li>Two</li></ul></li><li>Three</li></ul><pre><code>a &lt; b\n  c</code></pre>')).toBe(
            '## Plan\n\n- One\n   - Two\n- Three\n\n```\na < b\n  c\n```'
        );
        expect(azure.htmlToMarkdown('<p><i>Note</i> <img src="https://x/y.png" alt="shot"> <a href="#" data-vss-mention="version:2.0,1">@Ann</a></p>')).toBe(
            '*Note* ![shot](https://x/y.png) @Ann'
        );
        expect(azure.htmlToMarkdown('Plain text')).toBe('Plain text');
    });
});

describe('ClickUp task details', () => {
    const field = (type, value, extra = {}) => ({ id: 'f1', name: 'Field', type, value, ...extra });

    it.each([
        [field('number', '0'), { type: 'number', editable: true, value: 0 }],
        [field('number', undefined), { type: 'number', editable: true }],
        [field('emoji', '3', { type_config: { count: 5 } }), { type: 'rating', editable: true, max: 5, value: 3 }],
        [field('emoji', undefined, { type_config: { count: 4 } }), { type: 'rating', editable: true, max: 4 }],
        [field('checkbox', 'true'), { type: 'boolean', editable: true, value: true }],
        [field('checkbox', undefined), { type: 'boolean', editable: true, value: false }],
        [field('url', 'https://example.com'), { type: 'url', editable: true, value: 'https://example.com' }],
        [field('short_text', ''), { type: 'text', editable: true }],
        [field('formula', '3'), { type: 'text', value: '3' }],
        [
            field('drop_down', 1, {
                type_config: {
                    options: [
                        { id: 'a', name: 'Low', orderindex: 0 },
                        { id: 'b', name: 'High', color: '#f00', orderindex: 1 }
                    ]
                }
            }),
            {
                type: 'labels',
                editable: true,
                options: [
                    { id: 'a', name: 'Low', color: undefined },
                    { id: 'b', name: 'High', color: '#f00' }
                ],
                labels: [{ id: 'b', name: 'High', color: '#f00' }]
            }
        ],
        [
            field('labels', ['b'], {
                type_config: {
                    options: [
                        { id: 'a', label: 'One' },
                        { id: 'b', label: 'Two' }
                    ]
                }
            }),
            {
                type: 'labels',
                editable: true,
                multiple: true,
                options: [
                    { id: 'a', name: 'One', color: undefined },
                    { id: 'b', name: 'Two', color: undefined }
                ],
                labels: [{ id: 'b', name: 'Two', color: undefined }]
            }
        ],
        [field('users', [{ id: 7, username: 'Sam' }]), { type: 'people', editable: true, people: [{ id: '7', name: 'Sam', avatarUrl: undefined }] }],
        [field('users', []), { type: 'people', editable: true }],
        [field('manual_progress', { percent_completed: 40 }), { type: 'progress', editable: true, value: 40 }],
        [field('automatic_progress', { percent_completed: 40 }), { type: 'progress', value: 40 }]
    ])('maps a custom field %#', (input, expected) => {
        expect(clickup.toCustomField(input)).toEqual({ id: 'f1', label: 'Field', ...expected });
    });

    it('gives a day without a time, and an ISO time with a time', () => {
        const ms = new Date(2026, 10, 3, 4, 0).getTime();
        expect(clickup.dayOrTime(String(ms), false)).toBe('2026-11-03');
        expect(clickup.dayOrTime(String(ms), true)).toBe(new Date(ms).toISOString());
        expect(clickup.dayOrTime(null, true)).toBeUndefined();
    });

    it('maps the dependencies and the linked tasks from the view of the task', () => {
        const links = clickup.toLinks({
            id: 't1',
            dependencies: [
                { task_id: 't1', depends_on: 't2' },
                { task_id: 't3', depends_on: 't1' }
            ],
            linked_tasks: [{ task_id: 't1', link_id: 't4' }]
        });
        expect(links.map(link => [link.relation, link.task.id])).toEqual([
            ['blocked_by', 't2'],
            ['blocks', 't3'],
            ['related', 't4']
        ]);
    });

    it('maps the details of a task', () => {
        const details = clickup.toDetails(
            {
                id: 't1',
                creator: { id: 1, username: 'Austin', profilePicture: 'https://example.com/a.png' },
                date_created: '1762473600000',
                time_estimate: 3600000,
                parent: 'p1',
                subtasks: [{ id: 's1', name: 'Write tests', status: { status: 'to do', type: 'open' }, assignees: [] }],
                checklists: [
                    {
                        name: 'Steps',
                        id: 'c1',
                        items: [
                            { id: 'i2', name: 'Two', resolved: true, orderindex: 1 },
                            { id: 'i1', name: 'One', resolved: false, orderindex: 0 }
                        ]
                    }
                ],
                attachments: [{ title: 'shot.png', url: 'https://example.com/shot.png', size: '120', thumbnail_small: 'https://example.com/t.png' }],
                custom_fields: [],
                watchers: []
            },
            'Engineering / Projects'
        );
        expect(details.location).toBe('Engineering / Projects');
        expect(details.creator).toEqual({ id: '1', name: 'Austin', avatarUrl: 'https://example.com/a.png' });
        expect(details.createdAt).toBe('2025-11-07T00:00:00.000Z');
        expect(details.timeEstimate).toBe(3600000);
        expect(details.parent).toEqual({ id: 'p1', url: 'https://app.clickup.com/t/p1' });
        expect(details.subtasks[0]).toMatchObject({ id: 's1', title: 'Write tests', url: 'https://app.clickup.com/t/s1' });
        expect(details.checklists[0].items.map(item => [item.id, item.name, item.done])).toEqual([
            ['c1/i1', 'One', false],
            ['c1/i2', 'Two', true]
        ]);
        expect(details.attachments).toEqual([
            { name: 'shot.png', url: 'https://example.com/shot.png', size: 120, thumbnailUrl: 'https://example.com/t.png', createdAt: undefined }
        ]);
        expect(details.customFields).toBeUndefined();
        expect(details.watchers).toBeUndefined();
    });
});

describe('ClickUp edits', () => {
    it('finds the IDs to add and to remove', () => {
        expect(clickup.listChange([1, 2, 3], ['2', '4'])).toEqual({ add: ['4'], rem: ['1', '3'] });
    });

    it('splits a checklist item ID', () => {
        expect(clickup.parseChecklistItemId('c1/i1')).toEqual({ checklistId: 'c1', itemId: 'i1' });
        expect(() => clickup.parseChecklistItemId('i1')).toThrow('not valid');
    });

    it('converts a day to noon in the local time zone', () => {
        expect(clickup.dayToMilliseconds('2026-11-03')).toBe(new Date(2026, 10, 3, 12).getTime());
        expect(clickup.dayToMilliseconds(null)).toBeNull();
        expect(() => clickup.dayToMilliseconds('11/03/2026')).toThrow('not valid');
    });

    it('makes the request for a custom field value', () => {
        const users = { type: 'users', value: [{ id: 1 }, { id: 2 }] };
        expect(clickup.customFieldRequest(users, ['2', '3'])).toEqual({ body: { value: { add: ['3'], rem: ['1'] } } });
        expect(clickup.customFieldRequest({ type: 'checkbox' }, false)).toEqual({ body: { value: false } });
        expect(clickup.customFieldRequest({ type: 'number' }, '4.5')).toEqual({ body: { value: 4.5 } });
        expect(() => clickup.customFieldRequest({ type: 'number' }, 'x')).toThrow('not a number');
        expect(clickup.customFieldRequest({ type: 'drop_down' }, ['b'])).toEqual({ body: { value: 'b' } });
        expect(clickup.customFieldRequest({ type: 'labels' }, ['a', 'b'])).toEqual({ body: { value: ['a', 'b'] } });
        expect(clickup.customFieldRequest({ type: 'manual_progress' }, 30)).toEqual({ body: { value: { current: 30 } } });
        expect(clickup.customFieldRequest({ type: 'date' }, '2026-11-03')).toEqual({
            body: { value: new Date(2026, 10, 3, 12).getTime(), value_options: { time: false } }
        });
        expect(clickup.customFieldRequest({ type: 'text' }, 'Hi')).toEqual({ body: { value: 'Hi' } });
        expect(clickup.customFieldRequest({ type: 'drop_down' }, [])).toEqual({ clear: true });
        expect(clickup.customFieldRequest({ type: 'short_text' }, null)).toEqual({ clear: true });
    });
});

describe('ClickUp comment mentions', () => {
    const mentions = [
        { id: '7', name: 'Ann' },
        { id: '8', name: 'Ann Lee' }
    ];
    const references = [{ id: 'abc', text: 'ENG-1' }];

    it('makes tags for the mentions and URLs for the task references', () => {
        const parts = clickup.commentParts('Hi @Ann Lee and @Ann, see ENG-1.', mentions, references);
        expect(parts).toEqual([
            { text: 'Hi ' },
            { type: 'tag', user: { id: 8 } },
            { text: ' and ' },
            { type: 'tag', user: { id: 7 } },
            { text: ', see https://app.clickup.com/t/abc.' }
        ]);
        expect(clickup.plainComment(parts, mentions)).toBe('Hi @Ann Lee and @Ann, see https://app.clickup.com/t/abc.');
    });

    it('keeps a body without mentions as one text part', () => {
        expect(clickup.commentParts('Plain text', [], [])).toEqual([{ text: 'Plain text' }]);
    });
});
