import { describe, expect, it } from 'vitest';
import * as github from './map.js';

const issue = {
    number: 7,
    repository_url: 'https://api.github.com/repos/o/r',
    title: 'Fix login',
    html_url: 'https://github.com/o/r/issues/7',
    state: 'open',
    assignees: [{ login: 'ann', avatar_url: 'a.png' }],
    labels: [{ name: 'bug', color: 'd73a4a' }],
    updated_at: '2026-11-07T00:00:00Z',
    body: 'Body',
    user: { login: 'Bob' },
    comments: 2,
    milestone: null
};

describe('GitHub Issues edits', () => {
    it('gives the assignees their login as the ID, and adds the editable parts only when they are given', () => {
        const editable = { title: true, description: true, assignees: true, labels: true };
        const task = github.toTask(issue, { withDescription: true, editable });
        expect(task.assignees).toEqual([{ id: 'ann', name: 'ann', avatarUrl: 'a.png' }]);
        expect(task.editable).toEqual(editable);
        expect(github.toTask(issue).editable).toBeUndefined();
    });

    it('finds the editable parts from the repository permissions and the author', () => {
        expect(github.editableParts(issue, { push: true }, 'ann')).toEqual({ title: true, description: true, assignees: true, labels: true });
        expect(github.editableParts(issue, { triage: true }, 'ann')).toEqual({ title: false, description: false, assignees: true, labels: true });
        expect(github.editableParts(issue, { pull: true }, 'bob')).toEqual({ title: true, description: true, assignees: false, labels: false });
        expect(github.editableParts(issue, {}, 'ann')).toEqual({ title: false, description: false, assignees: false, labels: false });
    });

    it('converts an update to the body of the PATCH request', () => {
        expect(github.issueChange({ id: 'o/r#7', status: 'not_planned' })).toEqual({ state: 'closed', state_reason: 'not_planned' });
        expect(github.issueChange({ id: 'o/r#7', title: ' New ', description: 'Text' })).toEqual({ title: 'New', body: 'Text' });
        expect(github.issueChange({ id: 'o/r#7', assignees: ['ann', 'bob'], labels: [] })).toEqual({ assignees: ['ann', 'bob'], labels: [] });
        expect(github.issueChange({ id: 'o/r#7' })).toEqual({});
    });

    it('refuses an empty title and the parts that GitHub issues do not have', () => {
        expect(() => github.issueChange({ id: 'o/r#7', title: '  ' })).toThrow('must have a title');
        expect(() => github.issueChange({ id: 'o/r#7', priority: '1' })).toThrow('priority');
        expect(() => github.issueChange({ id: 'o/r#7', dueDate: '2026-12-01' })).toThrow('dueDate');
    });

    it('maps labels to options and finds the labels that the repository does not have', () => {
        expect(github.labelOption({ name: 'bug', color: 'd73a4a' })).toEqual({ id: 'bug', name: 'bug', color: '#d73a4a' });
        expect(github.missingLabels(['Bug', 'new', 'new'], [{ name: 'bug' }])).toEqual(['new']);
    });
});
