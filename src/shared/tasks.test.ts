import { describe, expect, it } from 'vitest';
import {
    applyStartStatus,
    assigneeOptions,
    ME,
    boardColumns,
    branchNameForTask,
    collapsedByDefault,
    findStartStatus,
    groupTasksByStatus,
    labelOptions,
    linkMatchesTask,
    normalizeTaskConfig,
    pickCollection,
    sortCollections,
    statusForColumn,
    taskHasAssignee,
    taskHasLabel,
    taskMatches,
    taskPrompt,
    type StatusCategory,
    type Task,
    type TaskStatus
} from './tasks';

const task = (key: string | undefined, title: string, category: Task['status']['category'] = 'todo'): Task => ({
    id: 'abc',
    key,
    title,
    status: { id: category, name: category, category }
});

describe('branchNameForTask', () => {
    it.each([
        [task('ABC-1684', 'Fix the login page'), 'abc-1684-fix-the-login-page'],
        [task('#42', 'Add dark mode!'), 'issue-42-add-dark-mode'],
        [task(undefined, 'Café: résumé upload'), 'cafe-resume-upload'],
        [task(undefined, '!!!'), 'abc']
    ])('makes a branch name', (input, expected) => {
        expect(branchNameForTask(input)).toBe(expected);
    });

    it('limits the length and removes a trailing hyphen', () => {
        const name = branchNameForTask(task('ENG-1', 'a very long title with many words that goes on and on and on'), 30);
        expect(name.length).toBeLessThanOrEqual(30);
        expect(name.endsWith('-')).toBe(false);
    });
});

describe('collections', () => {
    it('picks the saved collection, else the default, else the first one', () => {
        const collections = [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B', default: true },
            { id: 'c', name: 'C' }
        ];
        expect(pickCollection(collections, 'c')).toBe('c');
        expect(pickCollection(collections, 'gone')).toBe('b');
        expect(pickCollection([{ id: 'a', name: 'A' }], undefined)).toBe('a');
        expect(pickCollection([], undefined)).toBeUndefined();
    });

    it('selects only the default collection when the source asks for it', () => {
        const collections = [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' }
        ];
        expect(pickCollection(collections, undefined, true)).toBeUndefined();
        expect(pickCollection(collections, 'b', true)).toBe('b');
        expect(pickCollection([...collections, { id: 'c', name: 'C', default: true }], undefined, true)).toBe('c');
    });

    it('sorts collections without a path first, then by path and name', () => {
        const sorted = sortCollections([
            { id: '1', name: 'Trello Archive', path: 'Archive' },
            { id: '2', name: 'General List' },
            { id: '3', name: 'ClassLink', path: 'Projects' },
            { id: '4', name: 'Completed Work' }
        ]);
        expect(sorted.map(item => item.name)).toEqual(['Completed Work', 'General List', 'Trello Archive', 'ClassLink']);
    });
});

describe('taskPrompt', () => {
    it('includes the key, the title, the URL, the description and the branch', () => {
        const prompt = taskPrompt({ ...task('#2', 'Fix it'), url: 'https://x/2', description: 'Do the thing.' }, 'issue-2-fix-it');
        expect(prompt).toBe(
            'Work on this task.\n\n#2: Fix it\nhttps://x/2\n\nDo the thing.\n\nYou are in a new git worktree on the branch "issue-2-fix-it". Make the change, run the tests and commit your work.'
        );
    });
});

