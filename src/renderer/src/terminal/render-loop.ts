/**
 * Stops and starts the draw loop of a ghostty-web terminal.
 *
 * ghostty-web 0.4 draws each open terminal on each animation frame, also when its canvas is not in the document.
 * With many tabs, the hidden terminals use most of the main thread. ghostty-web has no public API to stop the loop, so
 * this module uses its internal fields. When these fields are missing (for example in a new ghostty-web version), the
 * functions do nothing and the terminal draws as before.
 *
 * The WASM engine continues to receive all output while the loop is stopped. Only the canvas is not drawn.
 *
 * A stopped terminal also releases its canvas. A canvas has the full size of the pane at the device pixel ratio
 * (for example 1536 x 3120 pixels), and Chromium keeps GPU buffers for it. Each open terminal added about 88 MB to
 * the GPU process, also when it was hidden. A canvas with the size 0 x 0 has no buffers. The next draw finds the wrong
 * size and makes the canvas full size again.
 */

/** The internal fields of a ghostty-web 0.4 Terminal that this module uses. */
interface RenderLoopInternals {
    isOpen?: boolean;
    isDisposed?: boolean;
    animationFrameId?: number;
    startRenderLoop?: () => void;
    renderer?: {
        canvas?: { width: number; height: number };
        render(buffer: unknown, forceAll?: boolean, viewportY?: number, scrollbackProvider?: unknown, scrollbarOpacity?: number): void;
    };
    wasmTerm?: unknown;
    viewportY?: number;
    scrollbarOpacity?: number;
}

const paused = new WeakSet<object>();

function internals(terminal: object): RenderLoopInternals {
    return terminal as RenderLoopInternals;
}

/** Returns true when the terminal has the internal fields that pause and resume need. */
export function canPauseRendering(terminal: object): boolean {
    const t = internals(terminal);
    return typeof t.startRenderLoop === 'function' && typeof t.renderer?.render === 'function' && 'isOpen' in t;
}

/** Returns true when the draw loop of the terminal is stopped. */
export function isRenderingPaused(terminal: object): boolean {
    return paused.has(terminal);
}

/**
 * Stops the draw loop of the terminal.
 * Returns true when the loop stopped. Returns false when it was already stopped or the terminal is not supported.
 */
export function pauseRendering(terminal: object, cancel: (id: number) => void = id => cancelAnimationFrame(id)): boolean {
    const t = internals(terminal);
    if (paused.has(terminal) || !canPauseRendering(terminal) || t.isDisposed || !t.isOpen) {
        return false;
    }
    if (t.animationFrameId !== undefined) {
        cancel(t.animationFrameId);
        t.animationFrameId = undefined;
    }
    // Release the pixels and the GPU buffers of the canvas. resumeRendering makes it full size again.
    const canvas = t.renderer?.canvas;
    if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
    }
    paused.add(terminal);
    return true;
}

/**
 * Draws the full terminal one time and starts its draw loop again.
 * Returns true when the loop started. Returns false when the loop was not stopped by pauseRendering.
 */
export function resumeRendering(terminal: object): boolean {
    if (!paused.delete(terminal)) {
        return false;
    }
    const t = internals(terminal);
    if (t.isDisposed || !t.isOpen || !t.renderer || !t.startRenderLoop) {
        return false;
    }
    // The screen changed while the loop was stopped. Draw all rows, not only the rows that the engine marks as changed.
    // The canvas is 0 x 0, so this draw also makes the canvas full size again.
    t.renderer.render(t.wasmTerm, true, t.viewportY ?? 0, terminal, t.scrollbarOpacity ?? 0);
    t.startRenderLoop.call(terminal);
    return true;
}
