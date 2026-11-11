import { describe, expect, it } from 'vitest';
import * as linear from './map.js';

const state = (name, type, position, id = name) => ({ id, name, type, position, color: '#5e6ad2' });

const issue = {
    id: '6a1b2c3d-0000-4000-8000-000000000001',
    identifier: 'ENG-123',
    title: 'Fix the login page',
    url: 'https://linear.app/acme/issue/ENG-123/fix-the-login-page',
    priority: 2,
    priorityLabel: 'High',
    updatedAt: '2026-11-07T10:00:00.000Z',
    dueDate: '2026-11-20',
    estimate: 3,
    branchName: 'ann/eng-123-fix-the-login-page',
    description: '## Steps',
    state: state('In Review', 'started', 2, 'st-review'),
    assignee: { id: 'u1', name: 'Ann Lee', displayName: 'ann', avatarUrl: 'https://example.com/ann.png' },
    labels: { nodes: [{ id: 'l-bug', name: 'Bug', color: '#eb5757' }] },
    project: { name: 'Auth' },
    cycle: { number: 12, name: null },
    team: { id: 'team-eng', key: 'ENG' }
};

describe('Linear mapping', () => {
    it('maps an issue to a task with the identifier as the key and the branch name as a field', () => {
        expect(linear.toTask(issue, { withDescription: true })).toEqual({
            id: issue.id,
            key: 'ENG-123',
            title: 'Fix the login page',
            url: issue.url,
            status: { id: 'st-review', name: 'In Review', color: '#5e6ad2', category: 'in_progress', order: 3000002 },
            assignees: [{ id: 'u1', name: 'ann', avatarUrl: 'https://example.com/ann.png' }],
            labels: [{ id: 'l-bug', name: 'Bug', color: '#eb5757' }],
            priority: { name: 'High', level: 2 },
            updatedAt: '2026-11-07T10:00:00.000Z',
            description: '## Steps',
            fields: { branchName: 'ann/eng-123-fix-the-login-page', project: 'Auth', cycle: 'Cycle 12', estimate: 3, dueDate: '2026-11-20' },
            details: { dueDate: '2026-11-20' },
            editable: { title: true, description: true, assignees: true, labels: true, priority: true, dueDate: true }
        });
    });

    it('leaves out the description in a list, and the priority and the assignee when they are not set', () => {
        const task = linear.toTask({
            ...issue,
            priority: 0,
            priorityLabel: 'No priority',
            assignee: null,
            project: null,
            cycle: null,
            estimate: null,
            dueDate: null
        });
        expect(task.description).toBeUndefined();
        expect(task.details).toBeUndefined();
        expect(task.editable).toBeUndefined();
        expect(task.priority).toBeUndefined();
        expect(task.assignees).toEqual([]);
        expect(task.fields).toEqual({ branchName: issue.branchName, project: null, cycle: null, estimate: null, dueDate: null });
    });

    it('maps the workflow state types to categories', () => {
        expect(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'].map(linear.statusCategory)).toEqual([
            'backlog',
            'backlog',
            'todo',
            'in_progress',
            'done',
            'canceled'
        ]);
    });

    it('returns the states of a team in workflow order: first the type, then the position', () => {
        const states = linear.teamStatusOrder([
            state('Done', 'completed', 0),
            state('In Review', 'started', 2),
            state('Todo', 'unstarted', 0),
            state('In Progress', 'started', 1),
            state('Backlog', 'backlog', 0),
            state('Canceled', 'canceled', 0),
            state('Triage', 'triage', 0)
        ]);
        expect(states.map(item => item.name)).toEqual(['Triage', 'Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled']);
        expect(states[2]).toEqual({ id: 'Todo', name: 'Todo', color: '#5e6ad2', category: 'todo' });
    });

    it('maps the comment authors: users, integrations and people outside Linear', () => {
        expect(
            linear.toComment({
                id: 'c1',
                body: 'Hi',
                createdAt: '2026-11-07T00:00:00.000Z',
                user: { id: 'u2', name: 'Bob Ray', displayName: '', avatarUrl: null }
            })
        ).toEqual({ id: 'c1', author: { id: 'u2', name: 'Bob Ray', avatarUrl: undefined }, body: 'Hi', createdAt: '2026-11-07T00:00:00.000Z' });
        expect(linear.commentAuthor({ user: null, botActor: { name: 'GitHub', avatarUrl: 'gh.png' } })).toEqual({ name: 'GitHub', avatarUrl: 'gh.png' });
        expect(linear.commentAuthor({ user: null, botActor: null, externalUser: { name: 'Slack user' } })).toEqual({
            name: 'Slack user',
            avatarUrl: undefined
        });
    });

    it('maps the teams to collections and marks the default team', () => {
        const teams = [
            { id: 't1', key: 'ENG', name: 'Engineering' },
            { id: 't2', key: 'DES', name: 'Design' }
        ];
        expect(linear.toCollections(teams, { name: 'Acme', urlKey: 'acme' }, 't2')).toEqual([
            { id: 't1', name: 'Engineering', path: 'Acme', url: 'https://linear.app/acme/team/ENG/active' },
            { id: 't2', name: 'Design', path: 'Acme', url: 'https://linear.app/acme/team/DES/active', default: true }
        ]);
    });

    it('finds the team with the most issues', () => {
        expect(linear.busiestTeam([{ team: { id: 'a' } }, { team: { id: 'b' } }, { team: { id: 'b' } }])).toBe('b');
        expect(linear.busiestTeam([])).toBeUndefined();
    });

    it('makes the issue filter for each task list filter', () => {
        const open = { state: { type: { nin: ['completed', 'canceled'] } } };
        const team = { team: { id: { eq: 't1' } } };
        expect(linear.issueFilter('t1', 'assigned')).toEqual({ and: [team, open, { assignee: { isMe: { eq: true } } }] });
        expect(linear.issueFilter('t1', 'cycle')).toEqual({ and: [team, open, { cycle: { isActive: { eq: true } } }] });
        expect(linear.issueFilter('t1', 'open')).toEqual({ and: [team, open] });
        expect(linear.issueFilter('t1', 'all')).toEqual({ and: [team] });
    });

    it('searches by the title, and by the number for an identifier or a number', () => {
        expect(linear.issueFilter('t1', 'all', ' login ').and[1]).toEqual({ title: { containsIgnoreCase: 'login' } });
        expect(linear.issueFilter('t1', 'all', 'ENG-123').and[1]).toEqual({ or: [{ number: { eq: 123 } }, { title: { containsIgnoreCase: 'ENG-123' } }] });
        expect(linear.issueFilter('t1', 'all', '42').and[1]).toEqual({ or: [{ number: { eq: 42 } }, { title: { containsIgnoreCase: '42' } }] });
    });

    it('returns the Dashboard comments from other people after the own last comment', () => {
        const comment = (id, userId, createdAt) => ({ id, body: id, createdAt, user: { id: userId, name: userId, displayName: userId } });
        const issues = [
            {
                id: 'i1',
                identifier: 'ENG-1',
                title: 'One',
                url: 'u1',
                comments: {
                    nodes: [
                        comment('late', 'bob', '2026-11-07T12:00:00.000Z'),
                        comment('mine', 'me', '2026-11-07T11:00:00.000Z'),
                        comment('seen', 'bob', '2026-11-07T10:30:00.000Z'),
                        comment('old', 'bob', '2026-11-06T00:00:00.000Z')
                    ]
                }
            },
            {
                id: 'i2',
                identifier: 'ENG-2',
                title: 'Two',
                url: 'u2',
                comments: { nodes: [comment('new', 'cat', '2026-11-07T09:00:00.000Z')] }
            }
        ];
        expect(linear.activityComments(issues, 'me', Date.parse('2026-11-07T00:00:00.000Z'))).toEqual([
            { id: 'late', taskId: 'i1', taskKey: 'ENG-1', taskTitle: 'One', taskUrl: 'u1', author: 'bob', body: 'late', createdAt: '2026-11-07T12:00:00.000Z' },
            { id: 'new', taskId: 'i2', taskKey: 'ENG-2', taskTitle: 'Two', taskUrl: 'u2', author: 'cat', body: 'new', createdAt: '2026-11-07T09:00:00.000Z' }
        ]);
    });

    it('reads the GraphQL errors', () => {
        const errors = [
            { message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } },
            { message: 'raw', extensions: { userPresentableMessage: 'You cannot change this issue.' } }
        ];
        expect(errors.map(linear.errorCode)).toEqual(['RATELIMITED', undefined]);
        expect(linear.errorText(errors)).toBe('Rate limit exceeded You cannot change this issue.');
    });

    it('waits for the time in Retry-After, else until the reset time, within the limits', () => {
        const now = 1_000_000;
        expect(linear.retryDelay(new Headers({ 'retry-after': '5' }), now, 30_000)).toBe(5000);
        expect(linear.retryDelay(new Headers({ 'x-ratelimit-requests-reset': String(now + 12_000) }), now, 30_000)).toBe(12_000);
        expect(linear.retryDelay(new Headers({ 'retry-after': '3600' }), now, 30_000)).toBe(30_000);
        expect(linear.retryDelay(new Headers(), now, 30_000)).toBe(1000);
    });

    it('sorts the comments with the oldest first', () => {
        const comments = [{ createdAt: '2026-11-07T02:00:00Z' }, { createdAt: '2026-11-07T01:00:00Z' }];
        expect(linear.oldestFirst(comments).map(comment => comment.createdAt)).toEqual(['2026-11-07T01:00:00Z', '2026-11-07T02:00:00Z']);
    });

    it('converts a status change and the edits of a task to an IssueUpdateInput', () => {
        expect(linear.issueInput({ id: 'i1' })).toEqual({});
        expect(linear.issueInput({ id: 'i1', status: 'st-done' })).toEqual({ stateId: 'st-done' });
        expect(linear.issueInput({ id: 'i1', title: '  New title ', description: '## Plan' })).toEqual({ title: 'New title', description: '## Plan' });
        expect(linear.issueInput({ id: 'i1', labels: ['l1', 'l2'] })).toEqual({ labelIds: ['l1', 'l2'] });
        expect(linear.issueInput({ id: 'i1', labels: [] })).toEqual({ labelIds: [] });
        expect(linear.issueInput({ id: 'i1', dueDate: '2026-12-01' })).toEqual({ dueDate: '2026-12-01' });
        expect(linear.issueInput({ id: 'i1', dueDate: null })).toEqual({ dueDate: null });
    });

    it('keeps one assignee: the last ID of the list, or none for an empty list', () => {
        expect(linear.issueInput({ id: 'i1', assignees: ['u1', 'u2'] })).toEqual({ assigneeId: 'u2' });
        expect(linear.issueInput({ id: 'i1', assignees: [] })).toEqual({ assigneeId: null });
    });

    it('maps the priority option IDs to Linear priorities, and null to "No priority"', () => {
        expect(linear.issueInput({ id: 'i1', priority: '1' })).toEqual({ priority: 1 });
        expect(linear.issueInput({ id: 'i1', priority: '4' })).toEqual({ priority: 4 });
        expect(linear.issueInput({ id: 'i1', priority: null })).toEqual({ priority: 0 });
        expect(() => linear.issueInput({ id: 'i1', priority: '7' })).toThrow('does not exist');
        expect(linear.PRIORITIES.map(option => option.id)).toEqual(['1', '2', '3', '4']);
    });

    it('refuses an empty title, a date in the wrong form and the parts that Linear does not have', () => {
        expect(() => linear.issueInput({ id: 'i1', title: ' ' })).toThrow('must have a title');
        expect(() => linear.issueInput({ id: 'i1', dueDate: '12/01/2026' })).toThrow('YYYY-MM-DD');
        expect(() => linear.issueInput({ id: 'i1', startDate: '2026-12-01' })).toThrow('start date');
        expect(() => linear.issueInput({ id: 'i1', timeEstimate: 3600000 })).toThrow('estimate');
        expect(() => linear.issueInput({ id: 'i1', checklistItem: { id: 'c', done: true } })).toThrow('checklists');
    });

    it('lists the labels without group labels, and the active members, sorted by name', () => {
        const labels = [
            { id: 'l2', name: 'Feature', color: '#0f0', isGroup: false },
            { id: 'g', name: 'Area', color: '#000', isGroup: true },
            { id: 'l1', name: 'Bug', color: '', isGroup: false }
        ];
        expect(linear.labelOptions(labels)).toEqual([
            { id: 'l1', name: 'Bug', color: undefined },
            { id: 'l2', name: 'Feature', color: '#0f0' }
        ]);
        const users = [
            { id: 'u2', name: 'Zoe', displayName: 'zoe', avatarUrl: null, active: true },
            { id: 'u3', name: 'Old', displayName: 'old', avatarUrl: null, active: false },
            { id: 'u1', name: 'Ann Lee', displayName: 'ann', avatarUrl: 'a.png', active: true }
        ];
        expect(linear.memberOptions(users)).toEqual([
            { id: 'u1', name: 'ann', avatarUrl: 'a.png' },
            { id: 'u2', name: 'zoe', avatarUrl: undefined }
        ]);
    });
});
