import { FitAddon, Terminal, type ILink, type ILinkProvider } from 'ghostty-web';
import { findKeybind } from '@shared/keybinds';
import { CTRL_V, isClearKey, isCtrlV, isImageOnlyPaste } from '@shared/shortcuts';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { loadGhostty, prepareFonts } from './ghostty';
import { pauseRendering, resumeRendering } from './render-loop';
import { writeKeepingScroll } from './scroll-lock';
import { openLink } from '../links';

/** Clears the screen and the scrollback (⌘K). */
const CLEAR_ALL = '\x1b[H\x1b[2J\x1b[3J';

/**
 * The time in milliseconds from the last fit request to the second fit.
 * After a resize, FitAddon in ghostty-web 0.4 ignores fit() for 50 ms. This value must be larger.
 */
const TRAILING_FIT_MS = 80;

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
    /** The timer of the second fit. See fit(). */
    fitTimer?: ReturnType<typeof setTimeout>;
    /** The last size that the pool sent to the PTY. It is undefined until the terminal is visible one time. */
    ptySize?: { cols: number; rows: number };
}

/** A terminal that the pool makes now. */
interface Creation {
    /** Gives the new entry, or undefined when the pool disposed the terminal before it was ready. */
    promise: Promise<Entry | undefined>;
    /** True when the pool disposed the terminal before it was ready. */
    cancelled: boolean;
}

/**
 * Keeps one Ghostty terminal for each session, for the full life of the session.
 * A view attaches the terminal to its container and detaches it when the user selects a different tab.
 */
export class TerminalPool {
    private readonly entries = new Map<string, Entry>();
    private readonly creating = new Map<string, Creation>();
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
            const creation = this.creating.get(session.id) ?? this.startCreate(session, settings, container);
            entry = await creation.promise;
        }
        // The pool can dispose the terminal before it is ready, for example when the colors change. Do not show a
        // disposed terminal, because its canvas does not change again. The new view of the session makes a new terminal.
        if (!entry || this.entries.get(session.id) !== entry) {
            return;
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
        // Also stop the terminals that are not ready. Their colors are old.
        for (const sessionId of new Set([...this.entries.keys(), ...this.creating.keys()])) {
            this.dispose(sessionId);
        }
    }

    /**
     * Fits the terminal to its container. The function does nothing when the terminal is not visible.
     *
     * After a resize, FitAddon in ghostty-web 0.4 ignores fit() for 50 ms. During a drag of a split divider, the last
     * fit request often comes in that time, and the terminal keeps the size of an earlier step of the drag. Thus the
     * function fits again when no request came for TRAILING_FIT_MS.
     */
    fit(sessionId: string): void {
        const entry = this.entries.get(sessionId);
        if (!entry) {
            return;
        }
        this.fitNow(entry);
        clearTimeout(entry.fitTimer);
        entry.fitTimer = setTimeout(() => {
            entry.fitTimer = undefined;
            // The session can close, or the colors can change and make a new terminal, before the timer runs.
            if (this.entries.get(sessionId) === entry) {
                this.fitNow(entry);
            }
        }, TRAILING_FIT_MS);
    }

    /**
     * Fits the terminal and sends its size to the PTY. The function does nothing when the terminal is not visible.
     *
     * FitAddon does nothing when the terminal already has the correct size. But the PTY can have a different size,
     * for example when a resize did not get to the PTY. Thus the function also compares the size of the PTY.
     */
    private fitNow(entry: Entry): void {
        if (isVisible(entry)) {
            entry.fit.fit();
            this.sendSize(entry);
        }
    }

    /**
     * Sends the size of the terminal to the PTY when the PTY does not have this size.
     * The function does nothing when the terminal is not visible, because then its size is not correct.
     */
    private sendSize(entry: Entry): void {
        if (!isVisible(entry)) {
            return;
        }
        const { cols, rows } = entry.terminal;
        if (entry.ptySize?.cols !== cols || entry.ptySize?.rows !== rows) {
            entry.ptySize = { cols, rows };
            this.api.resize(entry.session.id, cols, rows);
        }
    }

    /**
     * Removes and destroys the terminal of a session. Its Ghostty instance and its WASM memory go away with it.
     * A change of the colors also uses this, because a new terminal is necessary for new colors.
     */
    dispose(sessionId: string): void {
        // A terminal that is not ready stops at its next step. The next attach makes a new terminal.
        const creation = this.creating.get(sessionId);
        if (creation) {
            creation.cancelled = true;
            this.creating.delete(sessionId);
        }
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

    /** Starts to make the terminal of a session. Each attach of the session uses this creation until it is ready. */
    private startCreate(session: TerminalSession, settings: TerminalSettings, container: HTMLElement): Creation {
        const creation: Creation = { promise: Promise.resolve(undefined), cancelled: false };
        creation.promise = this.create(session, settings, container, creation).finally(() => {
            if (this.creating.get(session.id) === creation) {
                this.creating.delete(session.id);
            }
        });
        this.creating.set(session.id, creation);
        return creation;
    }

    /** Makes the terminal of a session. Gives undefined when dispose() cancels the creation. */
    private async create(session: TerminalSession, settings: TerminalSettings, container: HTMLElement, creation: Creation): Promise<Entry | undefined> {
        // Each terminal has its own Ghostty instance, so it cannot show the memory of another terminal.
        const [ghostty] = await Promise.all([loadGhostty(), prepareFonts(settings)]);
        if (creation.cancelled) {
            return undefined;
        }

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
        routeLinkClicks(terminal);
        stopClickCopy(terminal);

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
            terminal.onData(data => {
                // Input from the user goes to the bottom, as in other terminals. Output keeps the scroll position.
                terminal.scrollToBottom();
                this.api.write(session.id, data);
            }),
            terminal.onResize(() => this.sendSize(entry))
        );

        // Show the recent output, then the live chunks that arrived after it.
        const replay = await this.api.replay(session.id);
        // dispose() already destroyed the terminal. Do not write to it.
        if (creation.cancelled) {
            return undefined;
        }
        this.write(entry, replay.data);
        entry.shownSeq = replay.seq;
        for (const [data, seq] of entry.pending) {
            if (seq > entry.shownSeq) {
                entry.shownSeq = seq;
                this.write(entry, data);
            }
        }
        entry.pending = [];
        // A terminal that opens in a container without a size keeps the default size of ghostty-web (80 x 24).
        // fitNow sends the size only when the terminal is visible. The first visible fit sends the correct size.
        this.fitNow(entry);
        return entry;
    }

    /** ghostty-web 0.4 throws "offset is out of bounds" for an empty write. */
    private write(entry: Entry, data: string): void {
        if (data.length > 0) {
            writeKeepingScroll(entry.terminal, data);
        }
    }
}

