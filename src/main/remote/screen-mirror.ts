import { Terminal, type IBufferCell } from '@xterm/headless';
import type { ScreenRun, ScreenSnapshot } from '@shared/remote';

/** The phone gets at most this number of scrollback lines above the visible screen. */
export const MIRROR_SCROLLBACK_LINES = 150;

function colorOf(cell: IBufferCell, which: 'fg' | 'bg'): number | string | undefined {
    if (which === 'fg' ? cell.isFgDefault() : cell.isBgDefault()) return undefined;
    const value = which === 'fg' ? cell.getFgColor() : cell.getBgColor();
    if (which === 'fg' ? cell.isFgRGB() : cell.isBgRGB()) {
        return `#${value.toString(16).padStart(6, '0')}`;
    }
    return value;
}

function styleOf(cell: IBufferCell): Omit<ScreenRun, 't'> {
    const style: Omit<ScreenRun, 't'> = {};
    const fg = colorOf(cell, 'fg');
    const bg = colorOf(cell, 'bg');
    if (fg !== undefined) style.fg = fg;
    if (bg !== undefined) style.bg = bg;
    if (cell.isBold()) style.b = 1;
    if (cell.isDim()) style.d = 1;
    if (cell.isItalic()) style.i = 1;
    if (cell.isUnderline()) style.u = 1;
    if (cell.isInverse()) style.v = 1;
    return style;
}

const sameStyle = (a: Omit<ScreenRun, 't'>, b: Omit<ScreenRun, 't'>) =>
    a.fg === b.fg && a.bg === b.bg && a.b === b.b && a.d === b.d && a.i === b.i && a.u === b.u && a.v === b.v;

/**
 * Keeps a copy of a terminal screen for the phone. It gets the same output as the terminal on the Mac, and runs it
 * through a headless terminal emulator (xterm.js). The phone then gets text with styles, not escape codes.
 */
export class ScreenMirror {
    private readonly terminal: Terminal;
    private cursorVisible = true;
    /** The sequence number of the last chunk that the mirror got. */
    private seq = 0;

    constructor(cols: number, rows: number) {
        this.terminal = new Terminal({ cols: Math.max(cols, 2), rows: Math.max(rows, 1), scrollback: 1000, allowProposedApi: true });
        // The public API has no cursor visibility. DECTCEM (CSI ? 25 h/l) sets it.
        const track = (visible: boolean) => (params: (number | number[])[]) => {
            if (params.includes(25)) this.cursorVisible = visible;
            return false;
        };
        this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(true));
        this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(false));
    }

    get cols(): number {
        return this.terminal.cols;
    }

    get rows(): number {
        return this.terminal.rows;
    }

    /** True when the program in the terminal accepts a bracketed paste. */
    get bracketedPaste(): boolean {
        return this.terminal.modes.bracketedPasteMode;
    }

    /** True when the arrow keys must send the application form (ESC O A). */
    get applicationCursorKeys(): boolean {
        return this.terminal.modes.applicationCursorKeysMode;
    }

    /** Adds output. A chunk with a sequence number that is not larger than the last one is a duplicate. Returns a promise for the parse. */
    write(data: string, seq?: number): Promise<void> {
        if (seq !== undefined) {
            if (seq <= this.seq) return Promise.resolve();
            this.seq = seq;
        }
        if (!data) return Promise.resolve();
        return new Promise(resolve => this.terminal.write(data, resolve));
    }

    resize(cols: number, rows: number): void {
        if (cols > 1 && rows > 0 && (cols !== this.terminal.cols || rows !== this.terminal.rows)) {
            this.terminal.resize(cols, rows);
        }
    }

    snapshot(scrollbackLines = MIRROR_SCROLLBACK_LINES): ScreenSnapshot {
        const buffer = this.terminal.buffer.active;
        const rows = this.terminal.rows;
        const end = buffer.baseY + rows;
        const start = Math.max(0, buffer.baseY - scrollbackLines);
        const cell = buffer.getNullCell();
        const lines: ScreenRun[][] = [];
        for (let y = start; y < end; y++) {
            const line = buffer.getLine(y);
            const runs: ScreenRun[] = [];
            if (line) {
                // Leave out the empty cells with the default style at the end of the line.
                let last = line.length - 1;
                for (; last >= 0; last--) {
                    const item = line.getCell(last, cell);
                    if (!item || item.getChars() !== '' || !item.isBgDefault() || item.isInverse()) break;
                }
                for (let x = 0; x <= last; x++) {
                    const item = line.getCell(x, cell);
                    // The second cell of a wide character has width 0 and no text.
                    if (!item || item.getWidth() === 0) continue;
                    const text = item.getChars() || ' ';
                    const style = styleOf(item);
                    const previous = runs[runs.length - 1];
                    if (previous && sameStyle(previous, style)) {
                        previous.t += text;
                    } else {
                        runs.push({ t: text, ...style });
                    }
                }
            }
            lines.push(runs);
        }
        return {
            cols: this.terminal.cols,
            rows,
            lines,
            cursor: { x: buffer.cursorX, y: buffer.cursorY, visible: this.cursorVisible }
        };
    }

    dispose(): void {
        this.terminal.dispose();
    }
}