describe('groupTasksByStatus', () => {
    const withStatus = (id: string, name: string, category: Task['status']['category'], order?: number): Task => ({
        id,
        title: id,
        status: { id: name, name, category, order }
    });

    it('makes one group for each status name, in category order and then in status order', () => {
        const groups = groupTasksByStatus([
            withStatus('1', 'complete', 'done', 9),
            withStatus('2', 'in review', 'in_progress', 3),
            withStatus('3', 'in development', 'in_progress', 2),
            withStatus('4', 'to do', 'todo', 0),
            withStatus('5', 'In Review', 'in_progress', 3)
        ]);
        expect(groups.map(group => [group.name, group.tasks.length])).toEqual([
            ['in development', 1],
            ['in review', 2],
            ['to do', 1],
            ['complete', 1]
        ]);
    });

    it('follows the order of the plugin adapter, and puts unknown statuses after it', () => {
        const order = [
            { id: 'backlog', name: 'Backlog', category: 'todo' as const },
            { id: 'dev ready', name: 'Dev Ready', category: 'in_progress' as const },
            { id: 'in review', name: 'In Review', category: 'in_progress' as const },
            { id: 'done', name: 'Done', category: 'done' as const }
        ];
        const groups = groupTasksByStatus(
            [
                withStatus('1', 'in review', 'in_progress', 9),
                withStatus('2', 'Backlog', 'todo', 0),
                withStatus('3', 'blocked', 'in_progress', 1),
                withStatus('4', 'Done', 'done'),
                withStatus('5', 'dev ready', 'in_progress', 2)
            ],
            order
        );
        expect(groups.map(group => group.name)).toEqual(['Backlog', 'dev ready', 'in review', 'Done', 'blocked']);
    });

    it('sorts statuses without an order by name', () => {
        const groups = groupTasksByStatus([withStatus('1', 'zeta', 'todo'), withStatus('2', 'alpha', 'todo')]);
        expect(groups.map(group => group.name)).toEqual(['alpha', 'zeta']);
    });

    it('collapses only the done and canceled groups by default', () => {
        expect(['backlog', 'todo', 'in_progress', 'done', 'canceled'].map(category => collapsedByDefault(category as Task['status']['category']))).toEqual([
            false,
            false,
            false,
            true,
            true
        ]);
    });
});

describe('boardColumns', () => {
    const status = (name: string, category: StatusCategory = 'in_progress'): TaskStatus => ({ id: name, name, category });
    const task = (id: string, name: string, category: StatusCategory = 'in_progress'): Task => ({ id, title: id, status: status(name, category) });

    it('adds empty columns from the workflow order, in workflow position', () => {
        const order = [status('to do', 'todo'), status('in progress'), status('in review'), status('complete', 'done')];
        const columns = boardColumns([task('a', 'In Progress'), task('b', 'complete', 'done')], order);
        expect(columns.map(column => [column.key, column.tasks.length])).toEqual([
            ['to do', 0],
            ['in progress', 1],
            ['in review', 0],
            ['complete', 1]
        ]);
    });

    it('keeps a status that is not in the order, and works without an order', () => {
        expect(boardColumns([task('a', 'odd')], [status('to do', 'todo')]).map(column => column.key)).toEqual(['to do', 'odd']);
        expect(boardColumns([task('a', 'open', 'todo')]).map(column => column.key)).toEqual(['open']);
    });

    it('finds the status of a task workflow by column', () => {
        expect(statusForColumn('in review', [status('To Do', 'todo'), status('In Review')])?.id).toBe('In Review');
        expect(statusForColumn('blocked', [status('To Do', 'todo')])).toBeUndefined();
    });
});

describe('task manager configuration', () => {
    it('removes bad entries, keeps the scopes and ignores the project overrides of older files', () => {
        const config = normalizeTaskConfig({
            connections: [
                { id: 'cu-work', pluginId: 'clickup', name: 'ClickUp (work)', scope: ['9013'] },
                { id: 'cu-home', pluginId: 'clickup', name: 'ClickUp (home)', enabled: false },
                { id: 'gh', pluginId: 'github-issues', name: 'GitHub', scope: ['acme', 'acme', 7] },
                { id: 'gh', pluginId: 'github-issues', name: 'Duplicate' },
                { pluginId: 'no-id' }
            ],
            overrides: { side: { connections: [{ id: 'cu-home' }] } }
        });
        expect(config).toEqual({
            connections: [
                { id: 'cu-work', pluginId: 'clickup', name: 'ClickUp (work)', scope: ['9013'], enabled: true },
                { id: 'cu-home', pluginId: 'clickup', name: 'ClickUp (home)', scope: undefined, enabled: false },
                { id: 'gh', pluginId: 'github-issues', name: 'GitHub', scope: ['acme'], enabled: true }
            ]
        });
    });
});

