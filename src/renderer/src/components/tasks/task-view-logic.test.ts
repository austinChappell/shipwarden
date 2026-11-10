import { describe, expect, it } from 'vitest';
import type { ConnectionInfo, StatusGroup, Task, TaskLink } from '@shared/tasks';
import {
    acceptsDrop,
    collectionPlaceholder,
    collectionTitle,
    connectionStateOf,
    formatField,
    groupStatus,
    isGroupCollapsed,
    missingSettingsText,
    neighborColumn,
    nextSelection,
    parseCollapseState,
    parseViewMode,
    patchTask,
    pickConnection,
    pickFilter,
    prependTask,
    removeTask,
    same,
    selectedCollection,
    targetRepo,
    taskLabel,
    toggleCollapse,
    uniqueTasks,
    worktreeForTask
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

describe('same', () => {
    it('keeps the current value when the data is equal', () => {
        const current = { a: [1, 2] };
        expect(same(current, { a: [1, 2] })).toBe(current);
    });

    it('gives the next value when the data changes or no current value exists', () => {
        const next = { a: [3] };
        expect(same({ a: [1] }, next)).toBe(next);
        expect(same<{ a: number[] } | undefined>(undefined, next)).toBe(next);
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

describe('collection selection', () => {
    it('counts the selection only for its own connection', () => {
        const selection = { connectionId: 'a', id: 'list-1' };
        expect(selectedCollection({ connectionId: 'a' }, selection)).toBe('list-1');
        expect(selectedCollection({ connectionId: 'b' }, selection)).toBeUndefined();
        expect(selectedCollection(null, selection)).toBeUndefined();
        expect(selectedCollection({ connectionId: 'a' }, undefined)).toBeUndefined();
    });

    it('keeps the same object when the picked collection does not change', () => {
        const current = { connectionId: 'a', id: 'list-1' };
        expect(nextSelection(current, 'a', 'list-1')).toBe(current);
        expect(nextSelection(current, 'a', 'list-2')).toEqual({ connectionId: 'a', id: 'list-2' });
        expect(nextSelection(current, 'b', 'list-1')).toEqual({ connectionId: 'b', id: 'list-1' });
        expect(nextSelection(current, 'a', undefined)).toBeUndefined();
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
});
