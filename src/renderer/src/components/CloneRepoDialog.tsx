import { useRef, useState } from 'react';
import { FolderDown, LoaderCircle, X } from 'lucide-react';
import type { RepoRef } from '@shared/github';
import { parseRepoInput } from '@shared/welcome';
import { errorText } from '../util';
import { Button, IconButton, Input } from './ui';
import { useModal } from './use-modal';

interface Props {
    /** The name of the project that gets the repository. */
    projectName: string;
    onClose(): void;
    /** Clones the repository into the project. Resolves false when the user cancels the folder dialog. */
    onClone(repo: RepoRef): Promise<boolean>;
}

/** The dialog that clones a GitHub repository into the active project. The next step is a folder dialog for the clone. */
export function CloneRepoDialog({ projectName, onClose, onClone }: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const [text, setText] = useState('');
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const repo = parseRepoInput(text);

    const submit = async () => {
        if (busy) return;
        if (!repo) {
            setError('Type a GitHub repository, for example "owner/name" or its address.');
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
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
                    <label className="run-field" htmlFor="clone-repo-input">
                        <span className="setting-label">GitHub repository</span>
                    </label>
                    <Input
                        id="clone-repo-input"
                        autoFocus
                        value={text}
                        placeholder="owner/name or https://github.com/owner/name"
                        spellCheck={false}
                        aria-describedby="clone-repo-help"
                        aria-invalid={!!error}
                        onChange={event => setText(event.target.value)}
                    />
                    <p id="clone-repo-help" className="panel-note">
                        After you click Clone, choose the folder for the clone. The repository goes into the project “{projectName}”.
                    </p>
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
                    <Button variant="solid" icon={busy && <LoaderCircle size={13} className="spin" />} onClick={() => void submit()} disabled={busy || !repo}>
                        Clone
                    </Button>
                </footer>
            </div>
        </div>
    );
}
