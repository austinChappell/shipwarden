import { FitAddon, Terminal } from 'ghostty-web';
import { findKeybind } from '@shared/keybinds';
import { CTRL_V, isClearKey, isCtrlV, isImageOnlyPaste } from '@shared/shortcuts';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { loadGhostty, prepareFonts } from './ghostty';
import { pauseRendering, resumeRendering } from './render-loop';

/** Clears the screen and the scrollback (⌘K). */
const CLEAR_ALL = '\x1b[H\x1b[2J\x1b[3J';

interface Entry {
    session: TerminalSession;
    terminal: Terminal;
    fit: FitAddon;
    /** The element that holds the terminal canvas. The pool moves it between containers. */
    host: HTMLDivElement;
    /** The sequence number of the last chunk that the terminal shows. It is -1 until the replay arrives. */
    shownSeq: number;
    /** Live chunks that arrive before the replay. */
    pending: [string, number][];
    /** The event handlers of this session. */
    bindings: { dispose(): void }[];
}

/**
 * Keeps one Ghostty terminal for each session, for the full life of the session.
 * A view attaches the terminal to its container and detaches it when the user selects a different tab.
 */
export class TerminalPool {
    private readonly entries = new Map<string, Entry>();
    private readonly creating = new Map<string, Promise<Entry>>();
    private readonly api = window.shipwarden.terminals;
    /**
     * Stops the draw loop of a terminal that is not visible, and starts it again when the terminal is visible.
     * A terminal is not visible when its tab is not selected (its host is not in the document), or when its pane is
     * hidden or has no size. The terminal continues to receive output while its loop is stopped.
     */
    private readonly visibility = new IntersectionObserver(records => {
        for (const record of records) {
            const terminal = this.hosts.get(record.target);
            if (!terminal) {
                continue;
            }
            if (record.isIntersecting && record.target.isConnected) {
                resumeRendering(terminal);
            } else {
                pauseRendering(terminal);
            }
        }
    });
    /** The terminal of each host element, for the visibility observer. */
    private readonly hosts = new WeakMap<Element, Terminal>();

    constructor() {
        this.api.onData((id, data, seq) => {
            const entry = this.entries.get(id);
            if (!entry) {
                return;
            }
            if (entry.shownSeq < 0) {
                entry.pending.push([data, seq]);
            } else if (seq > entry.shownSeq) {
                entry.shownSeq = seq;
                this.write(entry, data);
            }
        });
    }

    /** The open terminals, by session ID. Automated UI checks read this map. */
    get terminals(): ReadonlyMap<string, Terminal> {
        return new Map([...this.entries].map(([id, entry]) => [id, entry.terminal]));
    }

    /**
     * Returns the text that the terminal shows now: all rows of the screen, not the scrollback.
     * Returns undefined when the pool has no terminal for the session.
     */
    screenText(sessionId: string): string | undefined {
        const terminal = this.entries.get(sessionId)?.terminal;
        const buffer = terminal?.buffer.active;
        if (!terminal || !buffer) {
            return undefined;
        }
        const lines: string[] = [];
        for (let index = Math.max(0, buffer.length - terminal.rows); index < buffer.length; index++) {
            lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
        }
        return lines.join('\n');
    }

    /**
     * Shows the terminal of the session in the container. Creates the terminal if necessary.
     * `focus` is false for a pane of a split view without the focus, so it does not take the keyboard from the focused pane.
     */
    async attach(session: TerminalSession, settings: TerminalSettings, container: HTMLElement, focus = true): Promise<void> {
        let entry = this.entries.get(session.id);
        if (!entry) {
            let promise = this.creating.get(session.id);
            if (!promise) {
                promise = this.create(session, settings, container);
                this.creating.set(session.id, promise);
            }
            entry = await promise;
            this.creating.delete(session.id);
        }
        if (entry.host.parentElement !== container) {
            container.appendChild(entry.host);
        }
        this.fit(session.id);
        if (focus) {
            entry.terminal.focus();
        }
    }

    /** Gives the keyboard focus to the terminal of a session, when its view shows it. */
    focus(sessionId: string): void {
        this.entries.get(sessionId)?.terminal.focus();
    }

    /** Removes the terminal of the session from its container. The terminal continues to receive output. */
    detach(sessionId: string, container: HTMLElement): void {
        const entry = this.entries.get(sessionId);
        if (entry && entry.host.parentElement === container) {
            container.removeChild(entry.host);
        }
    }

