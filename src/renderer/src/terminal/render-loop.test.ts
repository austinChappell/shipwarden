import { describe, expect, it, vi } from 'vitest';
import { canPauseRendering, isRenderingPaused, pauseRendering, resumeRendering } from './render-loop';

/** A stand-in for a ghostty-web 0.4 Terminal with the internal fields of its draw loop. */
function fakeTerminal(overrides: Record<string, unknown> = {}) {
    const terminal = {
        isOpen: true,
        isDisposed: false,
        animationFrameId: 7 as number | undefined,
        viewportY: 3,
        scrollbarOpacity: 0.5,
        wasmTerm: { id: 'wasm' },
        renderer: { render: vi.fn() },
        startRenderLoop: vi.fn(function (this: { animationFrameId?: number }) {
            this.animationFrameId = 8;
        }),
        ...overrides
    };
    return terminal;
}

describe('render loop', () => {
    it('stops the loop and cancels the next frame', () => {
        const terminal = fakeTerminal();
        const cancel = vi.fn();
        expect(pauseRendering(terminal, cancel)).toBe(true);
        expect(cancel).toHaveBeenCalledWith(7);
        expect(terminal.animationFrameId).toBeUndefined();
        expect(isRenderingPaused(terminal)).toBe(true);
    });

    it('does not stop the loop two times', () => {
        const terminal = fakeTerminal();
        const cancel = vi.fn();
        pauseRendering(terminal, cancel);
        expect(pauseRendering(terminal, cancel)).toBe(false);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('draws all rows one time and starts the loop again', () => {
        const terminal = fakeTerminal();
        pauseRendering(terminal, vi.fn());
        expect(resumeRendering(terminal)).toBe(true);
        expect(terminal.renderer.render).toHaveBeenCalledWith(terminal.wasmTerm, true, 3, terminal, 0.5);
        expect(terminal.startRenderLoop).toHaveBeenCalledTimes(1);
        expect(terminal.animationFrameId).toBe(8);
        expect(isRenderingPaused(terminal)).toBe(false);
    });

    it('does not start a loop that pauseRendering did not stop', () => {
        const terminal = fakeTerminal();
        expect(resumeRendering(terminal)).toBe(false);
        expect(terminal.startRenderLoop).not.toHaveBeenCalled();
        expect(terminal.renderer.render).not.toHaveBeenCalled();
    });

    it('does not start the loop of a terminal that was disposed while paused', () => {
        const terminal = fakeTerminal();
        pauseRendering(terminal, vi.fn());
        terminal.isDisposed = true;
        expect(resumeRendering(terminal)).toBe(false);
        expect(terminal.startRenderLoop).not.toHaveBeenCalled();
    });

    it('does not stop a terminal that is closed or disposed', () => {
        expect(pauseRendering(fakeTerminal({ isOpen: false }), vi.fn())).toBe(false);
        expect(pauseRendering(fakeTerminal({ isDisposed: true }), vi.fn())).toBe(false);
    });

    it('does nothing when the internal fields are missing', () => {
        const terminal = fakeTerminal({ startRenderLoop: undefined });
        const cancel = vi.fn();
        expect(canPauseRendering(terminal)).toBe(false);
        expect(pauseRendering(terminal, cancel)).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
        expect(terminal.animationFrameId).toBe(7);
    });
});
