import { describe, expect, it } from 'vitest';
import { afterMarker, askPrompt, lineLabel, parseSavedAnswer, printCommand, sliceLines, stripTerminalCodes } from './ask-agent';

describe('printCommand', () => {
    it('runs each known agent in print mode', () => {
        expect(printCommand('claude --model opus')).toBe('claude --model opus -p');
        expect(printCommand('codex')).toBe('codex exec --sandbox read-only --skip-git-repo-check -');
        expect(printCommand('gemini')).toBe("gemini -p 'Answer the question above.'");
    });

    it('returns undefined for another program', () => {
        expect(printCommand('aider')).toBeUndefined();
    });
});

describe('askPrompt', () => {
    const pr = { number: 3, title: 'T', url: 'u', baseRefName: 'main', headRefName: 'f', baseRefOid: 'b'.repeat(40), headRefOid: 'h'.repeat(40) };

    it('fences code that contains backticks with a longer fence', () => {
        const prompt = askPrompt({ pr, repo: { owner: 'o', name: 'r' }, path: 'a.md', side: 'RIGHT', startLine: 2, endLine: 4, code: '```js\nx\n```', question: 'Why?' });
        expect(prompt).toContain('lines 2–4 of the new version');
        expect(prompt).toContain('````\n```js\nx\n```\n````');
        expect(prompt.endsWith('Question: Why?')).toBe(true);
    });
});

describe('helpers', () => {
    it('labels one line or a range', () => {
        expect(lineLabel(5, 5)).toBe('line 5');
        expect(lineLabel(5, 7)).toBe('lines 5–7');
    });

    it('slices 1-based inclusive lines', () => {
        expect(sliceLines('a\nb\nc\nd', 2, 3)).toBe('b\nc');
    });

    it('drops the text before the marker', () => {
        expect(afterMarker('motd\nMARKanswer', 'MARK')).toBe('answer');
        expect(afterMarker('answer', 'MARK')).toBe('answer');
    });

    it('removes terminal control sequences', () => {
        expect(stripTerminalCodes('\x1b]0;claude\x07OK')).toBe('OK');
        expect(stripTerminalCodes('\x1b]2;title\x1b\\\x1b[1;32mOK\x1b[0m')).toBe('OK');
    });
});

describe('parseSavedAnswer', () => {
    const valid = {
        id: 'q1', repo: { owner: 'o', name: 'r', extra: 1 }, number: 2, path: 'a.ts', side: 'LEFT', startLine: 1, line: 1,
        question: 'Q', agent: 'Codex', answer: 'A', commit: 'abc', answeredAt: 5, unknown: true
    };

    it('keeps only the known fields', () => {
        expect(parseSavedAnswer(valid)).toEqual({
            id: 'q1', repo: { owner: 'o', name: 'r' }, number: 2, path: 'a.ts', side: 'LEFT', startLine: 1, line: 1,
            question: 'Q', agent: 'Codex', answer: 'A', commit: 'abc', answeredAt: 5
        });
    });

    it('returns undefined for a missing or wrong field', () => {
        expect(parseSavedAnswer(null)).toBeUndefined();
        expect(parseSavedAnswer({ ...valid, answer: '' })).toBeUndefined();
        expect(parseSavedAnswer({ ...valid, number: 1.5 })).toBeUndefined();
        expect(parseSavedAnswer({ ...valid, repo: undefined })).toBeUndefined();
    });
});
