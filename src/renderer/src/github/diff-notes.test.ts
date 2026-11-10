import { describe, expect, it } from 'vitest';
import type { PendingComment, PullRequestFile, ReviewThread } from '@shared/github';
import type { AgentQuestion } from './agent-questions';
import {
    allFilesOpen,
    composerFromRange,
    composerModes,
    composerPlaceholder,
    composerSubmitLabel,
    currentMatchIndex,
    findCountText,
    fromSide,
    isFileOpen,
    lineAnnotations,
    nextMatchIndex,
    selectionLines,
    threadsWithLine,
    toSide,
    type EditorSelection
} from './diff-notes';

const thread = (id: string, path: string, line: number | null, side: 'LEFT' | 'RIGHT' = 'RIGHT'): ReviewThread => ({
    id,
    path,
    line,
    originalLine: 9,
    side,
    isResolved: false,
    isOutdated: line === null,
    comments: []
});

const pending: PendingComment = { path: 'a.ts', line: 5, side: 'LEFT', body: 'Fix' };

const question = { id: 'q', path: 'a.ts', side: 'RIGHT', startLine: 6, line: 7, question: 'Why?', status: 'running' } as AgentQuestion;

function selection(start: number, end: number, endColumn: number, empty = false): EditorSelection {
    return { startLineNumber: start, endLineNumber: end, endColumn, positionLineNumber: end, isEmpty: () => empty };
}

describe('toSide and fromSide', () => {
    it('map the left side to the removed lines and the right side to the added lines', () => {
        expect(toSide('LEFT')).toBe('deletions');
        expect(toSide('RIGHT')).toBe('additions');
        expect(fromSide('deletions')).toBe('LEFT');
        expect(fromSide('additions')).toBe('RIGHT');
    });

    it('maps an unknown side to the right side', () => {
        expect(fromSide(undefined)).toBe('RIGHT');
    });
});

describe('lineAnnotations', () => {
    it('puts each note under its line on its side', () => {
        const list = lineAnnotations({
            path: 'a.ts',
            threads: [thread('t1', 'a.ts', 3), thread('t2', 'b.ts', 3)],
            pending: [pending],
            questions: [question],
            composer: { line: 8, startLine: 8, side: 'RIGHT' }
        });
        expect(list.map(item => [item.metadata.kind, item.side, item.lineNumber])).toEqual([
            ['thread', 'additions', 3],
            ['pending', 'deletions', 5],
            ['question', 'additions', 7],
            ['composer', 'additions', 8]
        ]);
    });

    it('puts an outdated thread above the first line', () => {
        const [item] = lineAnnotations({ path: 'a.ts', threads: [thread('t1', 'a.ts', null, 'LEFT')], pending: [], questions: [], composer: undefined });
        expect(item).toMatchObject({ side: 'deletions', lineNumber: 0 });
    });
});

describe('composerFromRange', () => {
    it('takes the lines of a range on one side', () => {
        expect(composerFromRange({ start: 9, end: 4, side: 'additions' })).toEqual({ line: 4, startLine: 4, side: 'RIGHT' });
        expect(composerFromRange({ start: 2, end: 6, side: 'deletions', endSide: 'deletions' })).toEqual({ line: 6, startLine: 2, side: 'LEFT' });
    });

    it('takes only the last line of a range across both sides', () => {
        expect(composerFromRange({ start: 2, end: 6, side: 'deletions', endSide: 'additions' })).toEqual({ line: 6, startLine: 6, side: 'RIGHT' });
    });
});

describe('threadsWithLine', () => {
    it('keeps the threads of the file that have a line in the current diff', () => {
        const threads = [thread('t1', 'a.ts', 3), thread('t2', 'a.ts', null), thread('t3', 'b.ts', 3)];
        expect(threadsWithLine(threads, 'a.ts').map(item => item.id)).toEqual(['t1']);
    });
});

describe('selectionLines', () => {
    it('returns undefined without a selection', () => {
        expect(selectionLines(null)).toBeUndefined();
    });

    it('returns the line of the cursor for an empty selection', () => {
        expect(selectionLines(selection(5, 5, 3, true))).toEqual({ startLine: 5, line: 5 });
    });

    it('returns the selected lines', () => {
        expect(selectionLines(selection(2, 6, 4))).toEqual({ startLine: 2, line: 6 });
    });

    it('does not count the last line when the selection ends at column 1', () => {
        expect(selectionLines(selection(2, 6, 1))).toEqual({ startLine: 2, line: 5 });
    });

    it('keeps a one-line selection that ends at column 1', () => {
        expect(selectionLines(selection(3, 3, 1))).toEqual({ startLine: 3, line: 3 });
    });
});

describe('isFileOpen and allFilesOpen', () => {
    const files = [
        { path: 'a.ts', viewed: false },
        { path: 'b.ts', viewed: true }
    ] as PullRequestFile[];

    it('opens a file that is not viewed and closes a viewed file by default', () => {
        expect(files.map(file => isFileOpen({}, file))).toEqual([true, false]);
    });

    it('uses the choice of the user first', () => {
        expect(files.map(file => isFileOpen({ 'a.ts': false, 'b.ts': true }, file))).toEqual([false, true]);
    });

    it('sets the same state for all files', () => {
        expect(allFilesOpen(files, false)).toEqual({ 'a.ts': false, 'b.ts': false });
    });
});

describe('search match index', () => {
    it('keeps the index in the list', () => {
        expect(currentMatchIndex(7, 3)).toBe(2);
        expect(currentMatchIndex(1, 3)).toBe(1);
    });

    it('wraps at the two ends of the list', () => {
        expect(nextMatchIndex(2, 3, 1)).toBe(0);
        expect(nextMatchIndex(0, 3, -1)).toBe(2);
        expect(nextMatchIndex(9, 3, -1)).toBe(1);
    });

    it('shows the position, or tells that there are no results', () => {
        expect(findCountText('', 0, 0)).toBe('');
        expect(findCountText('foo', 0, 0)).toBe('No results');
        expect(findCountText('foo', 5, 1)).toBe('2 of 5');
    });
});

describe('composer modes', () => {
    it('shows only the modes that are available, in a fixed order', () => {
        expect(composerModes(true, true, true)).toEqual(['comment', 'ask', 'note']);
        expect(composerModes(false, true, false)).toEqual(['ask']);
        expect(composerModes(true, false, true)).toEqual(['comment', 'note']);
    });

    it('gives each mode its placeholder and its button text', () => {
        expect(composerPlaceholder('comment', 'line 3')).toBe('Comment on line 3');
        expect(composerPlaceholder('ask', 'lines 3–5')).toBe('Ask the agent about lines 3–5');
        expect(composerPlaceholder('note', 'line 3')).toBe('Tell the agent what to do with line 3');
        expect(['comment', 'ask', 'note'].map(mode => composerSubmitLabel(mode as 'comment'))).toEqual(['Add review comment', 'Ask agent', 'Send to agent']);
    });
});
