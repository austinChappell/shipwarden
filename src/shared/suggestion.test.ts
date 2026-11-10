import { describe, expect, it } from 'vitest';
import type { ReviewThread } from './github';
import { applySuggestion, hasSuggestion, hunkLines, splitSuggestions, suggestionBlock, threadSuggestionTarget } from './suggestion';

describe('splitSuggestions', () => {
    it('returns plain text as one part', () => {
        expect(splitSuggestions('Looks good.')).toEqual([{ kind: 'text', text: 'Looks good.' }]);
        expect(hasSuggestion('Looks good.')).toBe(false);
    });

    it('finds a suggestion block between text', () => {
        const body = 'Use a const.\n```suggestion\nconst a = 1;\nconst b = 2;\n```\nThanks.';
        expect(splitSuggestions(body)).toEqual([
            { kind: 'text', text: 'Use a const.' },
            { kind: 'suggestion', lines: ['const a = 1;', 'const b = 2;'] },
            { kind: 'text', text: 'Thanks.' }
        ]);
    });

    it('reads CRLF line endings, tilde fences and the case of the info string', () => {
        expect(splitSuggestions('~~~Suggestion\r\nx\r\n~~~')).toEqual([{ kind: 'suggestion', lines: ['x'] }]);
    });

    it('reads an empty block as a suggestion to remove the lines', () => {
        expect(splitSuggestions('```suggestion\n```')).toEqual([{ kind: 'suggestion', lines: [] }]);
    });

    it('keeps an empty line in a block', () => {
        expect(splitSuggestions('```suggestion\n\n```')).toEqual([{ kind: 'suggestion', lines: [''] }]);
    });

    it('needs a closing fence of the same character and at least the same length', () => {
        const body = '````suggestion\n```\ncode\n~~~~\n````';
        expect(splitSuggestions(body)).toEqual([{ kind: 'suggestion', lines: ['```', 'code', '~~~~'] }]);
    });

    it('ends a block without a closing fence at the end of the body', () => {
        expect(splitSuggestions('Fix:\n```suggestion\nreturn 1;')).toEqual([
            { kind: 'text', text: 'Fix:' },
            { kind: 'suggestion', lines: ['return 1;'] }
        ]);
    });

    it('ignores a suggestion fence in a different code block', () => {
        const body = '````markdown\n```suggestion\nx\n```\n````';
        expect(splitSuggestions(body)).toEqual([{ kind: 'text', text: body }]);
    });

    it('ignores other code blocks', () => {
        const body = '```ts\nconst a = 1;\n```';
        expect(hasSuggestion(body)).toBe(false);
    });

    it('removes the indent of an indented fence from the lines', () => {
        expect(splitSuggestions('  ```suggestion\n    a\n  b\n  ```')).toEqual([{ kind: 'suggestion', lines: ['  a', 'b'] }]);
    });

    it('finds two blocks', () => {
        const parts = splitSuggestions('```suggestion\na\n```\nor\n```suggestion\nb\n```');
        expect(parts.filter(part => part.kind === 'suggestion')).toHaveLength(2);
    });
});

describe('suggestionBlock', () => {
    it('makes a block that splitSuggestions reads back', () => {
        const code = 'const a = 1;\n\nconst b = 2;';
        expect(suggestionBlock(code)).toBe('```suggestion\nconst a = 1;\n\nconst b = 2;\n```');
        expect(splitSuggestions(suggestionBlock(code))).toEqual([{ kind: 'suggestion', lines: code.split('\n') }]);
    });

    it('uses a longer fence when the code has backticks', () => {
        const code = 'Use ```ts to start a block.';
        const block = suggestionBlock(code);
        expect(block.startsWith('````suggestion\n')).toBe(true);
        expect(splitSuggestions(block)).toEqual([{ kind: 'suggestion', lines: [code] }]);
    });
});

describe('hunkLines', () => {
    const hunk = '@@ -10,5 +10,6 @@ function main() {\n   const a = 1;\n-  const b = 2;\n+  const b = 3;\n+  const c = 4;\n   return a;';

    it('returns the last lines of the new side', () => {
        expect(hunkLines(hunk, 1)).toEqual(['  return a;']);
        expect(hunkLines(hunk, 3)).toEqual(['  const b = 3;', '  const c = 4;', '  return a;']);
    });

    it('returns undefined when the hunk has too few lines', () => {
        expect(hunkLines(hunk, 5)).toBeUndefined();
        expect(hunkLines(hunk, 0)).toBeUndefined();
    });

    it('ignores the "No newline" marker and a last newline', () => {
        expect(hunkLines('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n', 1)).toEqual(['b']);
    });
});

