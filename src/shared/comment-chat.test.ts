import { describe, expect, it } from 'vitest';
import { commentChatKey, commentChatPrompt, subjectLines, type CommentChatSubject } from './comment-chat';
import type { PendingComment, ReviewThread } from './github';

const pr = { number: 7, title: 'Add a cache', url: 'https://github.com/o/r/pull/7', baseRefName: 'main', headRefName: 'cache', headRefOid: 'abc1234' };

function thread(change: Partial<ReviewThread> = {}): ReviewThread {
    return {
        id: 'T1',
        path: 'src/a.ts',
        line: 12,
        originalLine: 10,
        startLine: null,
        originalStartLine: null,
        side: 'RIGHT',
        isResolved: false,
        isOutdated: false,
        comments: [{ id: 'C1', body: 'Why a map here?', author: { login: 'ann' } } as ReviewThread['comments'][number]],
        ...change
    };
}

const pending: PendingComment = { path: 'src/b.ts', line: 5, startLine: 3, side: 'LEFT', body: 'This removes the guard.' };

describe('subjectLines', () => {
    it('uses the current lines of a thread', () => {
        expect(subjectLines({ kind: 'thread', thread: thread({ startLine: 10 }) })).toEqual({
            path: 'src/a.ts',
            side: 'RIGHT',
            startLine: 10,
            line: 12,
            outdated: false
        });
    });

    it('uses the original lines of an outdated thread', () => {
        const subject: CommentChatSubject = { kind: 'thread', thread: thread({ line: null, originalStartLine: 8 }) };
        expect(subjectLines(subject)).toEqual({ path: 'src/a.ts', side: 'RIGHT', startLine: 8, line: 10, outdated: true });
    });

    it('returns undefined for a thread without a line', () => {
        expect(subjectLines({ kind: 'thread', thread: thread({ line: null, originalLine: null }) })).toBeUndefined();
    });

    it('uses the lines of a pending comment', () => {
        expect(subjectLines({ kind: 'pending', comment: pending })).toEqual({ path: 'src/b.ts', side: 'LEFT', startLine: 3, line: 5, outdated: false });
    });
});

describe('commentChatKey', () => {
    it('keeps the key of a pending comment when its text changes', () => {
        const before = commentChatKey('github:o/r', 7, { kind: 'pending', comment: pending });
        const after = commentChatKey('github:o/r', 7, { kind: 'pending', comment: { ...pending, body: 'New text' } });
        expect(after).toBe(before);
    });

    it('gives different keys to a thread and a pending comment', () => {
        expect(commentChatKey('w', 7, { kind: 'thread', thread: thread() })).not.toBe(commentChatKey('w', 7, { kind: 'pending', comment: pending }));
    });
});

describe('commentChatPrompt', () => {
    it('has the thread, the code, the rule not to change files, and the new message', () => {
        const prompt = commentChatPrompt({
            pr,
            repo: { owner: 'o', name: 'r' },
            subject: { kind: 'thread', thread: thread() },
            code: 'const cache = new Map();',
            history: [],
            message: 'Is the reviewer right?'
        });
        expect(prompt).toContain('pull request #7 "Add a cache" in o/r');
        expect(prompt).toContain('src/a.ts, line 12 of the new version');
        expect(prompt).toContain('ann: Why a map here?');
        expect(prompt).toContain('const cache = new Map();');
        expect(prompt).toContain('Do not make the change, and do not change files.');
        expect(prompt).not.toContain('Our chat until now');
        expect(prompt.endsWith('My new message: Is the reviewer right?')).toBe(true);
    });

    it('says that a pending comment is not posted, and adds the earlier messages', () => {
        const prompt = commentChatPrompt({
            pr,
            subject: { kind: 'pending', comment: pending },
            history: [
                { id: '1', role: 'user', text: 'Is this true?', at: 1 },
                { id: '2', role: 'agent', text: 'Yes.', agent: 'Claude Code', at: 2 }
            ],
            message: 'Make it shorter.'
        });
        expect(prompt).toContain('src/b.ts, lines 3–5 of the old version (the removed lines)');
        expect(prompt).toContain('I did not post it yet.');
        expect(prompt).toContain('Me: Is this true?\n\nYou: Yes.');
    });
});
