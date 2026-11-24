import { useCallback, useEffect, useRef, useState } from 'react';
import { History, MessagesSquare } from 'lucide-react';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import type { Position } from '../terminal/line-select';
import { matchAtOrBefore } from '../terminal/terminal-find';
import { terminalPool } from '../terminal/terminal-pool';
import { errorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { FindBar } from './FindBar';
import { isFindKey } from './log-find';
import { Button } from './ui';
import { PromptPicker } from '../prompts/PromptPicker';
import { DictationBar, DictationButton } from '../dictation/Dictation';

interface Props {
    session: TerminalSession;
    settings: TerminalSettings;
    /** False for a pane of a split view without the focus. Such a terminal does not take the keyboard. */
    focused?: boolean;
    /** Shows the chat of the agent tab. Only an agent tab with a transcript has it. */
    onShowChat?: () => void;
}

/** Asks first, then stops the PTY hosts of older builds and all their sessions. */
async function stopOutdatedHosts(): Promise<void> {
    const sessions = await window.shipwarden.terminals.list();
    const count = sessions.filter(session => session.hostOutdated && !session.exited).length;
    const ok = await confirmDialog({
        title: `Stop ${count} old ${count === 1 ? 'session' : 'sessions'}?`,
        message:
            'These terminals run on a terminal host from an older ShipWarden build. Their processes stop now, also agents and servers. New tabs use the current build.',
        confirmLabel: 'Stop sessions',
        danger: true
    });
    if (ok) {
        await window.shipwarden.terminals.stopOutdatedHosts();
    }
}

/**
 * The bar above a terminal that runs on a PTY host of an older build. Such a terminal does not get the features of
 * the current build, for example the hooks of an agent that the user starts in a shell tab.
 */
function OutdatedHostNotice() {
    const [error, setError] = useState<string>();
    return (
        <div className="host-notice" role="status">
            <History size={14} strokeWidth={1.8} className="host-notice-icon" />
            <span className="host-notice-text" title={error}>
                {error ?? 'This tab runs on a terminal host from an older ShipWarden build. Some features do not work in it. New tabs use the current build.'}
            </span>
            <Button size="sm" onClick={() => void stopOutdatedHosts().catch(reason => setError(errorText(reason)))}>
                Stop old sessions…
            </Button>
        </div>
    );
}

/** The state of the search bar of a terminal. */
interface FindState {
    open: boolean;
    query: string;
    caseSensitive: boolean;
    count: number;
    index: number;
    focusNonce: number;
}

const CLOSED: FindState = { open: false, query: '', caseSensitive: false, count: 0, index: 0, focusNonce: 0 };

/**
 * The search of a terminal (⌘F). It finds the text in the scrollback and on the screen, selects the current match,
 * and scrolls to it. The output of the terminal changes, so each step finds the matches again.
 */
function useTerminalFind(sessionId: string) {
    const [find, setFind] = useState<FindState>(CLOSED);
    // The start of the current match. The next step starts from it.
    const current = useRef<Position | undefined>(undefined);

    /** Finds the matches and selects one. A step of 0 keeps the current match, or goes to the match above it. */
    const search = useCallback(
        (query: string, caseSensitive: boolean, step: -1 | 0 | 1) => {
            const matches = terminalPool.find(sessionId, query, caseSensitive);
            if (matches.length === 0) {
                current.current = undefined;
                terminalPool.clearSelection(sessionId);
                setFind(state => ({ ...state, query, caseSensitive, count: 0, index: 0 }));
                return;
            }
            const position = current.current;
            const before = position ? matchAtOrBefore(matches, position) : -1;
            const exact = before >= 0 && matches[before].start.absoluteRow === position?.absoluteRow && matches[before].start.col === position.col;
            let index: number;
            if (step === 1) {
                index = before + 1;
            } else if (step === -1 || !exact) {
                // Without a current match, the search starts at the newest text, at the bottom.
                index = step === -1 && exact ? before - 1 : before;
            } else {
                index = before;
            }
            index = index < 0 ? matches.length - 1 : index >= matches.length ? 0 : index;
            current.current = matches[index].start;
            terminalPool.showMatch(sessionId, matches[index]);
            setFind(state => ({ ...state, query, caseSensitive, count: matches.length, index }));
        },
        [sessionId]
    );

    /** Opens the bar, or selects its text when it is open. A selection of one line becomes the new search. */
    const open = useCallback(() => {
        const selected = terminalPool.selection(sessionId);
        const query = selected && !selected.includes('\n') ? selected : undefined;
        setFind(state => ({ ...state, open: true, focusNonce: state.focusNonce + 1 }));
        if (query !== undefined) {
            search(query, find.caseSensitive, 0);
        } else if (!find.open && find.query) {
            search(find.query, find.caseSensitive, 0);
        }
    }, [sessionId, search, find.open, find.query, find.caseSensitive]);

    /** Closes the bar, removes the selection, and gives the keyboard back to the terminal. */
    const close = useCallback(() => {
        current.current = undefined;
        terminalPool.clearSelection(sessionId);
        setFind(state => ({ ...state, open: false }));
        terminalPool.focus(sessionId);
    }, [sessionId]);

    return { find, open, close, search };
}

/**
 * Shows one terminal session with the Ghostty engine.
 * The terminal belongs to the terminal pool. This view only attaches it and fits it to the available space.
 */
export function TerminalView({ session, settings, focused = true, onShowChat }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { find, open: openFind, close: closeFind, search } = useTerminalFind(session.id);

    // ⌘F opens the search bar. The capture phase gets the key before the terminal sends it to its program.
    const onKeyDownCapture = (event: React.KeyboardEvent) => {
        if (isFindKey(event.nativeEvent)) {
            event.preventDefault();
            event.stopPropagation();
            openFind();
        }
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: The session object changes on each update. Only a new session ID or new settings attach the terminal again. Another effect sends the focus.
    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        // No detach when the attach finishes late. React (StrictMode in development) can mount the view again at once
        // with the same container, and a late detach would remove the terminal from it, so the view shows nothing.
        // A terminal in a container that is not shown any more moves at its next attach.
        void terminalPool.attach(session, settings, container, focused);
        const observer = new ResizeObserver(() => terminalPool.fit(session.id));
        observer.observe(container);
        return () => {
            observer.disconnect();
            terminalPool.detach(session.id, container);
        };
    }, [session.id, settings]);

    // A pane that gets the focus gives the keyboard to its terminal.
    useEffect(() => {
        if (focused) {
            terminalPool.focus(session.id);
        }
    }, [focused, session.id]);

    const outdated = !!session.hostOutdated && !session.exited;
    return (
        <>
            {outdated && <OutdatedHostNotice />}
            <div
                className={`terminal${outdated ? ' below-notice' : ''}`}
                ref={containerRef}
                style={{ background: settings.colors.background }}
                data-own-find=""
                data-dictation-session={session.isAgent && !session.exited ? session.id : undefined}
                onKeyDownCapture={onKeyDownCapture}
            />
            {find.open && (
                // ghostty-web removes the selection of the terminal on a click outside the terminal. Stop the clicks of the bar.
                <div
                    className={`floating-find${outdated ? ' below-notice' : ''}`}
                    data-own-find=""
                    onClick={event => event.stopPropagation()}
                    onKeyDownCapture={onKeyDownCapture}
                >
                    <FindBar
                        label="Find in the terminal"
                        reverse
                        query={find.query}
                        caseSensitive={find.caseSensitive}
                        count={find.count}
                        index={find.index}
                        focusNonce={find.focusNonce}
                        onQuery={value => search(value, find.caseSensitive, 0)}
                        onCaseSensitive={value => search(find.query, value, 0)}
                        onMove={step => search(find.query, find.caseSensitive, step)}
                        onClose={closeFind}
                    />
                </div>
            )}
            {session.isAgent && !session.exited && <DictationBar sessionId={session.id} floating />}
            {((session.isAgent && !session.exited) || onShowChat) && (
                <div className="terminal-tools">
                    {session.isAgent && !session.exited && (
                        <>
                            <DictationButton sessionId={session.id} variant="outline" />
                            <PromptPicker sessionId={session.id} />
                        </>
                    )}
                    {onShowChat && (
                        <Button className="terminal-chat-toggle" size="sm" icon={<MessagesSquare size={13} strokeWidth={1.8} />} onClick={onShowChat}>
                            Chat
                        </Button>
                    )}
                </div>
            )}
        </>
    );
}
