import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ConnectionInfo, TaskSource } from '@shared/tasks';
import {
    applyConnectionChange,
    connectionAdded,
    connectionChanged,
    connectionRemoved,
    enabledAfterChange,
    isConnectionDataKey,
    taskManagerKeys
} from './task-managers-cache';

function connection(id: string, change: Partial<ConnectionInfo> = {}): ConnectionInfo {
    return {
        id,
        pluginId: 'clickup',
        name: id,
        enabled: true,
        pluginName: 'ClickUp',
        settings: [],
        configured: true,
        settingsWithValue: [],
        publicSettings: {},
        ...change
    };
}

describe('applyConnectionChange', () => {
    it('trims the name and ignores an empty name', () => {
        expect(applyConnectionChange(connection('a'), { name: '  Work ' }).name).toBe('Work');
        expect(applyConnectionChange(connection('a'), { name: '  ' }).name).toBe('a');
    });

    it('removes the scope and the start status with null', () => {
        const before = connection('a', { scope: ['w1'], startStatus: 'doing' });
        const after = applyConnectionChange(before, { scope: null, startStatus: null });
        expect(after.scope).toBeUndefined();
        expect(after.startStatus).toBeUndefined();
        expect(before.scope).toEqual(['w1']);
    });

    it('sets the scope, the on/off state and a trimmed start status', () => {
        const after = applyConnectionChange(connection('a'), { scope: ['w2'], enabled: false, startStatus: ' in progress ' });
        expect(after).toMatchObject({ scope: ['w2'], enabled: false, startStatus: 'in progress' });
    });
});

describe('enabledAfterChange', () => {
    it('uses the list of all connections when the cache has it', () => {
        const all = [connection('a'), connection('b', { enabled: false }), connection('c')];
        expect(enabledAfterChange([], all, 'a', { enabled: true })?.map(item => item.id)).toEqual(['a', 'c']);
    });

    it('removes a connection that goes off', () => {
        expect(enabledAfterChange([connection('a'), connection('b')], undefined, 'a', { enabled: false })?.map(item => item.id)).toEqual(['b']);
    });

    it('does not know the list when a connection that the list does not have goes on', () => {
        expect(enabledAfterChange([connection('a')], undefined, 'b', { enabled: true })).toBeUndefined();
    });
});

describe('isConnectionDataKey', () => {
    it('matches the task data of the connection only', () => {
        expect(isConnectionDataKey(['tasks', 'list', 'a', 'p1', 'c', 'f'], 'a')).toBe(true);
        expect(isConnectionDataKey(['tasks', 'source', 'a', 'p1'], 'a')).toBe(true);
        expect(isConnectionDataKey(['tasks', 'list', 'b', 'p1'], 'a')).toBe(false);
        expect(isConnectionDataKey(['tasks', 'connections', 'a'], 'a')).toBe(false);
        expect(isConnectionDataKey(['tasks', 'source', 'a', 'p1'], 'a', ['list'])).toBe(false);
    });
});

describe('the cache updates', () => {
    const projectKey = ['tasks', 'connections', 'p1'];

    function client(): QueryClient {
        const result = new QueryClient();
        result.setQueryData(taskManagerKeys.allConnections, [connection('a'), connection('b', { enabled: false })]);
        result.setQueryData(projectKey, { list: [connection('a')], saved: 'a' });
        result.setQueryData(['tasks', 'source', 'a', 'p1'], { connectionId: 'a', name: 'a' } as TaskSource);
        result.setQueryData(['tasks', 'list', 'a', 'p1', 'c', 'f'], []);
        return result;
    }

    it('patches the lists and the source after a new name, and keeps the task data fresh', () => {
        const cache = client();
        connectionChanged(cache, 'a', { name: 'Work' });
        expect(cache.getQueryData<ConnectionInfo[]>(taskManagerKeys.allConnections)?.[0].name).toBe('Work');
        expect(cache.getQueryData<{ list: ConnectionInfo[] }>(projectKey)?.list[0].name).toBe('Work');
        expect(cache.getQueryData<TaskSource>(['tasks', 'source', 'a', 'p1'])?.name).toBe('Work');
        expect(cache.getQueryState(['tasks', 'list', 'a', 'p1', 'c', 'f'])?.isInvalidated).toBe(false);
    });

    it('marks the task data as stale after a new scope', () => {
        const cache = client();
        connectionChanged(cache, 'a', { scope: ['w1'] });
        expect(cache.getQueryState(['tasks', 'list', 'a', 'p1', 'c', 'f'])?.isInvalidated).toBe(true);
        expect(cache.getQueryState(['tasks', 'source', 'a', 'p1'])?.isInvalidated).toBe(false);
    });

    it('adds a connection that goes on to the project lists', () => {
        const cache = client();
        connectionChanged(cache, 'b', { enabled: true });
        expect(cache.getQueryData<{ list: ConnectionInfo[] }>(projectKey)?.list.map(item => item.id)).toEqual(['a', 'b']);
    });

    it('adds a new connection to the lists', () => {
        const cache = client();
        connectionAdded(cache, connection('c', { configured: false }));
        expect(cache.getQueryData<ConnectionInfo[]>(taskManagerKeys.allConnections)?.map(item => item.id)).toEqual(['a', 'b', 'c']);
        expect(cache.getQueryData<{ list: ConnectionInfo[] }>(projectKey)?.list.map(item => item.id)).toEqual(['a', 'c']);
    });

    it('forgets the data of a removed connection', () => {
        const cache = client();
        connectionRemoved(cache, 'a');
        expect(cache.getQueryData<ConnectionInfo[]>(taskManagerKeys.allConnections)?.map(item => item.id)).toEqual(['b']);
        expect(cache.getQueryData<{ list: ConnectionInfo[] }>(projectKey)?.list).toEqual([]);
        expect(cache.getQueryData(['tasks', 'source', 'a', 'p1'])).toBeUndefined();
        expect(cache.getQueryData(['tasks', 'list', 'a', 'p1', 'c', 'f'])).toBeUndefined();
    });
});
