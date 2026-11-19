import type { Position, Rows } from './line-select';

/** A match of the search in the terminal. `end` is the last cell of the match. */
export interface TerminalMatch {
    start: Position;
    end: Position;
}

/**
 * Returns the matches of `query` in the rows, from the top of the scrollback to the bottom of the screen.
 * A match can continue on the next row when the line wraps there. Two matches do not overlap.
 * Without `caseSensitive`, "A" and "a" match.
 */
export function findInRows(rows: Rows, query: string, caseSensitive: boolean): TerminalMatch[] {
    if (!query) {
        return [];
    }
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: TerminalMatch[] = [];
    let row = 0;
    while (row < rows.count) {
        // One line: the row and the rows that continue it.
        let text = '';
        // The cell of each UTF-16 unit of the text.
        const cells: Position[] = [];
        do {
            const line = rows.cells(row) ?? [];
            for (let col = 0; col < line.length; col++) {
                const cell = line[col];
                // The cell to the right of a wide character has no text.
                if (cell.width === 0 && col > 0 && line[col - 1]?.width === 2) {
                    continue;
                }
                let part = cell.codepoint === 0 ? ' ' : cell.grapheme_len > 0 ? rows.grapheme(row, col) : String.fromCodePoint(cell.codepoint);
                if (!caseSensitive) {
                    // A few characters change their length in lower case. Keep these as they are, so that each unit keeps its cell.
                    const lower = part.toLowerCase();
                    if (lower.length === part.length) {
                        part = lower;
                    }
                }
                text += part;
                for (let unit = 0; unit < part.length; unit++) {
                    cells.push({ col, absoluteRow: row });
                }
            }
            row++;
        } while (row < rows.count && rows.continues(row));

        let index = text.indexOf(needle);
        while (index >= 0) {
            matches.push({ start: cells[index], end: cells[index + needle.length - 1] });
            index = text.indexOf(needle, index + needle.length);
        }
    }
    return matches;
}

/** Returns the index of the last match that starts at or before `position`, or -1 when no match does. */
export function matchAtOrBefore(matches: TerminalMatch[], position: Position): number {
    for (let index = matches.length - 1; index >= 0; index--) {
        const { start } = matches[index];
        if (start.absoluteRow < position.absoluteRow || (start.absoluteRow === position.absoluteRow && start.col <= position.col)) {
            return index;
        }
    }
    return -1;
}
