import { describe, expect, it, vi } from 'vitest';
import { canKeepScroll, writeKeepingScroll } from './scroll-lock';

/**
 * A stand-in for a ghostty-web 0.4 Terminal. Each write adds `linesPerWrite` lines to the scrollback and calls
 * scrollToBottom, as the real write does.
 */
class FakeTerminal {
    viewportY = 0;
    targetViewportY = 0;
    scrollback = 100;
    linesPerWrite = 3;
    bottomCalls = 0;
    getScrollbackLength() {
        return this.scrollback;
    }
    scrollToBottom() {
        this.bottomCalls++;
        this.viewportY = 0;
    }
    write(_data: string) {
        this.scrollback += this.linesPerWrite;
        if (this.viewportY !== 0) this.scrollToBottom();
    }
}

describe('scroll lock', () => {
    it('keeps the same lines in view when the user scrolled up', () => {
        const terminal = new FakeTerminal();
        terminal.viewportY = 10;
        terminal.targetViewportY = 10;
        writeKeepingScroll(terminal, 'output');
        expect(terminal.viewportY).toBe(13);
        expect(terminal.targetViewportY).toBe(13);
        expect(terminal.bottomCalls).toBe(0);
    });

    it('restores the method of the class after the write', () => {
        const terminal = new FakeTerminal();
        terminal.viewportY = 10;
        writeKeepingScroll(terminal, 'output');
        expect(Object.prototype.hasOwnProperty.call(terminal, 'scrollToBottom')).toBe(false);
        terminal.scrollToBottom();
        expect(terminal.viewportY).toBe(0);
    });

    it('stays at the bottom when the view is at the bottom', () => {
        const terminal = new FakeTerminal();
        writeKeepingScroll(terminal, 'output');
        expect(terminal.viewportY).toBe(0);
    });

    it('does not move a smooth scroll to the bottom away from the bottom', () => {
        const terminal = new FakeTerminal();
        terminal.viewportY = 4;
        terminal.targetViewportY = 0;
        writeKeepingScroll(terminal, 'output');
        expect(terminal.targetViewportY).toBe(0);
    });

    it('keeps the view inside a scrollback that got shorter', () => {
        const terminal = new FakeTerminal();
        terminal.viewportY = 50;
        terminal.write = function (this: FakeTerminal) {
            this.scrollback = 20;
            if (this.viewportY !== 0) this.scrollToBottom();
        };
        writeKeepingScroll(terminal, '\x1b[3J');
        expect(terminal.viewportY).toBe(20);
    });

    it('writes normally when the internal fields are missing', () => {
        const write = vi.fn();
        const terminal = { write };
        expect(canKeepScroll(terminal)).toBe(false);
        writeKeepingScroll(terminal, 'output');
        expect(write).toHaveBeenCalledWith('output');
    });
});
