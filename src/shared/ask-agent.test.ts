import { describe, expect, it } from 'vitest';
import {
    parseClaudeJson,
    afterMarker,
    askPrompt,
    codeAskPrompt,
    isWorktreeAsk,
    lineLabel,
    locateCode,
    parseSavedAnswer,
    parseSavedCodeAnswer,
    printCommand,
    sliceLines,
    stripTerminalCodes
} from './ask-agent';

describe('parseClaudeJson', () => {
    it('reads the answer and the counted tokens', () => {
        const text = JSON.stringify({ type: 'result', result: 'Done.', usage: { input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 7 } });
        expect(parseClaudeJson(text)).toEqual({ answer: 'Done.', tokens: 12, cacheReads: 900 });
        expect(parseClaudeJson('plain text')).toBeUndefined();
        expect(parseClaudeJson('{"result": 3}')).toBeUndefined();
    });
});

describe('printCommand', () => {
    it('runs each known agent in print mode', () => {
        expect(printCommand('claude --model opus')).toBe('claude --model opus -p');
        expect(printCommand('codex')).toBe('codex exec --sandbox read-only --skip-git-repo-check -');
        expect(printCommand('gemini')).toBe("gemini -p 'Answer the question above.'");
        expect(printCommand('opencode')).toBe("opencode run --agent plan 'Answer the question below.'");
    });

    it('returns undefined for another program', () => {
        expect(printCommand('aider')).toBeUndefined();
    });
});

describe('askPrompt', () => {
    const pr = { number: 3, title: 'T', url: 'u', baseRefName: 'main', headRefName: 'f', baseRefOid: 'b'.repeat(40), headRefOid: 'h'.repeat(40) };

    it('fences code that contains backticks with a longer fence', () => {
        const prompt = askPrompt({
            pr,
            repo: { owner: 'o', name: 'r' },
            path: 'a.md',
            side: 'RIGHT',
            startLine: 2,
            endLine: 4,
            code: '```js\nx\n```',
            question: 'Why?'
        });
        expect(prompt).toContain('lines 2–4 of the new version');
        expect(prompt).toContain('````\n```js\nx\n```\n````');
        expect(prompt.endsWith('Question: Why?')).toBe(true);
    });
});

describe('codeAskPrompt', () => {
    it('names the file and the lines, and fences the code', () => {
        const prompt = codeAskPrompt({ path: 'src/a.ts', startLine: 3, endLine: 5, code: 'a ``` b', question: 'What does it do?' });
        expect(prompt).toContain('src/a.ts, lines 3–5');
        expect(prompt).toContain('````\na ``` b\n````');
        expect(prompt.endsWith('Question: What does it do?')).toBe(true);
    });

    it('cuts very long code', () => {
        const prompt = codeAskPrompt({ path: 'a', startLine: 1, endLine: 1, code: 'x'.repeat(70_000), question: 'q' });
        expect(prompt).toContain('(the lines continue)');
        expect(prompt.length).toBeLessThan(61_000);
    });
});

describe('isWorktreeAsk', () => {
    it('finds the request kind', () => {
        expect(isWorktreeAsk({ id: '1', worktree: '/w', prompt: 'p' })).toBe(true);
        expect(isWorktreeAsk({ id: '1', repo: { owner: 'o', name: 'r' }, headRefOid: 'abc', prompt: 'p' })).toBe(false);
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
        id: 'q1',
        repo: { owner: 'o', name: 'r', extra: 1 },
        number: 2,
        path: 'a.ts',
        side: 'LEFT',
        startLine: 1,
        line: 1,
        question: 'Q',
        agent: 'Codex',
        answer: 'A',
        commit: 'abc',
        answeredAt: 5,
        unknown: true
    };

    it('keeps only the known fields', () => {
        expect(parseSavedAnswer(valid)).toEqual({
            id: 'q1',
            repo: { owner: 'o', name: 'r' },
            number: 2,
            path: 'a.ts',
            side: 'LEFT',
            startLine: 1,
            line: 1,
            question: 'Q',
            agent: 'Codex',
            answer: 'A',
            commit: 'abc',
            answeredAt: 5
        });
    });

    it('returns undefined for a missing or wrong field', () => {
        expect(parseSavedAnswer(null)).toBeUndefined();
        expect(parseSavedAnswer({ ...valid, answer: '' })).toBeUndefined();
        expect(parseSavedAnswer({ ...valid, number: 1.5 })).toBeUndefined();
        expect(parseSavedAnswer({ ...valid, repo: undefined })).toBeUndefined();
    });
});

describe('locateCode', () => {
    const lines = ['a', 'b', 'c', 'a', 'b', 'd'];

    it('keeps the old place when the lines did not change', () => {
        expect(locateCode(lines, { startLine: 4, line: 5, code: 'a\nb' })).toEqual({ startLine: 4, line: 5 });
    });

    it('finds the nearest place when the lines moved', () => {
        expect(locateCode(lines, { startLine: 2, line: 3, code: 'a\nb' })).toEqual({ startLine: 1, line: 2 });
        expect(locateCode(lines, { startLine: 6, line: 7, code: 'a\nb' })).toEqual({ startLine: 4, line: 5 });
    });

    it('returns undefined when the lines changed', () => {
        expect(locateCode(lines, { startLine: 1, line: 2, code: 'a\nx' })).toBeUndefined();
        expect(locateCode(['a'], { startLine: 1, line: 2, code: 'a\nb' })).toBeUndefined();
    });

    it('finds an empty line', () => {
        expect(locateCode(['x', ''], { startLine: 2, line: 2, code: '' })).toEqual({ startLine: 2, line: 2 });
    });
});

describe('parseSavedCodeAnswer', () => {
    const valid = {
        id: 'q',
        worktree: '/w',
        path: 'a.ts',
        startLine: 1,
        line: 2,
        code: '',
        question: 'Why?',
        agent: 'Claude Code',
        answer: 'Because.',
        answeredAt: 5
    };

    it('accepts a correct answer, also with empty code', () => {
        expect(parseSavedCodeAnswer(valid)).toEqual(valid);
    });

    it('rejects a wrong answer', () => {
        expect(parseSavedCodeAnswer({ ...valid, code: 3 })).toBeUndefined();
        expect(parseSavedCodeAnswer({ ...valid, startLine: 3 })).toBeUndefined();
        expect(parseSavedCodeAnswer({ ...valid, worktree: '' })).toBeUndefined();
    });
});
