import { useEffect, useId, useRef, useState } from 'react';
import { Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import type { RepoScript } from '@shared/settings';
import { errorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { useMenuClose } from './use-menu';
import { useModal } from './use-modal';
import { Button, Field, IconButton, Input, TextArea } from './ui';

interface Props {
    /** The display name of the repository, for the titles. */
    repoName: string;
    scripts: RepoScript[];
    onRun(script: RepoScript): void;
    /** Saves the full list of scripts of the repository. */
    onSave(scripts: RepoScript[]): Promise<void>;
}

/** The dialog that adds a script or changes one. */
function ScriptDialog({
    repoName,
    script,
    onClose,
    onSubmit
}: {
    repoName: string;
    script?: RepoScript;
    onClose(): void;
    onSubmit(name: string, command: string): Promise<void>;
}) {
    const [name, setName] = useState(script?.name ?? '');
    const [command, setCommand] = useState(script?.command ?? '');
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const dialog = useRef<HTMLDivElement>(null);
    const ids = useId();
    useModal(dialog);

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
            <div
                ref={dialog}
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-label={script ? 'Edit script' : 'Add script'}
                onKeyDown={event => event.key === 'Escape' && onClose()}
            >
                <header className="modal-header">
                    <Play size={15} strokeWidth={1.8} />
                    <h2>{script ? `Edit "${script.name}"` : `New script for ${repoName}`}</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={15} strokeWidth={1.8} />} label="Close" onClick={onClose} />
                </header>
                <div className="modal-body">
                    <Field className="run-field" label="Name" htmlFor={`${ids}-name`}>
                        <Input
                            id={`${ids}-name`}
                            autoFocus
                            value={name}
                            placeholder="Test"
                            spellCheck={false}
                            onChange={event => setName(event.target.value)}
                        />
                    </Field>
                    <Field
                        className="run-field"
                        label="Command"
                        htmlFor={`${ids}-command`}
                        hint="The script runs in a new terminal tab of the selected worktree, in your login shell. It gets SHIPWARDEN_ROOT_PATH, SHIPWARDEN_WORKTREE_PATH, SHIPWARDEN_BRANCH, and SHIPWARDEN_REPO_NAME."
                    >
                        <TextArea
                            id={`${ids}-command`}
                            mono
                            className="script-field"
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
                    </Field>
                    {error && <div className="form-error">{error}</div>}
                </div>
                <footer className="modal-footer">
                    <span className="panel-note">⌘↩ saves.</span>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="primary" disabled={busy} onClick={() => void submit()}>
                        {script ? 'Save' : 'Add script'}
                    </Button>
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
    const button = useRef<HTMLButtonElement>(null);

    useMenuClose(open, root, () => setOpen(false));
    useEffect(() => {
        if (open) root.current?.querySelector<HTMLButtonElement>('.new-tab-item')?.focus();
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
        const list =
            editing && editing !== 'new'
                ? scripts.map(item => (item.id === editing.id ? { ...item, name, command } : item))
                : [...scripts, { id: crypto.randomUUID(), name, command }];
        await save(list);
        closeDialog();
    };
    /** Closes the script dialog. The menu item that opened the dialog is gone, so the focus goes to the ▷ button. */
    const closeDialog = () => {
        setEditing(undefined);
        button.current?.focus();
    };

    return (
        <div className="new-tab scripts-menu" ref={root}>
            <IconButton
                ref={button}
                active={open}
                icon={<Play size={15} strokeWidth={1.7} />}
                label={`Scripts of ${repoName}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
            />
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
                            <IconButton
                                size="sm"
                                className="script-action"
                                icon={<Pencil size={12} strokeWidth={1.8} />}
                                label={`Edit "${script.name}"`}
                                onClick={() => {
                                    setOpen(false);
                                    setEditing(script);
                                }}
                            />
                            <IconButton
                                size="sm"
                                tone="danger"
                                className="script-action"
                                icon={<Trash2 size={12} strokeWidth={1.8} />}
                                label={`Delete "${script.name}"`}
                                onClick={() => {
                                    setOpen(false);
                                    void remove(script);
                                }}
                            />
                        </div>
                    ))}
                    <div className="new-tab-separator" />
                    <button
                        className="new-tab-item"
                        role="menuitem"
                        onClick={() => {
                            setOpen(false);
                            setEditing('new');
                        }}
                    >
                        <Plus size={14} strokeWidth={1.8} />
                        <span className="new-tab-label">Add script…</span>
                    </button>
                    {error && <div className="form-error scripts-error">{error}</div>}
                </div>
            )}
            {editing && <ScriptDialog repoName={repoName} script={editing === 'new' ? undefined : editing} onClose={closeDialog} onSubmit={submit} />}
        </div>
    );
}
