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
    labels: { nodes: [{ name: 'Bug', color: '#eb5757' }] },
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
            assignees: [{ name: 'ann', avatarUrl: 'https://example.com/ann.png' }],
            labels: [{ name: 'Bug', color: '#eb5757' }],
            priority: { name: 'High', level: 2 },
            updatedAt: '2026-11-07T10:00:00.000Z',
            description: '## Steps',
            fields: { branchName: 'ann/eng-123-fix-the-login-page', project: 'Auth', cycle: 'Cycle 12', estimate: 3, dueDate: '2026-11-20' }
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
        ).toEqual({ id: 'c1', author: { name: 'Bob Ray', avatarUrl: undefined }, body: 'Hi', createdAt: '2026-11-07T00:00:00.000Z' });
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
});
