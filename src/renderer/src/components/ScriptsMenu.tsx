import { useEffect, useRef, useState } from 'react';
import { Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import type { RepoScript } from '@shared/settings';
import { errorText } from '../util';
import { confirmDialog } from './ConfirmDialog';

interface Props {
    /** The display name of the repository, for the titles. */
    repoName: string;
    scripts: RepoScript[];
    onRun(script: RepoScript): void;
    /** Saves the full list of scripts of the repository. */
    onSave(scripts: RepoScript[]): Promise<void>;
}

/** The dialog that adds a script or changes one. */
function ScriptDialog({ repoName, script, onClose, onSubmit }: {
    repoName: string;
    script?: RepoScript;
    onClose(): void;
    onSubmit(name: string, command: string): Promise<void>;
}) {
    const [name, setName] = useState(script?.name ?? '');
    const [command, setCommand] = useState(script?.command ?? '');
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        if (!name.trim() || !command.trim()) {
            setError('A script needs a name and a command.');
            return;
        }
        setBusy(true);
        try {
            await onSubmit(name.trim(), command.replace(/\s+$/, ''));
        } catch (err) {
            setError(errorText(err));
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
            <div className="modal" role="dialog" aria-label={script ? 'Edit script' : 'Add script'} onKeyDown={event => event.key === 'Escape' && onClose()}>
                <header className="modal-header">
                    <Play size={15} strokeWidth={1.8} />
                    <h2>{script ? `Edit "${script.name}"` : `New script for ${repoName}`}</h2>
                    <span className="header-spacer" />
                    <button className="icon-button" title="Close" onClick={onClose}><X size={15} strokeWidth={1.8} /></button>
                </header>
                <div className="modal-body">
                    <label className="run-field">
                        <span className="setting-label">Name</span>
                        <input className="settings-input" autoFocus value={name} placeholder="Test" spellCheck={false} onChange={event => setName(event.target.value)} />
                    </label>
                    <label className="run-field">
                        <span className="setting-label">Command</span>
                        <textarea
                            className="settings-input mono script-field"
                            rows={Math.max(4, Math.min(12, command.split('\n').length + 1))}
                            value={command}
                            placeholder={'npm test\n# More lines are fine.'}
                            spellCheck={false}
                            onChange={event => setCommand(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                    event.preventDefault();
                                    void submit();
                                }
                            }}
                        />
                        <span className="panel-note">
                            The script runs in a new terminal tab of the selected worktree, in your login shell. It gets SHIPWARDEN_ROOT_PATH,
                            SHIPWARDEN_WORKTREE_PATH, SHIPWARDEN_BRANCH and SHIPWARDEN_REPO_NAME.
                        </span>
                    </label>
                    {error && <div className="form-error">{error}</div>}
                </div>
                <footer className="modal-footer">
                    <span className="panel-note">⌘↩ saves.</span>
                    <button className="button" onClick={onClose}>Cancel</button>
                    <button className="button primary" disabled={busy} onClick={() => void submit()}>{script ? 'Save' : 'Add script'}</button>
                </footer>
            </div>
        </div>
    );
}

/**
 * The ▷ button of the workspace header. Its menu runs a saved script of the repository in a new terminal tab,
 * and adds, changes or removes scripts.
 */
export function ScriptsMenu({ repoName, scripts, onRun, onSave }: Props) {
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<RepoScript | 'new'>();
    const [error, setError] = useState<string>();
    const root = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onPointer = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('pointerdown', onPointer);
        window.addEventListener('keydown', onKey);
        root.current?.querySelector<HTMLButtonElement>('.new-tab-item')?.focus();
        return () => {
            window.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    /** Moves the focus between the scripts with the arrow keys. */
    const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.new-tab-item') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    };

    const save = async (list: RepoScript[]) => {
        setError(undefined);
        try {
            await onSave(list);
        } catch (err) {
            setError(errorText(err));
            throw err;
        }
    };
    const remove = async (script: RepoScript) => {
        if (await confirmDialog({ title: `Delete the script "${script.name}"?`, confirmLabel: 'Delete', danger: true })) {
            void save(scripts.filter(item => item.id !== script.id)).catch(() => undefined);
        }
    };
    const submit = async (name: string, command: string) => {
        const list = editing && editing !== 'new'
            ? scripts.map(item => (item.id === editing.id ? { ...item, name, command } : item))
            : [...scripts, { id: crypto.randomUUID(), name, command }];
        await save(list);
        setEditing(undefined);
    };

    return (
        <div className="new-tab scripts-menu" ref={root}>
            <button
                className={`icon-button scripts-button${open ? ' on' : ''}`}
                title={`Scripts of ${repoName}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
            >
                <Play size={15} strokeWidth={1.7} />
            </button>
            {open && (
                <div className="new-tab-menu scripts-dropdown" role="menu" onKeyDown={onMenuKey}>
                    <div className="new-tab-heading">Scripts</div>
                    {scripts.length === 0 && <div className="scripts-empty">No scripts for {repoName} yet.</div>}
                    {scripts.map(script => (
                        <div key={script.id} className="script-item">
                            <button
                                className="new-tab-item"
                                role="menuitem"
                                title={script.command}
                                onClick={() => {
                                    setOpen(false);
                                    onRun(script);
                                }}
                            >
                                <Play size={13} strokeWidth={1.8} />
                                <span className="new-tab-label">{script.name}</span>
                            </button>
                            <button className="icon-button script-action" title={`Edit "${script.name}"`} onClick={() => { setOpen(false); setEditing(script); }}>
                                <Pencil size={12} strokeWidth={1.8} />
                            </button>
                            <button className="icon-button script-action" title={`Delete "${script.name}"`} onClick={() => { setOpen(false); void remove(script); }}>
                                <Trash2 size={12} strokeWidth={1.8} />
                            </button>
                        </div>
                    ))}
                    <div className="new-tab-separator" />
                    <button className="new-tab-item" role="menuitem" onClick={() => { setOpen(false); setEditing('new'); }}>
                        <Plus size={14} strokeWidth={1.8} />
                        <span className="new-tab-label">Add script…</span>
                    </button>
                    {error && <div className="form-error scripts-error">{error}</div>}
                </div>
            )}
            {editing && (
                <ScriptDialog
                    repoName={repoName}
                    script={editing === 'new' ? undefined : editing}
                    onClose={() => setEditing(undefined)}
                    onSubmit={submit}
                />
            )}
        </div>
    );
}
