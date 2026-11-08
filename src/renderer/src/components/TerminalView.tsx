import { useEffect, useRef } from 'react';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { terminalPool } from '../terminal/terminal-pool';

interface Props {
    session: TerminalSession;
    settings: TerminalSettings;
    /** False for a pane of a split view without the focus. Such a terminal does not take the keyboard. */
    focused?: boolean;
}

/**
 * Shows one terminal session with the Ghostty engine.
 * The terminal belongs to the terminal pool. This view only attaches it and fits it to the available space.
 */
export function TerminalView({ session, settings, focused = true }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);

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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session.id, settings]);

    // A pane that gets the focus gives the keyboard to its terminal.
    useEffect(() => {
        if (focused) {
            terminalPool.focus(session.id);
        }
    }, [focused, session.id]);

    return <div className="terminal" ref={containerRef} style={{ background: settings.colors.background }} />;
}
