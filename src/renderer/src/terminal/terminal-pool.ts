import { FitAddon, Terminal } from 'ghostty-web';
import { findKeybind } from '@shared/keybinds';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { prepareTerminal } from './ghostty';

/**
 * Clears the screen and the scrollback.
 * ghostty-web 0.4 can reuse the WASM memory of a closed terminal without clearing it.
 * Without this sequence, text from the closed terminal can show in the new terminal.
 */
const CLEAR_ALL = '\x1b[H\x1b[2J\x1b[3J';

/**
 * A full reset (RIS) and a clear, for a spare terminal that a new session uses: the modes, the colors, the title,
 * the screen and the scrollback of the old session go away.
 */
const RESET_ALL = `\x1bc${CLEAR_ALL}`;

/** The pool keeps at most this number of spare terminals. Each spare keeps its WASM memory. */
const MAX_SPARES = 4;

/**
 * A terminal of a closed session, for a new session. ghostty-web 0.4 does not clear the WASM memory of a freed
 * terminal, and a new terminal in that memory can show text and wrong characters of the old one. A spare is never
 * freed, so its memory stays its own.
 */
interface Spare {
    terminal: Terminal;
    fit: FitAddon;
    host: HTMLDivElement;
    /** The settings of the terminal. A spare is used only with the same settings, because the WASM engine keeps them. */
    settingsKey: string;
}

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
    /** The event handlers of this session. They go away when the terminal becomes a spare. */
    bindings: { dispose(): void }[];
    settingsKey: string;
}

/**
 * Keeps one Ghostty terminal for each session, for the full life of the session.
 * A view attaches the terminal to its container and detaches it when the user selects a different tab.
 */
export class TerminalPool {
    private readonly entries = new Map<string, Entry>();
    private readonly creating = new Map<string, Promise<Entry>>();
    private readonly spares: Spare[] = [];
    private readonly api = window.shipwarden.terminals;

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
            this.free(sessionId);
        }
        for (const spare of this.spares.splice(0)) {
            spare.host.remove();
            spare.terminal.dispose();
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
     * Removes the terminal of a closed session. The terminal becomes a spare for the next session when the pool has
     * space for it, because a freed terminal can leave text in the WASM memory that a new terminal shows.
     */
    dispose(sessionId: string): void {
        const entry = this.entries.get(sessionId);
        if (!entry) {
            return;
        }
        this.entries.delete(sessionId);
        entry.bindings.forEach(binding => binding.dispose());
        entry.terminal.attachCustomKeyEventHandler(() => false);
        entry.host.remove();
        if (this.spares.length < MAX_SPARES) {
            this.spares.push({ terminal: entry.terminal, fit: entry.fit, host: entry.host, settingsKey: entry.settingsKey });
        } else {
            entry.terminal.dispose();
        }
    }

    /** Destroys the terminal of a session, without a spare. A change of the colors needs new terminals. */
    private free(sessionId: string): void {
        const entry = this.entries.get(sessionId);
        if (entry) {
            entry.bindings.forEach(binding => binding.dispose());
            entry.host.remove();
            entry.terminal.dispose();
            this.entries.delete(sessionId);
        }
    }

    private async create(session: TerminalSession, settings: TerminalSettings, container: HTMLElement): Promise<Entry> {
        await prepareTerminal(settings);

        const settingsKey = JSON.stringify(settings);
        const spareIndex = this.spares.findIndex(item => item.settingsKey === settingsKey);
        let terminal: Terminal;
        let fit: FitAddon;
        let host: HTMLDivElement;
        if (spareIndex >= 0) {
            // A spare terminal: reset it, so nothing of its old session shows.
            ({ terminal, fit, host } = this.spares.splice(spareIndex, 1)[0]);
            container.appendChild(host);
            terminal.write(RESET_ALL);
            fit.fit();
        } else {
            host = document.createElement('div');
            host.className = 'terminal-host';
            // The terminal measures its size when it opens, so the host must be in the document.
            container.appendChild(host);
            terminal = new Terminal({
                fontFamily: settings.fontFamily,
                fontSize: settings.fontSize,
                cursorStyle: settings.cursorStyle,
                cursorBlink: settings.cursorBlink,
                theme: settings.colors,
                scrollback: 10000
            });
            fit = new FitAddon();
            terminal.loadAddon(fit);
            terminal.open(host);
            terminal.write(CLEAR_ALL);
            fit.fit();
        }

        const entry: Entry = { session, terminal, fit, host, shownSeq: -1, pending: [], bindings: [], settingsKey };
        this.entries.set(session.id, entry);

        // Keybinds from the Ghostty config that send text, for example shift+enter.
        terminal.attachCustomKeyEventHandler(event => {
            if (event.type !== 'keydown') {
                return false;
            }
            const keybind = findKeybind(settings.keybinds, event);
            if (keybind) {
                event.preventDefault();
                this.api.write(session.id, keybind.text);
                return true;
            }
            return false;
        });
        entry.bindings.push(
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
