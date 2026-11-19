import { describe, expect, it } from 'vitest';
import { lineRange, selectionText, type Rows } from './line-select';

/** Makes rows from text. Each item is one row. A row that starts with "+" continues the row above it. */
function makeRows(cols: number, lines: string[]): Rows {
    const rows = lines.map(line => {
        const text = line.startsWith('+') ? line.slice(1) : line;
        const cells = [...text.padEnd(cols, '\0')].map(char => ({ codepoint: char.codePointAt(0) ?? 0, grapheme_len: 0 }));
        return { cells, continues: line.startsWith('+') };
    });
    return {
        cols,
        count: rows.length,
        cells: row => rows[row]?.cells ?? null,
        grapheme: () => '',
        continues: row => rows[row]?.continues ?? false
    };
}

const rows = makeRows(5, ['one', 'abcde', '+fghij', '+kl', 'two', '+x']);

describe('lineRange', () => {
    it('gives one row for a line without a wrap', () => {
        expect(lineRange(rows, 0)).toEqual({ first: 0, last: 0 });
    });

    it('gives all rows of a wrapped line from any of its rows', () => {
        expect(lineRange(rows, 1)).toEqual({ first: 1, last: 3 });
        expect(lineRange(rows, 2)).toEqual({ first: 1, last: 3 });
        expect(lineRange(rows, 3)).toEqual({ first: 1, last: 3 });
    });

    it('stops at the last row', () => {
        expect(lineRange(rows, 5)).toEqual({ first: 4, last: 5 });
    });
});

describe('selectionText', () => {
    it('joins the rows of a wrapped line without a newline', () => {
        expect(selectionText(rows, { col: 0, absoluteRow: 1 }, { col: 4, absoluteRow: 3 })).toBe('abcdefghijkl');
    });

    it('puts a newline between two lines', () => {
        expect(selectionText(rows, { col: 0, absoluteRow: 0 }, { col: 4, absoluteRow: 2 })).toBe('one\nabcdefghij');
    });

    it('accepts a selection from the end to the start', () => {
        expect(selectionText(rows, { col: 1, absoluteRow: 2 }, { col: 1, absoluteRow: 1 })).toBe('bcdefg');
    });

    it('keeps a space at the end of a soft-wrapped row', () => {
        const spaced = makeRows(5, ['ab cd', '+e']);
        expect(selectionText(spaced, { col: 0, absoluteRow: 0 }, { col: 4, absoluteRow: 1 })).toBe('ab cde');
        const wrapAtSpace = makeRows(3, ['ab ', '+cd']);
        expect(selectionText(wrapAtSpace, { col: 0, absoluteRow: 0 }, { col: 2, absoluteRow: 1 })).toBe('ab cd');
    });

    it('removes the spaces at the end of a line', () => {
        expect(selectionText(rows, { col: 0, absoluteRow: 0 }, { col: 4, absoluteRow: 0 })).toBe('one');
    });
});
