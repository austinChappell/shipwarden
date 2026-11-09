import { useEffect, useState } from 'react';
import { ArrowUpCircle, ExternalLink, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { UpdateState } from '@shared/updates';
import { errorText, timeAgo } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { Markdown } from './Markdown';
import { openLink } from '../links';

const DISMISS_KEY = 'shipwarden.updateDismissed';

/** The state of the updater. It follows the changes from the main process. */
export function useUpdateState(): UpdateState | undefined {
    const [state, setState] = useState<UpdateState>();
    useEffect(() => {
        let current = true;
        window.shipwarden.updates.state().then(value => current && setState(value), () => undefined);
        const off = window.shipwarden.updates.onState(setState);
        return () => {
            current = false;
            off();
        };
    }, []);
    return state;
}

/** Asks first, then installs. The app restarts, and the terminals and agents continue to run. */
async function installUpdate(state: UpdateState): Promise<void> {
    const ok = await confirmDialog({
        title: `Update to ShipWarden ${state.update?.version} and restart?`,
        message: 'ShipWarden downloads the update, checks it and restarts. Your terminals and agents continue to run. Save your open files first.',
        confirmLabel: 'Update and restart'
    });
    if (ok) await window.shipwarden.updates.install();
}

/** The release notes of an update, in a dialog. */
function NotesDialog({ state, onClose }: { state: UpdateState; onClose(): void }) {
    const update = state.update!;
    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
            <div className="modal update-notes" role="dialog" aria-label="Release notes" onKeyDown={event => event.key === 'Escape' && onClose()}>
                <header className="modal-header">
                    <ArrowUpCircle size={16} strokeWidth={1.8} />
                    <h2>ShipWarden {update.version}</h2>
                    <span className="update-notes-date">{timeAgo(update.publishedAt)}</span>
                    <span className="header-spacer" />
                    <button className="icon-button" title="Close" onClick={onClose}><X size={15} strokeWidth={1.8} /></button>
                </header>
                <div className="modal-body">
                    <Markdown text={update.notes || 'This release has no notes.'} className="update-notes-body" />
                </div>
                <footer className="modal-footer">
                    <button className="link-button" onClick={event => openLink(update.url, event)}>
                        Open on GitHub <ExternalLink size={12} />
                    </button>
                    <span className="header-spacer" />
                    <button className="button" onClick={onClose}>Close</button>
                    {state.canInstall && (
                        <button className="button primary" onClick={() => { onClose(); void installUpdate(state).catch(() => undefined); }}>
                            Update and restart
                        </button>
                    )}
                </footer>
            </div>
        </div>
    );
}

function readDismissed(): string | undefined {
    try {
        return localStorage.getItem(DISMISS_KEY) ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * The notice in the corner of the window when a new release is ready: the version, the release notes, and
 * "Update and restart". "Later" hides the notice until the next version. The notice also shows the download
 * progress and an error of the install.
 */
export function UpdateNotice() {
    const state = useUpdateState();
    const [dismissed, setDismissed] = useState(readDismissed);
    const [notes, setNotes] = useState(false);

    if (!state?.update) return null;
    const busy = state.status === 'downloading' || state.status === 'installing';
    const failed = state.status === 'error' && !!state.error;
    if (!busy && !failed && (state.status !== 'available' || dismissed === state.update.version)) {
        return notes ? <NotesDialog state={state} onClose={() => setNotes(false)} /> : null;
    }

    const later = () => {
        setDismissed(state.update!.version);
        try {
            localStorage.setItem(DISMISS_KEY, state.update!.version);
        } catch {
            // The notice shows again after a restart.
        }
    };

    return (
        <>
            <div className="update-notice" role="status">
                <ArrowUpCircle size={18} strokeWidth={1.8} className="update-notice-icon" />
                <div className="update-notice-text">
                    <strong>ShipWarden {state.update.version} is available</strong>
                    {state.status === 'downloading' && (
                        <span className="update-progress">
                            <span style={{ width: `${Math.round((state.progress ?? 0) * 100)}%` }} />
                        </span>
                    )}
                    <span className="update-notice-detail">
                        {state.status === 'downloading' && `Downloading… ${Math.round((state.progress ?? 0) * 100)}%`}
                        {state.status === 'installing' && 'Checking the update. ShipWarden restarts soon.'}
                        {failed && state.error}
                        {state.status === 'available' && `You have ${state.current}.${state.canInstall ? '' : ' Only the installed app can update itself.'}`}
                    </span>
                </div>
                {!busy && (
                    <div className="update-notice-buttons">
                        <button className="link-button" onClick={() => setNotes(true)}>Release notes</button>
                        {state.canInstall && state.status === 'available' && (
                            <button className="button primary" onClick={() => void installUpdate(state).catch(() => undefined)}>Update and restart</button>
                        )}
                        {failed && (
                            <button className="button" onClick={() => void window.shipwarden.updates.check()}>Try again</button>
                        )}
                        <button className="icon-button" title="Later. The notice shows again for the next version." onClick={later}>
                            <X size={14} strokeWidth={1.8} />
                        </button>
                    </div>
                )}
                {busy && <LoaderCircle size={15} className="spin" />}
            </div>
            {notes && <NotesDialog state={state} onClose={() => setNotes(false)} />}
        </>
    );
}

/** The update rows of Settings › About: the status, "Check for updates", the release notes and the install. */
export function UpdateSettings() {
    const state = useUpdateState();
    const [notes, setNotes] = useState(false);
    const [error, setError] = useState<string>();
    if (!state) return null;

    const check = async () => {
        setError(undefined);
        try {
            await window.shipwarden.updates.check();
        } catch (err) {
            setError(errorText(err));
        }
    };

    let text = 'ShipWarden looks for updates when it starts and every 4 hours.';
    if (state.status === 'checking') text = 'Looking for updates…';
    else if (state.status === 'none') text = `ShipWarden ${state.current} is the newest version.`;
    else if (state.status === 'available') text = `ShipWarden ${state.update?.version} is available.`;
    else if (state.status === 'downloading') text = `Downloading ShipWarden ${state.update?.version}… ${Math.round((state.progress ?? 0) * 100)}%`;
    else if (state.status === 'installing') text = 'Installing. ShipWarden restarts soon.';
    else if (state.status === 'error') text = state.error ?? 'The update check failed.';
    if (!state.canInstall) text += ' ShipWarden runs from the source code, so it can check but not install.';

    return (
        <div className="update-settings">
            <span className={`update-settings-text${state.status === 'error' ? ' error' : ''}`}>
                {text}
                {state.checkedAt && state.status !== 'checking' && <span className="panel-note"> Checked {timeAgo(new Date(state.checkedAt).toISOString())}.</span>}
            </span>
            <div className="update-settings-buttons">
                {state.update && <button className="link-button" onClick={() => setNotes(true)}>Release notes</button>}
                {state.update && state.canInstall && state.status === 'available' && (
                    <button className="button primary" onClick={() => void installUpdate(state).catch(err => setError(errorText(err)))}>Update and restart</button>
                )}
                <button className="button" disabled={state.status === 'checking' || state.status === 'downloading' || state.status === 'installing'} onClick={() => void check()}>
                    <RefreshCw size={13} strokeWidth={1.8} className={state.status === 'checking' ? 'spin' : ''} /> Check for updates
                </button>
            </div>
            {error && <div className="form-error">{error}</div>}
            {notes && state.update && <NotesDialog state={state} onClose={() => setNotes(false)} />}
        </div>
    );
}
