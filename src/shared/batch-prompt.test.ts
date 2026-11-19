import { describe, expect, it } from 'vitest';
import { batchItemName, batchPrompt, type BatchPullRequest } from './batch-prompt';

const prs: BatchPullRequest[] = [
    { repo: 'octo/api', number: 12, url: 'https://github.com/octo/api/pull/12', title: 'Add the endpoint' },
    { repo: 'octo/web', number: 7, url: 'https://github.com/octo/web/pull/7', title: 'Use the endpoint' }
];

describe('batchItemName', () => {
    it('uses the number, else the branch', () => {
        expect(batchItemName(prs[0])).toBe('octo/api#12');
        expect(batchItemName({ repo: 'octo/api', title: 'x', branch: 'plan/1' })).toBe('octo/api (branch plan/1)');
        expect(batchItemName({ repo: 'octo/api', title: 'x' })).toBe('octo/api');
    });
});

describe('batchPrompt', () => {
    it('names the own pull request, lists all, and asks for a push', () => {
        const text = batchPrompt({ kind: 'group', title: 'Login', pullRequests: prs, index: 1, recipients: 2, prompt: '  Rename id to userId.  ', push: true });
        expect(text).toContain('You work on pull request octo/web#7 (https://github.com/octo/web/pull/7). It is part of the PR group "Login".');
        expect(text).toContain('1. octo/api#12: Add the endpoint\n2. octo/web#7: Use the endpoint (this worktree)');
        expect(text).toContain('The agents of 2 of these pull requests get this same request.');
        expect(text).toContain('The request:\n\nRename id to userId.');
        expect(text).toContain('push the branch');
    });

    it('leaves out the list and the note for one pull request, and can skip the push', () => {
        const text = batchPrompt({ kind: 'plan', title: 'Login', pullRequests: [prs[0]], index: 0, recipients: 1, prompt: 'Fix it.', push: false });
        expect(text).toContain('part of the plan "Login"');
        expect(text).not.toContain('in order');
        expect(text).not.toContain('same request');
        expect(text).toContain('Do not push.');
    });

    it('throws for an index outside the list', () => {
        expect(() => batchPrompt({ kind: 'plan', title: 'x', pullRequests: prs, index: 5, recipients: 1, prompt: 'x', push: true })).toThrow();
    });
});