function thread(change: Partial<ReviewThread>, diffHunk?: string): ReviewThread {
    return {
        id: 't',
        path: 'src/a.ts',
        line: 12,
        originalLine: 12,
        side: 'RIGHT',
        isResolved: false,
        isOutdated: false,
        comments: [{ id: 'c', databaseId: 1, author: null, body: '', createdAt: '', url: '', diffHunk }],
        ...change
    };
}

describe('threadSuggestionTarget', () => {
    const hunk = '@@ -8,3 +8,5 @@\n a\n+b\n+c\n d\n e';

    it('returns the old lines of a comment on one line', () => {
        expect(threadSuggestionTarget(thread({}, hunk))).toEqual({ startLine: 12, line: 12, original: ['e'] });
    });

    it('returns the old lines of a comment on more lines', () => {
        expect(threadSuggestionTarget(thread({ startLine: 10, originalStartLine: 10 }, hunk))).toEqual({ startLine: 10, line: 12, original: ['c', 'd', 'e'] });
    });

    it('uses the original line for an outdated thread', () => {
        expect(threadSuggestionTarget(thread({ line: null, originalLine: 12, isOutdated: true }, hunk))?.line).toBe(12);
    });

    it('returns undefined for the old side or without a diff hunk', () => {
        expect(threadSuggestionTarget(thread({ side: 'LEFT' }, hunk))).toBeUndefined();
        expect(threadSuggestionTarget(thread({}))).toBeUndefined();
    });
});

describe('applySuggestion', () => {
    const file = 'one\ntwo\nthree\nfour\n';

    it('replaces one line', () => {
        expect(applySuggestion(file, { startLine: 2, line: 2, original: ['two'] }, ['TWO'])).toEqual({
            kind: 'applied',
            text: 'one\nTWO\nthree\nfour\n',
            startLine: 2,
            line: 2
        });
    });

    it('replaces a range with more or fewer lines', () => {
        expect(applySuggestion(file, { startLine: 2, line: 3, original: ['two', 'three'] }, ['2', '2.5', '3'])).toMatchObject({
            text: 'one\n2\n2.5\n3\nfour\n'
        });
        expect(applySuggestion(file, { startLine: 2, line: 3, original: ['two', 'three'] }, ['23'])).toMatchObject({ text: 'one\n23\nfour\n' });
    });

    it('removes the lines for an empty suggestion', () => {
        expect(applySuggestion(file, { startLine: 1, line: 2, original: ['one', 'two'] }, [])).toMatchObject({ text: 'three\nfour\n' });
    });

    it('finds lines that moved after the comment', () => {
        const moved = 'zero\nnew\none\ntwo\nthree\nfour\n';
        expect(applySuggestion(moved, { startLine: 2, line: 2, original: ['two'] }, ['TWO'])).toEqual({
            kind: 'applied',
            text: 'zero\nnew\none\nTWO\nthree\nfour\n',
            startLine: 4,
            line: 4
        });
    });

    it('selects the nearest copy of lines that occur more than one time', () => {
        const text = 'x\na\nx\nb\nx\n';
        expect(applySuggestion(text, { startLine: 5, line: 5, original: ['x'] }, ['y'])).toMatchObject({ text: 'x\na\nx\nb\ny\n', startLine: 5 });
    });

    it('returns "stale" when the old lines changed', () => {
        expect(applySuggestion('one\n2\nthree\n', { startLine: 2, line: 2, original: ['two'] }, ['TWO'])).toEqual({ kind: 'stale' });
    });

    it('returns "already" when the file has the new lines', () => {
        expect(applySuggestion('one\nTWO\nthree\n', { startLine: 2, line: 2, original: ['two'] }, ['TWO'])).toEqual({ kind: 'already' });
        expect(applySuggestion(file, { startLine: 2, line: 2, original: ['two'] }, ['two'])).toEqual({ kind: 'already' });
    });

    it('keeps CRLF line endings and a file without a last newline', () => {
        expect(applySuggestion('a\r\nb\r\nc', { startLine: 2, line: 2, original: ['b'] }, ['B', 'B2'])).toMatchObject({ text: 'a\r\nB\r\nB2\r\nc' });
    });
});