describe('start status', () => {
    const statuses = [
        { id: 's1', name: 'To do', category: 'todo' as const },
        { id: 's2', name: 'In Progress', category: 'in_progress' as const }
    ];
    const task = { id: 't1', title: 'Fix login', status: statuses[0] };

    function fakeRequest(list = statuses) {
        const calls: [string, unknown][] = [];
        const request = async <T>(method: string, params: unknown): Promise<T> => {
            calls.push([method, params]);
            return (method === 'tasks/statuses' ? list : task) as T;
        };
        return { calls, request };
    }

    it('finds the status by name without case', () => {
        expect(findStartStatus(statuses, ' in progress ')?.id).toBe('s2');
        expect(findStartStatus(statuses, 'Review')).toBeUndefined();
        expect(findStartStatus(statuses, '')).toBeUndefined();
    });

    it('moves the task when its list has the status', async () => {
        const { calls, request } = fakeRequest();
        expect(await applyStartStatus(task, 'in progress', { update: true, statuses: true }, request)).toBe('moved');
        expect(calls).toEqual([
            ['tasks/statuses', { id: 't1' }],
            ['tasks/update', { id: 't1', status: 's2' }]
        ]);
    });

    it('keeps the status when the list has no such status, or the task has it already', async () => {
        const missing = fakeRequest([statuses[0]]);
        expect(await applyStartStatus(task, 'In Progress', { update: true, statuses: true }, missing.request)).toBe('missing');
        expect(missing.calls).toHaveLength(1);
        const already = fakeRequest();
        expect(await applyStartStatus(task, 'to do', { update: true, statuses: true }, already.request)).toBe('already');
        expect(already.calls).toHaveLength(1);
    });

    it('does nothing without a start status or without the capabilities', async () => {
        const { calls, request } = fakeRequest();
        expect(await applyStartStatus(task, undefined, { update: true, statuses: true }, request)).toBe('none');
        expect(await applyStartStatus(task, 'In Progress', { update: true }, request)).toBe('unsupported');
        expect(calls).toEqual([]);
    });

    it('keeps a trimmed start status in the connection settings', () => {
        const config = normalizeTaskConfig({
            connections: [
                { id: 'c', pluginId: 'clickup', startStatus: ' in progress ' },
                { id: 'd', pluginId: 'github-issues', startStatus: '  ' }
            ]
        });
        expect(config.connections[0].startStatus).toBe('in progress');
        expect(config.connections[1]).not.toHaveProperty('startStatus');
    });
});

describe('linkMatchesTask', () => {
    const task = { id: 'acme/api#3', url: 'https://github.com/acme/api/issues/3' };

    it('matches by the task ID, or by the URL for links of older plugin versions', () => {
        expect(linkMatchesTask({ connectionId: 'gh', pluginId: 'github-issues', taskId: 'acme/api#3', title: 'x' }, 'gh', task)).toBe(true);
        expect(linkMatchesTask({ pluginId: 'gh', taskId: '3', title: 'x', url: task.url }, 'gh', task)).toBe(true);
        expect(linkMatchesTask({ pluginId: 'gh', taskId: '3', title: 'x' }, 'gh', task)).toBe(false);
        expect(linkMatchesTask({ connectionId: 'other', pluginId: 'github-issues', taskId: 'acme/api#3', title: 'x' }, 'gh', task)).toBe(false);
    });
});

describe('taskMatches', () => {
    const item: Task = { ...task('ENG-42', 'Fix the login page'), labels: [{ name: 'Bug' }], assignees: [{ name: 'Sam Lee' }] };

    it.each([
        ['', true],
        ['  ', true],
        ['eng-42', true],
        ['LOGIN', true],
        ['fix page', true],
        ['bug', true],
        ['sam', true],
        ['logout', false],
        ['login logout', false]
    ])('matches the search text %j', (query, expected) => {
        expect(taskMatches(item, query)).toBe(expected);
    });
});