/** The private part of the ghostty-web 0.4 selection manager that stopClickCopy changes. */
interface SelectionManager {
    hasSelection(): boolean;
    copyToClipboard(text: string): Promise<void>;
}

/**
 * Stops the copy that a single click causes.
 * In ghostty-web 0.4, a click without a drag selects one cell. On mouseup, the terminal copies the character in that
 * cell, for example the "-" or "─" of a border. This copy replaces the clipboard, and an image in the clipboard is
 * then not available to paste. After this change, the terminal copies only a selection of two or more cells.
 */
function stopClickCopy(terminal: Terminal): void {
    const manager = (terminal as unknown as { selectionManager?: SelectionManager }).selectionManager;
    if (!manager) {
        return;
    }
    const copy = manager.copyToClipboard.bind(manager);
    manager.copyToClipboard = async text => {
        if (manager.hasSelection()) {
            await copy(text);
        }
    };
}

/** Returns true when the host of the terminal is in the document and has a size. */
function isVisible(entry: Entry): boolean {
    return entry.host.isConnected && entry.host.clientWidth > 0 && entry.host.clientHeight > 0;
}

/**
 * Sends the link clicks of a terminal to `openLink`: ⌘-click opens the default browser, ⇧⌘-click the in-app browser.
 * ghostty-web 0.4 calls window.open for a link and does not give the modifier keys to it. The link detector of the
 * terminal is not public, so this function wraps its providers. When the detector has a different form (for example
 * in a newer ghostty-web), the terminal keeps its own behavior: ⌘-click opens the default browser.
 */
function routeLinkClicks(terminal: Terminal): void {
    const detector = (terminal as unknown as { linkDetector?: { providers?: unknown } }).linkDetector;
    if (!detector || !Array.isArray(detector.providers)) {
        console.warn('[terminal] The link detector of ghostty-web is not available. Links use the default behavior.');
        return;
    }
    detector.providers = (detector.providers as ILinkProvider[]).map(
        (provider): ILinkProvider => ({
            provideLinks: (row, callback) =>
                provider.provideLinks(row, links =>
                    callback(
                        links?.map(
                            (link): ILink => ({
                                ...link,
                                activate: event => {
                                    openLink(link.text, event, { needsModifier: true });
                                }
                            })
                        )
                    )
                ),
            dispose: () => provider.dispose?.()
        })
    );
}

export const terminalPool = new TerminalPool();
(window as unknown as { __shipwardenTerminals: TerminalPool }).__shipwardenTerminals = terminalPool;
