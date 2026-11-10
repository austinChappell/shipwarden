import { describe, expect, it } from 'vitest';
import type { PullRequest, ReviewThread } from '@shared/github';
import { conflictPrompt, threadLine, threadPrompt } from './agent-prompts';

const pr = { number: 7, url: 'https://github.com/o/r/pull/7', baseRefName: 'main', headRefName: 'fix-login' } as PullRequest;

function thread(parts: Partial<ReviewThread>): ReviewThread {
    return {
        id: 't1', path: 'src/a.ts', line: 12, originalLine: 10, side: 'RIGHT', isResolved: false, isOutdated: false,
        comments: [
            { id: 'c1', databaseId: 1, author: { login: 'ann' }, body: 'Rename this.', createdAt: '' },
            { id: 'c2', databaseId: 2, author: null, body: 'Agreed.', createdAt: '' }
        ],
        ...parts
    } as ReviewThread;
}

describe('threadLine', () => {
    it('returns the line in the current diff', () => {
        expect(threadLine(thread({}))).toBe(12);
    });

    it('returns the original line of an outdated thread', () => {
        expect(threadLine(thread({ line: null }))).toBe(10);
    });

    it('returns null when the thread has no line', () => {
        expect(threadLine(thread({ line: null, originalLine: null }))).toBeNull();
    });
});

describe('threadPrompt', () => {
    it('contains the path, the line, the pull request and all comments', () => {
        expect(threadPrompt(pr, thread({}))).toBe(
            'A reviewer left this comment on src/a.ts line 12 in pull request #7 (https://github.com/o/r/pull/7):\n\n' +
            'ann: Rename this.\n\nsomeone: Agreed.\n\nMake the change that the reviewer asks for.'
        );
    });

    it('uses the original line of an outdated thread', () => {
        expect(threadPrompt(pr, thread({ line: null }))).toContain('src/a.ts line 10 in');
    });

    it('omits the line when the thread has no line', () => {
        expect(threadPrompt(pr, thread({ line: null, originalLine: null }))).toContain('on src/a.ts in pull request #7');
    });
});

describe('conflictPrompt', () => {
    it('tells the agent to merge the base branch and resolve the conflicts', () => {
        expect(conflictPrompt(pr)).toBe(
            'Pull request #7 (https://github.com/o/r/pull/7) has merge conflicts with main. ' +
            'Fetch origin, merge origin/main into fix-login, resolve the conflicts, run the tests, and commit the merge.'
        );
    });
});
