import { describe, expect, it } from 'vitest';
import type { Rows } from './line-select';
import { findInRows, matchAtOrBefore } from './terminal-find';

/** Makes rows from text. Each item is one row. A row that starts with "+" continues the row above it. "W" is a wide character. */
function makeRows(cols: number, lines: string[]): Rows {
    const rows = lines.map(line => {
        const text = line.startsWith('+') ? line.slice(1) : line;
        const cells = [...text.padEnd(cols, '\0')].flatMap(char =>
            char === 'W'
                ? [
                      { codepoint: 0x4e16, grapheme_len: 0, width: 2 },
                      { codepoint: 0, grapheme_len: 0, width: 0 }
                  ]
                : [{ codepoint: char.codePointAt(0) ?? 0, grapheme_len: 0, width: 1 }]
        );
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

const at = (absoluteRow: number, col: number) => ({ absoluteRow, col });

describe('findInRows', () => {
    it('finds all matches from the top to the bottom', () => {
        const rows = makeRows(8, ['error a', 'ok', 'error b']);
        expect(findInRows(rows, 'error', false)).toEqual([
            { start: at(0, 0), end: at(0, 4) },
            { start: at(2, 0), end: at(2, 4) }
        ]);
    });

    it('ignores the case unless the search matches the case', () => {
        const rows = makeRows(8, ['Error', 'error']);
        expect(findInRows(rows, 'ERROR', false)).toHaveLength(2);
        expect(findInRows(rows, 'Error', true)).toEqual([{ start: at(0, 0), end: at(0, 4) }]);
    });

    it('finds a match that continues on a wrapped row', () => {
        const rows = makeRows(5, ['abcde', '+fghij']);
        expect(findInRows(rows, 'def', false)).toEqual([{ start: at(0, 3), end: at(1, 0) }]);
    });

    it('does not find a match across two lines', () => {
        const rows = makeRows(5, ['abcde', 'fghij']);
        expect(findInRows(rows, 'ef', false)).toEqual([]);
    });

    it('gives the correct cells after a wide character', () => {
        const rows = makeRows(8, ['Wab']);
        expect(findInRows(rows, 'ab', false)).toEqual([{ start: at(0, 2), end: at(0, 3) }]);
    });

    it('does not give overlapping matches', () => {
        expect(findInRows(makeRows(8, ['aaaa']), 'aa', false)).toHaveLength(2);
    });

    it('gives no matches for an empty search', () => {
        expect(findInRows(makeRows(8, ['abc']), '', false)).toEqual([]);
    });
});

describe('matchAtOrBefore', () => {
    const matches = findInRows(makeRows(8, ['x x', 'x']), 'x', false);

    it('gives the last match that starts at or before the position', () => {
        expect(matchAtOrBefore(matches, at(0, 2))).toBe(1);
        expect(matchAtOrBefore(matches, at(0, 1))).toBe(0);
        expect(matchAtOrBefore(matches, at(5, 0))).toBe(2);
    });

    it('gives -1 when no match is before the position', () => {
        expect(matchAtOrBefore(matches.slice(1), at(0, 0))).toBe(-1);
    });
});
