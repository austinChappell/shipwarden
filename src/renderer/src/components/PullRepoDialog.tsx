import { useMemo, useRef, useState } from 'react';
import { FolderInput, LoaderCircle, X } from 'lucide-react';
import type { RepoRef } from '@shared/github';
import type { Project, PullRepoTarget } from '@shared/projects';
import { errorText } from '../util';
import { CodeFolderInput, useCodeFolderDraft } from './code-folder';
import { radioGroupKeys } from './keyboard';
import { Button, ButtonGroup, Combobox, type ComboboxGroup, IconButton, Input } from './ui';
import { useModal } from './use-modal';

/** "existing": a project that exists. "new": a new project. */
type Mode = 'existing' | 'new';

interface Props {
    repo: RepoRef;
    projects: Project[];
    /** The project that the dialog selects first. */
    activeId: string | undefined;
    onClose(): void;
    /** Adds the repository to the project. Resolves true when the repository is in the project. */
    onPull(target: PullRepoTarget): Promise<boolean>;
}

/**
 * The dialog that adds the GitHub repository of a pull request to a project. The user chooses a project or types the
 * name of a new project. The clone goes to <code folder>/<name>. When the code folder is not set, the dialog shows a field for it.
 */
export function PullRepoDialog({ repo, projects, activeId, onClose, onPull }: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const [mode, setMode] = useState<Mode>('existing');
    const [projectId, setProjectId] = useState<string | undefined>(activeId ?? projects[0]?.id);
    const [name, setName] = useState(repo.name);
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const groups = useMemo(
        (): ComboboxGroup[] => [{ label: 'Projects', items: projects.map(project => ({ value: project.id, label: project.name })) }],
        [projects]
    );
    const codeFolder = useCodeFolderDraft();
    const ready = (mode === 'existing' ? !!projectId : name.trim() !== '') && !!codeFolder.folder;

    const submit = async () => {
        if (busy) return;
        if (mode === 'existing' && !projectId) {
            setError('Choose a project.');
            return;
        }
        if (mode === 'new' && !name.trim()) {
            setError('Type a name for the new project.');
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await codeFolder.commit();
            const done = await onPull(mode === 'existing' && projectId ? { projectId } : { newProjectName: name.trim() });
            if (done) {
                onClose();
                return;
            }
        } catch (err) {
            setError(errorText(err));
        }
        setBusy(false);
    };

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
            <div
                ref={dialog}
                className="modal new-worktree-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Pull the repository into a project"
                onKeyDown={event => {
                    if (event.key === 'Escape' && !busy) onClose();
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
                }}
            >
                <header className="modal-header">
                    <FolderInput size={15} strokeWidth={1.8} />
                    <h2>
                        Pull {repo.owner}/{repo.name} into a project
                    </h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={15} strokeWidth={1.8} />} label="Close (Esc)" disabled={busy} onClick={onClose} />
                </header>
                <form
                    className="modal-body"
                    onSubmit={event => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <p className="panel-note">
                        No project has a clone of this repository. ShipWarden clones it from GitHub
                        {codeFolder.folder ? (
                            <>
                                {' '}
                                to <code>{`${codeFolder.folder}/${repo.name}`}</code>
                            </>
                        ) : null}
                        .
                    </p>
                    {codeFolder.needed && (
                        <div className="run-field">
                            <label className="setting-label" htmlFor="pull-repo-folder">
                                Code folder
                            </label>
                            <span className="panel-note">Choose the folder for your code first. You can change it later in Settings › Worktrees.</span>
                            <CodeFolderInput draft={codeFolder} id="pull-repo-folder" disabled={busy} />
                        </div>
                    )}
                    <ButtonGroup className="new-worktree-mode" role="radiogroup" label="Project" onKeyDown={radioGroupKeys}>
                        {(['existing', 'new'] as const).map(value => (
                            <Button
                                key={value}
                                role="radio"
                                aria-checked={mode === value}
                                disabled={busy}
                                onClick={() => {
                                    setMode(value);
                                    setError(undefined);
                                }}
                            >
                                {value === 'existing' ? 'Existing project' : 'New project'}
                            </Button>
                        ))}
                    </ButtonGroup>
                    {mode === 'existing' ? (
                        <div className="run-field">
                            <span className="setting-label">Project</span>
                            <Combobox
                                value={projectId}
                                groups={groups}
                                onChange={setProjectId}
                                placeholder="Choose a project"
                                searchPlaceholder="Find a project"
                                disabled={busy}
                                className="new-worktree-base"
                            />
                        </div>
                    ) : (
                        <div className="run-field">
                            <label className="setting-label" htmlFor="pull-repo-name">
                                Project name
                            </label>
                            <Input id="pull-repo-name" autoFocus value={name} disabled={busy} onChange={event => setName(event.target.value)} />
                        </div>
                    )}
                    {busy && (
                        <p className="panel-note">
                            <LoaderCircle size={11} className="spin" /> ShipWarden clones the repository. A large repository can take a few minutes.
                        </p>
                    )}
                    {error && <div className="form-error">{error}</div>}
                    <button type="submit" hidden />
                </form>
                <footer className="modal-footer">
                    <span className="panel-note">⌘↩ pulls. Esc cancels.</span>
                    <Button disabled={busy} onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        icon={busy && <LoaderCircle size={13} className="spin" />}
                        disabled={busy || !ready}
                        onClick={() => void submit()}
                    >
                        Pull repository
                    </Button>
                </footer>
            </div>
        </div>
    );
}
