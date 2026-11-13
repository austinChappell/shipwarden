import { useRef, useState } from 'react';
import { FolderDown, LoaderCircle, X } from 'lucide-react';
import { parseRepoId, type RepoRef } from '@shared/github';
import { parseRepoInput } from '@shared/welcome';
import { useRepoChoices } from '../github/repo-choices';
import { errorText } from '../util';
import { CodeFolderInput, useCodeFolderDraft } from './code-folder';
import { Button, Combobox, IconButton, Input } from './ui';
import { useModal } from './use-modal';

interface Props {
    /** The name of the project that gets the repository. */
    projectName: string;
    onClose(): void;
    /** Clones the repository into the project. Resolves true when the repository is in the project. */
    onClone(repo: RepoRef): Promise<boolean>;
}

/**
 * The dialog that clones a repository into the active project. The user selects a repository of the GitHub and Azure DevOps
 * accounts in Settings › Code review. Without an account, or when the list does not load, the user types the GitHub repository. The clone goes to <code folder>/<name>.
 * When the code folder is not set, the dialog shows a field for it first. The clone saves the folder.
 */
export function CloneRepoDialog({ projectName, onClose, onClone }: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const [text, setText] = useState('');
    const [selected, setSelected] = useState<string>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const choices = useRepoChoices();
    /** True when the user types the repository, because no account is on or the list did not load. */
    const typed = choices.noProvider || !!choices.error;
    const repo = typed ? parseRepoInput(text) : selected ? parseRepoId(selected) : undefined;
    const codeFolder = useCodeFolderDraft();

    const submit = async () => {
        if (busy) return;
        if (!repo) {
            setError(typed ? 'Type a GitHub repository, for example "owner/name" or its address.' : 'Select a repository.');
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await codeFolder.commit();
            if (await onClone(repo)) onClose();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
            <div
                ref={dialog}
                className="modal clone-repo-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="clone-repo-title"
                onKeyDown={event => event.key === 'Escape' && !busy && onClose()}
            >
                <header className="modal-header">
                    <FolderDown size={16} strokeWidth={1.8} />
                    <h2 id="clone-repo-title">Clone a repository</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={15} strokeWidth={1.8} />} label="Close" onClick={onClose} disabled={busy} />
                </header>
                <form
                    className="modal-body"
                    onSubmit={event => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    {codeFolder.needed && (
                        <>
                            <label className="run-field" htmlFor="clone-repo-folder">
                                <span className="setting-label">Code folder</span>
                            </label>
                            <p className="panel-note">
                                Choose the folder for your code first. Each clone goes into a new folder in it. You can change it later in Settings › Worktrees.
                            </p>
                            <CodeFolderInput draft={codeFolder} id="clone-repo-folder" disabled={busy} />
                        </>
                    )}
                    {typed ? (
                        <>
                            <label className="run-field" htmlFor="clone-repo-input">
                                <span className="setting-label">GitHub repository</span>
                            </label>
                            <Input
                                id="clone-repo-input"
                                autoFocus={!codeFolder.needed}
                                value={text}
                                placeholder="owner/name or https://github.com/owner/name"
                                spellCheck={false}
                                aria-describedby="clone-repo-help"
                                aria-invalid={!!error}
                                disabled={busy}
                                onChange={event => setText(event.target.value)}
                            />
                            <p className="panel-note">
                                {choices.error
                                    ? `ShipWarden cannot load your repositories. ${errorText(choices.error)}`
                                    : 'Connect a GitHub or Azure DevOps account in Settings › Code review to select from your repositories.'}
                            </p>
                        </>
                    ) : (
                        <div className="run-field">
                            <span className="setting-label">Repository</span>
                            <Combobox
                                className="new-worktree-base"
                                value={selected}
                                groups={choices.groups}
                                onChange={value => {
                                    setSelected(value);
                                    setError(undefined);
                                }}
                                placeholder={choices.loading ? 'Loading repositories…' : 'Select a repository'}
                                searchPlaceholder="Search repositories"
                                disabled={busy || choices.loading}
                                title="Repository"
                            />
                        </div>
                    )}
                    <p id="clone-repo-help" className="panel-note">
                        {codeFolder.folder ? (
                            <>
                                The clone goes to <code>{`${codeFolder.folder}/${repo?.name ?? '<name>'}`}</code>.{' '}
                            </>
                        ) : null}
                        The repository goes into the project “{projectName}”.
                    </p>
                    {busy && (
                        <p className="panel-note">
                            <LoaderCircle size={11} className="spin" /> ShipWarden clones the repository. A large repository can take a few minutes.
                        </p>
                    )}
                    {error && (
                        <div className="form-error" role="alert">
                            {error}
                        </div>
                    )}
                </form>
                <footer className="modal-footer">
                    <Button onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        icon={busy && <LoaderCircle size={13} className="spin" />}
                        onClick={() => void submit()}
                        disabled={busy || !repo || !codeFolder.folder}
                    >
                        Clone
                    </Button>
                </footer>
            </div>
        </div>
    );
}
