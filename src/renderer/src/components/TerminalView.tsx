import { useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { terminalPool } from '../terminal/terminal-pool';
import { errorText } from '../util';
import { confirmDialog } from './ConfirmDialog';

interface Props {
    session: TerminalSession;
    settings: TerminalSettings;
    /** False for a pane of a split view without the focus. Such a terminal does not take the keyboard. */
    focused?: boolean;
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
            <button className="button" onClick={() => void stopOutdatedHosts().catch(reason => setError(errorText(reason)))}>
                Stop old sessions…
            </button>
        </div>
    );
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

    const outdated = !!session.hostOutdated && !session.exited;
    return (
        <>
            {outdated && <OutdatedHostNotice />}
            <div className={`terminal${outdated ? ' below-notice' : ''}`} ref={containerRef} style={{ background: settings.colors.background }} />
        </>
    );
}