describe('taskHasAssignee', () => {
    const open: Task = task('ENG-1', 'No owner');
    const empty: Task = { ...task('ENG-2', 'Empty list'), assignees: [] };
    const sam: Task = { ...task('ENG-3', 'Sam only'), assignees: [{ id: '7', name: 'Sam Lee' }] };
    const pair: Task = { ...task('ENG-4', 'Two people'), assignees: [{ id: '7', name: 'Sam Lee' }, { name: 'Ana Ruiz' }] };
    const all = [open, empty, sam, pair];

    it.each([
        [{ people: [], unassigned: false }, [true, true, true, true]],
        [{ people: [], unassigned: true }, [true, true, false, false]],
        [{ people: ['7'], unassigned: false }, [false, false, true, true]],
        [{ people: ['name:Ana Ruiz'], unassigned: false }, [false, false, false, true]],
        [{ people: ['name:Ana Ruiz'], unassigned: true }, [true, true, false, true]],
        [{ people: ['8'], unassigned: false }, [false, false, false, false]]
    ])('applies the filter %j', (filter, expected) => {
        expect(all.map(item => taskHasAssignee(item, filter))).toEqual(expected);
    });

    it('finds the user of the connection with the key of "me"', () => {
        const filter = { people: [ME], unassigned: false };
        expect(all.map(item => taskHasAssignee(item, filter, '7'))).toEqual([false, false, true, true]);
        expect(taskHasAssignee(sam, filter)).toBe(false);
    });
});

describe('taskHasLabel', () => {
    const none: Task = task('ENG-1', 'No labels');
    const empty: Task = { ...task('ENG-2', 'Empty list'), labels: [] };
    const bug: Task = { ...task('ENG-3', 'Bug only'), labels: [{ name: 'Bug' }] };
    const pair: Task = { ...task('ENG-4', 'Two labels'), labels: [{ id: 'x', name: ' bug ' }, { name: 'UI' }] };
    const all = [none, empty, bug, pair];

    it.each([
        [{ labels: [], unlabeled: false }, [true, true, true, true]],
        [{ labels: [], unlabeled: true }, [true, true, false, false]],
        [{ labels: ['bug'], unlabeled: false }, [false, false, true, true]],
        [{ labels: ['ui'], unlabeled: false }, [false, false, false, true]],
        [{ labels: ['ui'], unlabeled: true }, [true, true, false, true]],
        [{ labels: ['docs'], unlabeled: false }, [false, false, false, false]]
    ])('applies the filter %j', (filter, expected) => {
        expect(all.map(item => taskHasLabel(item, filter))).toEqual(expected);
    });
});

describe('labelOptions', () => {
    it('gives each label one time by name, in alphabetical order', () => {
        const tasks: Task[] = [
            { ...task('A', 'a'), labels: [{ name: 'ui' }, { name: 'Bug' }] },
            task('B', 'b'),
            { ...task('C', 'c'), labels: [{ name: 'bug', color: '#f00' }, { name: 'Docs' }] }
        ];
        expect(labelOptions(tasks)).toEqual([{ name: 'Bug', color: '#f00' }, { name: 'Docs' }, { name: 'ui' }]);
    });
});

describe('assigneeOptions', () => {
    it('gives each person one time, in alphabetical order', () => {
        const tasks: Task[] = [
            { ...task('A', 'a'), assignees: [{ name: 'sam Lee' }, { id: '1', name: 'Ana Ruiz', avatarUrl: 'pic' }] },
            task('B', 'b'),
            { ...task('C', 'c'), assignees: [{ id: '1', name: 'Ana Ruiz' }, { name: 'Bo Chen' }] }
        ];
        expect(
            assigneeOptions(tasks, [
                { id: '1', name: 'Ana Ruiz' },
                { id: '2', name: 'Zoe' }
            ])
        ).toEqual([{ id: '1', name: 'Ana Ruiz', avatarUrl: 'pic' }, { name: 'Bo Chen' }, { name: 'sam Lee' }, { id: '2', name: 'Zoe' }]);
    });
});
