import { describe, expect, it } from 'vitest';
import { createMessageParser, encodeMessage, runPlugin } from './sdk/index.js';
import * as github from './github-issues/map.js';
import * as clickup from './clickup/map.js';

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
            assignees: [{ name: 'ann', avatarUrl: 'a.png' }],
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
        expect(result.fields).toEqual({ dueDate: null });
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
        const spaces = [{
            space: { id: 's1', name: 'Engineering' },
            lists: [{ id: 1, name: 'Inbox' }],
            folders: [
                { id: 'f1', name: 'Sprints', lists: [{ id: 2, name: 'Sprint 12' }] },
                { id: 'f2', name: 'hidden', hidden: true, lists: [{ id: 3, name: 'Loose' }] }
            ]
        }];
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
