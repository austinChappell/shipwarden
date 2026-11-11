import { describe, expect, it } from 'vitest';
import type { ConnectionInfo, StatusGroup, Task, TaskLink } from '@shared/tasks';
import {
    acceptsDrop,
    findFreshTask,
    collectionPlaceholder,
    taskListState,
    collectionTitle,
    connectionStateOf,
    formatField,
    groupStatus,
    isGroupCollapsed,
    missingSettingsText,
    noMatchText,
    neighborColumn,
    parseCollapseState,
    parseViewMode,
    patchTask,
    pickConnection,
    pickFilter,
    prependTask,
    removeTask,
    targetRepo,
    taskLabel,
    toggleCollapse,
    uniqueTasks,
    worktreeForTask,
    personInitials,
    formatDuration,
    formatDay,
    formatBytes,
    checklistProgress,
    customFieldEmpty,
    addLabelOptions,
    commentLinks,
    rankPeople,
    rankTasks,
    referenceText,
    dayInputValue,
    editableParts,
    parseDuration
} from './task-view-logic';

const task = (id: string, status = 'to do', extra: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: { id: status, name: status, category: 'todo' },
    ...extra
});

const connection = (id: string, configured: boolean): ConnectionInfo => ({
    id,
    pluginId: 'p',
    name: id,
    enabled: true,
    pluginName: 'P',
    settings: [],
    configured,
    settingsWithValue: [],
    publicSettings: {}
});

const column = (key: string, tasks: Task[]): StatusGroup => ({ key, name: key, category: 'todo', tasks }) as StatusGroup;

describe('parseViewMode', () => {
    it('gives the list only when the stored value is "list"', () => {
        expect(parseViewMode('list')).toBe('list');
        expect(parseViewMode('board')).toBe('board');
        expect(parseViewMode(null)).toBe('board');
        expect(parseViewMode('other')).toBe('board');
    });
});

describe('collapse state', () => {
    it('reads the stored JSON, and gives an empty record for bad JSON', () => {
        expect(parseCollapseState('{"done":true}')).toEqual({ done: true });
        expect(parseCollapseState(null)).toEqual({});
        expect(parseCollapseState('{bad')).toEqual({});
    });

    it('uses the default when the group has no stored value', () => {
        expect(isGroupCollapsed({}, 'done', true)).toBe(true);
        expect(isGroupCollapsed({ done: false }, 'done', true)).toBe(false);
    });

    it('toggles one group and keeps the other groups', () => {
        const state = { todo: true };
        expect(toggleCollapse(state, 'done', true)).toEqual({ todo: true, done: false });
        expect(toggleCollapse(state, 'todo', false)).toEqual({ todo: false });
        expect(state).toEqual({ todo: true });
    });
});

describe('formatField', () => {
    it('shows a dash for an empty value', () => {
        expect(formatField(null, 'text')).toBe('—');
        expect(formatField(undefined, 'text')).toBe('—');
        expect(formatField('', 'text')).toBe('—');
    });

    it('shows Yes or No for a boolean field', () => {
        expect(formatField(true, 'boolean')).toBe('Yes');
        expect(formatField(false, 'boolean')).toBe('No');
    });

    it('shows a date field as a local date', () => {
        expect(formatField('2026-01-02T12:00:00Z', 'date')).toBe(new Date('2026-01-02T12:00:00Z').toLocaleDateString());
    });

    it('shows other values as text', () => {
        expect(formatField(3, 'number')).toBe('3');
        expect(formatField(0, 'number')).toBe('0');
    });
});

describe('pickConnection', () => {
    const list = [connection('a', false), connection('b', true), connection('c', true)];

    it('picks the saved connection when the list has it', () => {
        expect(pickConnection(list, 'a')).toBe('a');
    });

    it('else picks the first configured connection, else the first connection', () => {
        expect(pickConnection(list, 'gone')).toBe('b');
        expect(pickConnection([connection('x', false)], undefined)).toBe('x');
        expect(pickConnection([], undefined)).toBeUndefined();
    });
});

describe('connectionStateOf', () => {
    it('tells the state of the selected connection', () => {
        expect(connectionStateOf(undefined, 'a')).toBe('loading');
        expect(connectionStateOf([connection('a', true)], 'b')).toBe('none');
        expect(connectionStateOf([connection('a', true)], 'a')).toBe('ready');
        expect(connectionStateOf([connection('a', false)], 'a')).toBe('unconfigured');
    });
});

