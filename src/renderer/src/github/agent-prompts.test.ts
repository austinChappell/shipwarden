import { describe, expect, it } from 'vitest';
import type { PullRequest, Review, ReviewThread } from '@shared/github';
import { commentPrompt, conflictPrompt, lineNotePrompt, reviewPrompt, reviewThreads, threadLine, threadPrompt } from './agent-prompts';

const pr = { number: 7, url: 'https://github.com/o/r/pull/7', baseRefName: 'main', headRefName: 'fix-login' } as PullRequest;

function thread(parts: Partial<ReviewThread>): ReviewThread {
    return {
        id: 't1',
        path: 'src/a.ts',
        line: 12,
        originalLine: 10,
        side: 'RIGHT',
        isResolved: false,
        isOutdated: false,
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

describe('lineNotePrompt', () => {
    it('contains the path, the lines, the pull request and the note', () => {
        expect(lineNotePrompt(pr, { path: 'src/a.ts', line: 5, startLine: 3, side: 'RIGHT', body: ' Use a map here. \n' })).toBe(
            'I left this note on src/a.ts lines 3–5 in pull request #7 (https://github.com/o/r/pull/7):\n\nUse a map here.\n\nMake the change that the note asks for.'
        );
    });

    it('names one line', () => {
        expect(lineNotePrompt(pr, { path: 'src/a.ts', line: 5, side: 'RIGHT', body: 'Fix.' })).toContain('on src/a.ts line 5 in');
    });

    it('marks a note on removed lines', () => {
        expect(lineNotePrompt(pr, { path: 'src/a.ts', line: 5, side: 'LEFT', body: 'Keep this.' })).toContain(
            'src/a.ts line 5 of the old version (the removed lines)'
        );
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

describe('commentPrompt', () => {
    it('contains the author, the pull request and the comment text', () => {
        expect(commentPrompt(pr, 'ann', ' Add the field to the type. \n')).toBe(
            'ann left this comment on pull request #7 (https://github.com/o/r/pull/7):\n\nAdd the field to the type.\n\nRead the comment and make the changes that it asks for.'
        );
    });

    it('names an unknown author "Someone"', () => {
        expect(commentPrompt(pr, null, 'Fix it.')).toMatch(/^Someone left this comment/);
    });
});

describe('reviewPrompt', () => {
    const review = { id: 'R1', author: { login: 'ann' }, state: 'COMMENTED', body: 'One change. ', submittedAt: '', url: '' } as Review;
    const own = thread({
        comments: [
            { id: 'c1', databaseId: 1, author: { login: 'ann' }, body: 'Add the field here.', createdAt: '', url: '', reviewId: 'R1' },
            { id: 'c2', databaseId: 2, author: { login: 'bo' }, body: 'Done?', createdAt: '', url: '', reviewId: 'R2' }
        ]
    });
    const resolved = thread({
        id: 't2',
        isResolved: true,
        comments: [{ id: 'c3', databaseId: 3, author: { login: 'ann' }, body: 'Old.', createdAt: '', url: '', reviewId: 'R1' }]
    });
    const other = thread({
        id: 't3',
        comments: [{ id: 'c4', databaseId: 4, author: { login: 'cy' }, body: 'Other.', createdAt: '', url: '', reviewId: 'R9' }]
    });
    const withThreads = { ...pr, threads: [own, resolved, other] } as PullRequest;

    it('finds only the open threads with a comment of the review', () => {
        expect(reviewThreads(withThreads, review).map(item => item.id)).toEqual(['t1']);
    });

    it('contains the text of the review and all comments of its open threads', () => {
        expect(reviewPrompt(withThreads, review)).toBe(
            'ann reviewed pull request #7 (https://github.com/o/r/pull/7).\n\nThe text of the review:\n\nOne change.\n\n' +
                'The thread on src/a.ts line 12:\n\nann: Add the field here.\n\nbo: Done?\n\nMake the changes that the review asks for.'
        );
    });

    it('leaves out the text when the review has none', () => {
        expect(reviewPrompt(withThreads, { ...review, body: '' })).not.toContain('The text of the review');
    });
});
