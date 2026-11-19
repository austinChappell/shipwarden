import type { Terminal } from 'ghostty-web';

/** A cell of a row, as the WASM terminal of ghostty-web 0.4 gives it. */
export interface Cell {
    codepoint: number;
    grapheme_len: number;
    /** 2 for a wide character, 0 for the cell to the right of a wide character. */
    width?: number;
}

/** A position in the buffer. Rows 0 to (scrollback length - 1) are the scrollback. The screen rows follow. */
export interface Position {
    col: number;
    absoluteRow: number;
}

/** The rows of a terminal, by absolute row. */
export interface Rows {
    /** The number of columns. */
    cols: number;
    /** The number of rows: the scrollback and the screen. */
    count: number;
    /** Returns the cells of a row, or null when the row does not exist. */
    cells(row: number): Cell[] | null;
    /** Returns the text of a cell with more than one code point. */
    grapheme(row: number, col: number): string;
    /** Returns true when the row continues the row above it (a soft wrap, without a newline). */
    continues(row: number): boolean;
}

/** Returns the first and the last row of the line that contains the row. A line can wrap on more than one row. */
export function lineRange(rows: Rows, row: number): { first: number; last: number } {
    let first = row;
    while (first > 0 && rows.continues(first)) {
        first--;
    }
    let last = row;
    while (last + 1 < rows.count && rows.continues(last + 1)) {
        last++;
    }
    return { first, last };
}

/**
 * Returns the text from `start` to `end`. Both cells are in the text.
 * A newline separates two rows. A soft-wrapped row and the row that continues it have no newline between them.
 * The text of a row that ends a line has no spaces at its end.
 */
export function selectionText(rows: Rows, start: Position, end: Position): string {
    if (start.absoluteRow > end.absoluteRow || (start.absoluteRow === end.absoluteRow && start.col > end.col)) {
        [start, end] = [end, start];
    }
    let text = '';
    for (let row = start.absoluteRow; row <= end.absoluteRow; row++) {
        const cells = rows.cells(row);
        if (!cells) {
            continue;
        }
        const from = row === start.absoluteRow ? start.col : 0;
        const to = row === end.absoluteRow ? end.col : cells.length - 1;
        let part = '';
        for (let col = from; col <= to; col++) {
            const cell = cells[col];
            if (!cell || cell.codepoint === 0) {
                part += ' ';
            } else {
                part += cell.grapheme_len > 0 ? rows.grapheme(row, col) : String.fromCodePoint(cell.codepoint);
            }
        }
        const wraps = row < end.absoluteRow && rows.continues(row + 1);
        // A soft-wrapped row can end with a space of the text. Keep it.
        text += wraps ? part : part.trimEnd();
        if (row < end.absoluteRow && !wraps) {
            text += '\n';
        }
    }
    return text;
}

/** The WASM terminal of ghostty-web 0.4. Its type is not public. */
interface WasmTerminal {
    getScrollbackLength(): number;
    getScrollbackLine(row: number): Cell[] | null;
    getScrollbackGraphemeString(row: number, col: number): string;
    getLine(row: number): Cell[] | null;
    getGraphemeString(row: number, col: number): string;
    getDimensions(): { cols: number; rows: number };
    isRowWrapped(row: number): boolean;
}

/** The private part of the ghostty-web 0.4 selection manager that this module uses. */
interface SelectionManager {
    wasmTerm: WasmTerminal;
    selectionStart: Position | null;
    selectionEnd: Position | null;
    getSelection(): string;
    pixelToCell(x: number, y: number): { col: number; row: number };
    viewportRowToAbsolute(row: number): number;
    markCurrentSelectionDirty(): void;
    requestRender(): void;
    copyToClipboard(text: string): Promise<void>;
    selectionChangedEmitter: { fire(): void };
}

/** Returns the selection manager of the terminal, or undefined when ghostty-web does not have the expected form. */
function selectionManager(terminal: Terminal): SelectionManager | undefined {
    const manager = (terminal as unknown as { selectionManager?: SelectionManager }).selectionManager;
    return manager?.wasmTerm ? manager : undefined;
}