describe('pickFilter', () => {
    const filters = [
        { id: 'mine', label: 'Mine' },
        { id: 'all', label: 'All', default: true }
    ];

    it('keeps the last filter when the source has it', () => {
        expect(pickFilter(filters, 'mine')).toBe('mine');
    });

    it('else picks the default filter, else the first filter', () => {
        expect(pickFilter(filters, 'gone')).toBe('all');
        expect(pickFilter(filters, undefined)).toBe('all');
        expect(pickFilter([{ id: 'one', label: 'One' }], undefined)).toBe('one');
        expect(pickFilter([], undefined)).toBeUndefined();
    });
});

describe('task list changes', () => {
    it('keeps the first copy of a task that is on two pages', () => {
        const first = task('1', 'to do');
        const result = uniqueTasks([first, task('2'), task('1', 'done')]);
        expect(result.map(item => item.id)).toEqual(['1', '2']);
        expect(result[0]).toBe(first);
    });

    it('changes only the task with the ID', () => {
        const other = task('2');
        const result = patchTask([task('1'), other], '1', { title: 'New' });
        expect(result?.[0].title).toBe('New');
        expect(result?.[1]).toBe(other);
        expect(patchTask(undefined, '1', { title: 'New' })).toBeUndefined();
    });

    it('puts a new task first and removes its old copy', () => {
        const created = task('2', 'new');
        expect(prependTask([task('1'), task('2')], created)).toEqual([created, task('1')]);
        expect(prependTask(undefined, created)).toEqual([created]);
    });

    it('removes a task', () => {
        expect(removeTask([task('1'), task('2')], '1')?.map(item => item.id)).toEqual(['2']);
        expect(removeTask(undefined, '1')).toBeUndefined();
    });
});

describe('worktreeForTask', () => {
    const links: Record<string, TaskLink> = {
        '/wt/one': { connectionId: 'a', pluginId: 'clickup', taskId: '1', title: 'One' },
        '/wt/two': { connectionId: 'b', pluginId: 'clickup', taskId: '2', title: 'Two' }
    };

    it('finds the worktree of the task on the same connection', () => {
        expect(worktreeForTask(links, 'a', { id: '1' })).toBe('/wt/one');
        expect(worktreeForTask(links, 'b', { id: '2' })).toBe('/wt/two');
    });

    it('gives undefined when no worktree works on the task', () => {
        expect(worktreeForTask(links, 'a', { id: '3' })).toBeUndefined();
        expect(worktreeForTask({}, 'a', { id: '1' })).toBeUndefined();
    });
});

describe('board helpers', () => {
    const columns = [column('to do', [task('1')]), column('doing', [task('2', 'doing')]), column('done', [])];

    it('finds the column next to the column of the task', () => {
        expect(neighborColumn(columns, '1', 1)?.key).toBe('doing');
        expect(neighborColumn(columns, '2', -1)?.key).toBe('to do');
        expect(neighborColumn(columns, '1', -1)).toBeUndefined();
        expect(neighborColumn(columns, 'gone', 1)).toBeUndefined();
    });

    it('accepts a drop only on the column of another status', () => {
        expect(acceptsDrop(true, task('1', 'to do'), 'doing')).toBe(true);
        expect(acceptsDrop(true, task('1', 'To Do'), 'to do')).toBe(false);
        expect(acceptsDrop(false, task('1'), 'doing')).toBe(false);
        expect(acceptsDrop(true, undefined, 'doing')).toBe(false);
    });

    it('makes the status of a group for its status dot', () => {
        expect(groupStatus({ key: 'doing', name: 'Doing', color: '#fff', category: 'in_progress' })).toEqual({
            id: 'doing',
            name: 'Doing',
            color: '#fff',
            category: 'in_progress'
        });
    });
});

