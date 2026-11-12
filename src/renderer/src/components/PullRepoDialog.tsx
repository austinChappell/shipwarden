import { useMemo, useRef, useState } from 'react';
import { FolderInput, LoaderCircle, X } from 'lucide-react';
import type { RepoRef } from '@shared/github';
import type { Project, PullRepoTarget } from '@shared/projects';
import { errorText } from '../util';
import { Combobox, type ComboboxGroup } from './ui/Combobox';
import { radioGroupKeys } from './keyboard';
import { useModal } from './use-modal';

/** "existing": a project that exists. "new": a new project. */
type Mode = 'existing' | 'new';

interface Props {
    repo: RepoRef;
    projects: Project[];
    /** The project that the dialog selects first. */
    activeId: string | undefined;
    onClose(): void;
    /** Adds the repository to the project. Resolves false when the user cancels the folder dialog. */
    onPull(target: PullRepoTarget): Promise<boolean>;
}

/**
 * The dialog that adds the GitHub repository of a pull request to a project. The user chooses a project or types the
 * name of a new project. Without a clone in a project, the next step is a folder dialog for the clone.
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
    const ready = mode === 'existing' ? !!projectId : name.trim() !== '';

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
                    <button className="icon-button" title="Close (Esc)" disabled={busy} onClick={onClose}>
                        <X size={15} strokeWidth={1.8} />
                    </button>
                </header>
                <form
                    className="modal-body"
                    onSubmit={event => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <p className="panel-note">
                        No project has a clone of this repository. ShipWarden clones it from GitHub into a folder that you choose in the next step.
                    </p>
                    <div className="segmented new-worktree-mode" role="radiogroup" aria-label="Project" onKeyDown={radioGroupKeys}>
                        {(['existing', 'new'] as const).map(value => (
                            <button
                                key={value}
                                type="button"
                                role="radio"
                                aria-checked={mode === value}
                                className={mode === value ? 'selected' : ''}
                                disabled={busy}
                                onClick={() => {
                                    setMode(value);
                                    setError(undefined);
                                }}
                            >
                                {value === 'existing' ? 'Existing project' : 'New project'}
                            </button>
                        ))}
                    </div>
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
                        <label className="run-field">
                            <span className="setting-label">Project name</span>
                            <input className="settings-input" autoFocus value={name} disabled={busy} onChange={event => setName(event.target.value)} />
                        </label>
                    )}
                    {busy && (
                        <p className="panel-note">
                            <LoaderCircle size={11} className="spin" /> Choose the folder for the clone. Then ShipWarden clones the repository. A large
                            repository can take a few minutes.
                        </p>
                    )}
                    {error && <div className="form-error">{error}</div>}
                    <button type="submit" hidden />
                </form>
                <footer className="modal-footer">
                    <span className="panel-note">⌘↩ pulls. Esc cancels.</span>
                    <button className="button" disabled={busy} onClick={onClose}>
                        Cancel
                    </button>
                    <button className="button primary" disabled={busy || !ready} onClick={() => void submit()}>
                        {busy && <LoaderCircle size={13} className="spin" />} Pull repository
                    </button>
                </footer>
            </div>
        </div>
    );
}
