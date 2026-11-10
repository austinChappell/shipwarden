/**
 * Keeps the scroll position of a ghostty-web terminal when new output arrives.
 *
 * ghostty-web 0.4 scrolls to the bottom on each write. An agent writes output many times each second (for example
 * its spinner), so the user cannot scroll up while the agent runs. Other terminals (Ghostty, Terminal.app, xterm.js)
 * keep the scroll position and scroll to the bottom only when the user types.
 *
 * ghostty-web has no option for this, so this module uses its internal fields, as render-loop.ts does. When these
 * fields are missing (for example in a new ghostty-web version), the write is a normal write and the terminal scrolls
 * to the bottom as before.
 */

/** The internal fields of a ghostty-web 0.4 Terminal that this module uses. */
interface ScrollInternals {
    viewportY?: number;
    targetViewportY?: number;
    scrollToBottom?: () => void;
    getScrollbackLength?: () => number;
    write(data: string): void;
}

function internals(terminal: object): ScrollInternals {
    return terminal as ScrollInternals;
}

/** Returns true when the terminal has the internal fields that writeKeepingScroll needs. */
export function canKeepScroll(terminal: object): boolean {
    const t = internals(terminal);
    return typeof t.viewportY === 'number' && typeof t.scrollToBottom === 'function' && typeof t.getScrollbackLength === 'function';
}

/**
 * Writes the data to the terminal.
 * When the user scrolled up, the same lines stay in the view: new lines that go into the scrollback move the
 * view up by the same number of lines. When the view is at the bottom, it stays at the bottom.
 */
export function writeKeepingScroll(terminal: object, data: string): void {
    const t = internals(terminal);
    if (!canKeepScroll(terminal) || !(t.viewportY! > 0)) {
        t.write(data);
        return;
    }
    const before = t.getScrollbackLength!();
    const viewport = t.viewportY!;
    const target = t.targetViewportY;
    // The write calls scrollToBottom on the instance. An own property hides the method of the class for this write.
    const hadOwn = Object.hasOwn(t, 'scrollToBottom');
    const own = t.scrollToBottom;
    t.scrollToBottom = () => {};
    try {
        t.write(data);
    } finally {
        if (hadOwn) {
            t.scrollToBottom = own;
        } else {
            delete t.scrollToBottom;
        }
    }
    const after = t.getScrollbackLength!();
    // A full scrollback drops its oldest lines, so its length does not grow. Then the view moves with the output.
    const added = Math.max(0, after - before);
    t.viewportY = Math.min(after, viewport + added);
    // A smooth scroll that runs now moves to its target. Move the target by the same number of lines.
    // A target of 0 is a scroll to the bottom, so it stays 0.
    if (typeof target === 'number' && target > 0) {
        t.targetViewportY = Math.min(after, target + added);
    }
}