/** Returns the rows of the terminal: the scrollback and the screen. Returns undefined when the rows are not available. */
export function terminalRows(terminal: Terminal): Rows | undefined {
    const manager = selectionManager(terminal);
    return manager ? wasmRows(manager.wasmTerm) : undefined;
}

/** Returns the number of rows in the scrollback. */
export function scrollbackLength(terminal: Terminal): number {
    return selectionManager(terminal)?.wasmTerm.getScrollbackLength() ?? 0;
}

/**
 * Selects the cells from `start` to `end`. Both cells are in the selection. The terminal does not copy the text.
 * ghostty-web 0.4 has select(), but it uses a wrong row when the terminal shows the scrollback.
 */
export function selectCells(terminal: Terminal, start: Position, end: Position): void {
    const manager = selectionManager(terminal);
    if (!manager) {
        return;
    }
    // Mark the rows of the old and of the new selection, so that the terminal draws both again.
    manager.markCurrentSelectionDirty();
    manager.selectionStart = start;
    manager.selectionEnd = end;
    manager.markCurrentSelectionDirty();
    manager.requestRender();
    manager.selectionChangedEmitter.fire();
}

/** Returns true for a box-drawing character, for example the "─" of a border. */
function isBoxDrawing(codepoint: number): boolean {
    return codepoint >= 0x2500 && codepoint <= 0x257f;
}

/** Gives the rows of the WASM terminal. */
function wasmRows(wasm: WasmTerminal): Rows {
    const scrollback = wasm.getScrollbackLength();
    const { cols, rows } = wasm.getDimensions();
    const cells = (row: number) => (row < scrollback ? wasm.getScrollbackLine(row) : wasm.getLine(row - scrollback));
    return {
        cols,
        count: scrollback + rows,
        cells,
        grapheme: (row, col) => (row < scrollback ? wasm.getScrollbackGraphemeString(row, col) : wasm.getGraphemeString(row - scrollback, col)),
        continues: row => {
            if (row >= scrollback) {
                return wasm.isRowWrapped(row - scrollback);
            }
            // ghostty-web 0.4 does not give the wrap flag of a scrollback row. Use the row above: a soft wrap fills its
            // last cell. A border also fills the last cell, so a box-drawing character there does not count as a wrap.
            const last = row > 0 ? cells(row - 1)?.[cols - 1] : undefined;
            return !!last && last.codepoint !== 0 && !isBoxDrawing(last.codepoint);
        }
    };
}

/**
 * Adds the line selection to the terminal:
 *
 * - A triple click selects the full line under the pointer and copies it. A line can wrap on more than one row.
 * - A copy does not put a newline between a soft-wrapped row and the row that continues it.
 *
 * ghostty-web 0.4 selects a word on a double click, but it has no triple click.
 */
export function addLineSelection(terminal: Terminal): void {
    const manager = selectionManager(terminal);
    const canvas = terminal.element?.querySelector('canvas');
    if (!manager || !canvas) {
        console.warn('[terminal] The selection manager of ghostty-web is not available. A triple click does not select a line.');
        return;
    }
    manager.getSelection = () => {
        if (!manager.selectionStart || !manager.selectionEnd) {
            return '';
        }
        return selectionText(wasmRows(manager.wasmTerm), manager.selectionStart, manager.selectionEnd);
    };
    canvas.addEventListener('click', event => {
        if (event.button !== 0 || event.detail !== 3) {
            return;
        }
        const cell = manager.pixelToCell(event.offsetX, event.offsetY);
        const rows = wasmRows(manager.wasmTerm);
        const { first, last } = lineRange(rows, manager.viewportRowToAbsolute(cell.row));
        manager.markCurrentSelectionDirty();
        manager.selectionStart = { col: 0, absoluteRow: first };
        manager.selectionEnd = { col: rows.cols - 1, absoluteRow: last };
        const text = manager.getSelection();
        if (text) {
            void manager.copyToClipboard(text);
        }
        manager.selectionChangedEmitter.fire();
    });
}