    /**
     * Closes all terminal views, so that the next attach makes new views with new colors.
     * ghostty-web 0.4 keeps the default colors in its WASM engine from open(), so a live color change is not complete.
     * The sessions continue to run in the PTY host. A new view gets their recent output again from the replay.
     */
    resetAll(): void {
        for (const sessionId of [...this.entries.keys()]) {
            this.dispose(sessionId);
        }
    }

    /** Fits the terminal to its container. The function does nothing when the terminal is not visible. */
    fit(sessionId: string): void {
        const entry = this.entries.get(sessionId);
        if (entry && entry.host.isConnected && entry.host.clientWidth > 0 && entry.host.clientHeight > 0) {
            entry.fit.fit();
        }
    }

    /**
     * Removes and destroys the terminal of a session. Its Ghostty instance and its WASM memory go away with it.
     * A change of the colors also uses this, because a new terminal is necessary for new colors.
     */
    dispose(sessionId: string): void {
        const entry = this.entries.get(sessionId);
        if (!entry) {
            return;
        }
        this.entries.delete(sessionId);
        this.visibility.unobserve(entry.host);
        entry.bindings.forEach(binding => binding.dispose());
        entry.host.remove();
        entry.terminal.dispose();
    }

    private async create(session: TerminalSession, settings: TerminalSettings, container: HTMLElement): Promise<Entry> {
        // Each terminal has its own Ghostty instance, so it cannot show the memory of another terminal.
        const [ghostty] = await Promise.all([loadGhostty(), prepareFonts(settings)]);

        const host = document.createElement('div');
        host.className = 'terminal-host';
        // The terminal measures its size when it opens, so the host must be in the document.
        container.appendChild(host);
        const terminal = new Terminal({
            ghostty,
            fontFamily: settings.fontFamily,
            fontSize: settings.fontSize,
            cursorStyle: settings.cursorStyle,
            cursorBlink: settings.cursorBlink,
            theme: settings.colors,
            scrollback: 10000
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        fit.fit();

        const entry: Entry = { session, terminal, fit, host, shownSeq: -1, pending: [], bindings: [] };
        this.entries.set(session.id, entry);
        this.hosts.set(host, terminal);
        this.visibility.observe(host);

        // ⌘K clears the screen and the scrollback, as in Ghostty and Terminal.app.
        // Keybinds from the Ghostty config that send text, for example shift+enter.
        terminal.attachCustomKeyEventHandler(event => {
            if (event.type !== 'keydown') {
                return false;
            }
            if (isClearKey(event)) {
                event.preventDefault();
                entry.terminal.write(CLEAR_ALL);
                // Form feed (Ctrl+L) tells the shell or the agent to draw its prompt again.
                this.api.write(session.id, '\x0c');
                return true;
            }
            // ghostty-web 0.4 sends nothing for Ctrl+V. Claude Code and Codex read an image from the clipboard on Ctrl+V.
            if (isCtrlV(event)) {
                event.preventDefault();
                this.api.write(session.id, CTRL_V);
                return true;
            }
            const keybind = findKeybind(settings.keybinds, event);
            if (keybind) {
                event.preventDefault();
                this.api.write(session.id, keybind.text);
                return true;
            }
            return false;
        });
        // ghostty-web 0.4 pastes only text. For a ⌘V with only an image, send Ctrl+V, so that the agent reads the image
        // from the clipboard. The capture phase runs before the paste handlers of ghostty-web.
        const onPaste = (event: ClipboardEvent) => {
            const data = event.clipboardData;
            if (data && isImageOnlyPaste([...data.types], data.getData('text/plain'))) {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.api.write(session.id, CTRL_V);
            }
        };
        host.addEventListener('paste', onPaste, { capture: true });
        entry.bindings.push(
            { dispose: () => host.removeEventListener('paste', onPaste, { capture: true }) },
            terminal.onData(data => this.api.write(session.id, data)),
            terminal.onResize(({ cols, rows }) => this.api.resize(session.id, cols, rows))
        );

        // Show the recent output, then the live chunks that arrived after it.
        const replay = await this.api.replay(session.id);
        this.write(entry, replay.data);
        entry.shownSeq = replay.seq;
        for (const [data, seq] of entry.pending) {
            if (seq > entry.shownSeq) {
                entry.shownSeq = seq;
                this.write(entry, data);
            }
        }
        entry.pending = [];
        this.api.resize(session.id, terminal.cols, terminal.rows);
        return entry;
    }

    /** ghostty-web 0.4 throws "offset is out of bounds" for an empty write. */
    private write(entry: Entry, data: string): void {
        if (data.length > 0) {
            entry.terminal.write(data);
        }
    }
}

export const terminalPool = new TerminalPool();
(window as unknown as { __shipwardenTerminals: TerminalPool }).__shipwardenTerminals = terminalPool;