describe('labels and text', () => {
    it('puts the key before the title when the task has a key', () => {
        expect(taskLabel({ key: 'ENG-1', title: 'Fix it' })).toBe('ENG-1 Fix it');
        expect(taskLabel({ title: 'Fix it' })).toBe('Fix it');
    });

    it('picks the last repository when the project still has it, else the first', () => {
        expect(targetRepo(['/a', '/b'], '/b')).toBe('/b');
        expect(targetRepo(['/a', '/b'], '/gone')).toBe('/a');
        expect(targetRepo([], '')).toBeUndefined();
    });

    it('names the required settings that a connection needs', () => {
        const settings = [
            { key: 'token', label: 'API Token', required: true },
            { key: 'team', label: 'Team', required: true },
            { key: 'note', label: 'Note' }
        ] as ConnectionInfo['settings'];
        expect(missingSettingsText({ settings })).toBe('api token and team');
        expect(missingSettingsText({ settings: [] })).toBe('settings');
    });

    it('shows the path and the name of the collection in its title', () => {
        expect(collectionTitle({ name: 'Bugs', path: 'Space / Folder' })).toBe('Collection: Space / Folder / Bugs');
        expect(collectionTitle({ name: 'Bugs' })).toBe('Collection: Bugs');
        expect(collectionTitle(undefined)).toBe('Collection');
    });

    it('gives the placeholder for the state of the collections', () => {
        expect(collectionPlaceholder(undefined)).toBe('Loading collections…');
        expect(collectionPlaceholder([])).toBe('No collections');
        expect(collectionPlaceholder([{ id: '1', name: 'One' }])).toBe('Select a collection');
    });

    it('tells the task list what to show before the tasks load', () => {
        expect(taskListState(undefined, undefined)).toBe('collections');
        expect(taskListState([], undefined)).toBe('empty');
        expect(taskListState([{ id: '1', name: 'One' }], undefined)).toBe('choose');
        expect(taskListState([{ id: '1', name: 'One' }], '1')).toBe('tasks');
    });
});

describe('personInitials', () => {
    it.each([
        ['Sam Lee', 'SL'],
        ['sam', 'S'],
        ['Ana María Ruiz', 'AR'],
        ['ana.ruiz@example.com', 'AR'],
        ['jane_doe', 'JD'],
        ['', '?'],
        ['  ', '?']
    ])('gives the initials of %j', (name, expected) => {
        expect(personInitials(name)).toBe(expected);
    });
});

describe('formatDuration', () => {
    it.each([
        [0, '0m'],
        [45 * 60_000, '45m'],
        [2 * 3_600_000, '2h'],
        [2.5 * 3_600_000, '2h 30m']
    ])('formats %d ms', (ms, expected) => {
        expect(formatDuration(ms)).toBe(expected);
    });
});

describe('formatDay', () => {
    it('shows a day without a time in the local time zone', () => {
        expect(formatDay('2026-11-03', 'en-US')).toBe('Nov 3, 2026');
    });

    it('shows the time of an ISO time', () => {
        const iso = new Date(2026, 10, 3, 14, 5).toISOString();
        expect(formatDay(iso, 'en-US')).toBe('Nov 3, 2026, 2:05 PM');
    });

    it('keeps text that is not a date', () => {
        expect(formatDay('soon')).toBe('soon');
    });
});

describe('formatBytes', () => {
    it.each([
        [120, '120 B'],
        [4300, '4.2 KB'],
        [3_250_000, '3.1 MB'],
        [50 * 1024 * 1024, '50 MB']
    ])('formats %d bytes', (bytes, expected) => {
        expect(formatBytes(bytes)).toBe(expected);
    });
});

describe('checklistProgress', () => {
    it('counts the done items of all checklists', () => {
        expect(checklistProgress([{ items: [{ done: true }, { done: false }] }, { items: [{ done: true }] }])).toEqual({ done: 2, total: 3 });
    });
});

describe('customFieldEmpty', () => {
    it.each([
        [{ type: 'text' }, true],
        [{ type: 'text', value: '' }, true],
        [{ type: 'number', value: 0 }, false],
        [{ type: 'boolean', value: false }, false],
        [{ type: 'people', people: [] }, true],
        [{ type: 'labels', labels: [{}] }, false]
    ])('checks %j', (field, expected) => {
        expect(customFieldEmpty(field)).toBe(expected);
    });
});

describe('task edits', () => {
    const task = { id: 't', title: 'T', status: { id: 's', name: 'S', category: 'todo' as const } };

    it('reads a duration', () => {
        expect(parseDuration('1h 30m')).toBe(5_400_000);
        expect(parseDuration('90m')).toBe(5_400_000);
        expect(parseDuration('1.5')).toBe(5_400_000);
        expect(parseDuration('2d')).toBe(16 * 3_600_000);
        expect(parseDuration('  ')).toBeNull();
        expect(parseDuration('soon')).toBeUndefined();
        expect(parseDuration('1h soon')).toBeUndefined();
    });

    it('gives the day of a date for a date input', () => {
        expect(dayInputValue('2026-11-03')).toBe('2026-11-03');
        expect(dayInputValue(new Date(2026, 10, 3, 15).toISOString())).toBe('2026-11-03');
        expect(dayInputValue(undefined)).toBe('');
        expect(dayInputValue('nope')).toBe('');
    });

    it('finds the editable parts', () => {
        expect(editableParts(task, {})).toEqual({});
        expect(editableParts(task, { update: true, edit: true })).toEqual({ title: true, description: true });
        expect(editableParts({ ...task, editable: { labels: true } }, { update: true, edit: true })).toEqual({ labels: true });
    });

    it('adds new labels to the cached options', () => {
        const current = { options: [{ id: 'bug', name: 'bug' }], create: true };
        expect(addLabelOptions(current, [{ name: 'bug' }])).toBe(current);
        expect(addLabelOptions(current, [{ name: 'bug' }, { name: 'ui', color: '#fff' }]).options).toEqual([
            { id: 'bug', name: 'bug' },
            { id: 'ui', name: 'ui', color: '#fff' }
        ]);
    });
});

describe('comment mentions', () => {
    const task = (id: string, title: string, key?: string) => ({ id, key, title, status: { id: 's', name: 'S', category: 'todo' as const } });

    it('ranks people by name', () => {
        const people = [
            { id: '1', name: 'Bob Ann' },
            { id: '2', name: 'Ann Lee' },
            { id: '3', name: 'Joanna' },
            { id: '4', name: 'Zed' }
        ];
        expect(rankPeople(people, 'ann').map(person => person.id)).toEqual(['2', '1', '3']);
        expect(rankPeople(people, '').map(person => person.id)).toEqual(['1', '2', '3', '4']);
    });

    it('ranks tasks by key and title and leaves out the open task', () => {
        const tasks = [task('a', 'Fix login', 'ENG-1'), task('b', 'Login page', 'ENG-2'), task('c', 'Add ENG docs')];
        expect(rankTasks(tasks, 'eng-2').map(item => item.id)).toEqual(['b']);
        expect(rankTasks(tasks, 'login', 'b').map(item => item.id)).toEqual(['a']);
    });

    it('uses the key, the URL or the ID as the reference text', () => {
        expect(referenceText({ id: '1', key: 'ENG-1', url: 'u' })).toBe('ENG-1');
        expect(referenceText({ id: '1', url: 'u' })).toBe('u');
        expect(referenceText({ id: '1' })).toBe('1');
    });

    it('keeps only the mentions and references that are still in the body', () => {
        const result = commentLinks(
            'Hi @Ann Lee, see ENG-1',
            [
                { id: '2', name: 'Ann Lee' },
                { id: '2', name: 'Ann Lee' },
                { id: '4', name: 'Zed' }
            ],
            [
                { id: 'a', text: 'ENG-1' },
                { id: 'b', text: 'ENG-2' }
            ]
        );
        expect(result).toEqual({ mentions: [{ id: '2', name: 'Ann Lee' }], references: [{ id: 'a', text: 'ENG-1' }] });
        expect(commentLinks('plain', [], [])).toEqual({});
    });
});

describe('noMatchText', () => {
    const allPeople = { people: [], unassigned: false };
    const somePeople = { people: ['7'], unassigned: false };
    const allLabels = { labels: [], unlabeled: false };
    const someLabels = { labels: ['bug'], unlabeled: false };

    it.each([
        ['login', allPeople, allLabels, 'No tasks match “login”.'],
        ['login', somePeople, allLabels, 'No tasks with the selected assignees match “login”.'],
        ['', allPeople, someLabels, 'No tasks with the selected labels in this collection.'],
        ['', somePeople, someLabels, 'No tasks with the selected assignees and labels in this collection.']
    ])('tells which filters hide the tasks for %j', (query, assignee, label, expected) => {
        expect(noMatchText(query, assignee, label)).toBe(expected);
    });
});

describe('findFreshTask', () => {
    const now = 1_000_000;
    const maxAge = 60_000;

    it('finds the task in a fresh list', () => {
        const lists = [{ tasks: [task('a'), task('b', 'done')], updatedAt: now - 1000, invalidated: false }];
        expect(findFreshTask(lists, 'b', now, maxAge)?.status.name).toBe('done');
    });

    it('ignores a list that is too old or marked as stale', () => {
        const lists = [
            { tasks: [task('a')], updatedAt: now - maxAge - 1, invalidated: false },
            { tasks: [task('a')], updatedAt: now, invalidated: true }
        ];
        expect(findFreshTask(lists, 'a', now, maxAge)).toBeUndefined();
    });

    it('returns undefined when no list has the task', () => {
        expect(findFreshTask([{ tasks: undefined, updatedAt: now, invalidated: false }], 'a', now, maxAge)).toBeUndefined();
    });
});
