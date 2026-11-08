import { useEffect, useMemo, useState } from 'react';
import { FolderGit2, LoaderCircle, X } from 'lucide-react';
import { branchFromName, type BranchList } from '@shared/worktrees';
import { errorText } from '../util';
import { Combobox, type ComboboxGroup } from './Combobox';

export interface NewWorktreeRequest {
    /** The display name. Empty: the worktree shows its branch. */
    name: string;
    branch: string;
    /** The start point of a new branch, for example "origin/main". Undefined for an existing local branch. */
    baseRef?: string;
    startAgent: boolean;
}

interface Props {
    /** The display name of the repository, for the title. */
    repoName: string;
    repoPath: string;
    onClose(): void;
    onCreate(request: NewWorktreeRequest): Promise<void>;
}

/**
 * The dialog for a new worktree: a display name, a branch name (made from the name until the user changes it), the
 * branch to start from, and whether an agent starts in it.
 */
export function NewWorktreeDialog({ repoName, repoPath, onClose, onCreate }: Props) {
    const [name, setName] = useState('');
    const [branch, setBranch] = useState('');
    /** True after the user types a branch name. Then the name does not change the branch any more. */
    const [branchEdited, setBranchEdited] = useState(false);
    const [base, setBase] = useState<string>();
    const [branches, setBranches] = useState<BranchList>();
    const [loadError, setLoadError] = useState<string>();
    const [startAgent, setStartAgent] = useState(true);
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let current = true;
        window.shipwarden.worktrees.branches(repoPath).then(list => {
            if (!current) return;
            setBranches(list);
            setBase(value => value ?? list.defaultBase ?? list.local[0]);
        }, err => current && setLoadError(errorText(err)));
        return () => {
            current = false;
        };
    }, [repoPath]);

    const branchName = branch.trim();
    /** A local branch with this name exists: the worktree checks it out, and the start point does not apply. */
    const exists = !!branches?.local.includes(branchName);
    const groups = useMemo((): ComboboxGroup[] => (branches ? [
        { label: 'Remote', items: branches.remote.map(ref => ({ value: ref, label: ref })) },
        { label: 'Local', items: branches.local.map(ref => ({ value: ref, label: ref })) }
    ].filter(group => group.items.length > 0) : []), [branches]);

    const changeName = (value: string) => {
        setName(value);
        if (!branchEdited) setBranch(branchFromName(value));
    };

    const submit = async () => {
        if (!branchName) {
            setError('Type a branch name, or a name to make one from.');
            return;
        }
        if (/\s/.test(branchName)) {
            setError('A branch name cannot contain spaces.');
            return;
        }
        if (!exists && !base && branches) {
            setError('Choose the branch to start from.');
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await onCreate({ name: name.trim(), branch: branchName, baseRef: exists ? undefined : base, startAgent });
        } catch (err) {
            setError(errorText(err));
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
            <div
                className="modal new-worktree-dialog"
                role="dialog"
                aria-label="New worktree"
                onKeyDown={event => {
                    if (event.key === 'Escape' && !busy) onClose();
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
                }}
            >
                <header className="modal-header">
                    <FolderGit2 size={15} strokeWidth={1.8} />
                    <h2>New worktree in {repoName}</h2>
                    <span className="header-spacer" />
                    <button className="icon-button" title="Close (Esc)" disabled={busy} onClick={onClose}><X size={15} strokeWidth={1.8} /></button>
                </header>
                <form className="modal-body" onSubmit={event => { event.preventDefault(); void submit(); }}>
                    <label className="run-field">
                        <span className="setting-label">Name <span className="new-worktree-optional">(optional)</span></span>
                        <input
                            className="settings-input"
                            autoFocus
                            value={name}
                            placeholder="Login page rework"
                            onChange={event => changeName(event.target.value)}
                        />
                        <span className="panel-note">The sidebar shows this name. Without a name, it shows the branch.</span>
                    </label>
                    <label className="run-field">
                        <span className="setting-label">Branch</span>
                        <input
                            className="settings-input mono"
                            value={branch}
                            placeholder="login-page-rework"
                            spellCheck={false}
                            onChange={event => {
                                setBranch(event.target.value);
                                setBranchEdited(event.target.value.trim() !== '');
                            }}
                        />
                        {exists && <span className="panel-note">This branch exists. The worktree checks it out.</span>}
                    </label>
                    <div className="run-field">
                        <span className="setting-label">Start from</span>
                        <Combobox
                            value={exists ? undefined : base}
                            groups={groups}
                            onChange={setBase}
                            placeholder={exists ? `The branch ${branchName}` : loadError ? 'No branches' : 'Fetching the branches…'}
                            searchPlaceholder="Find a branch"
                            disabled={exists || !branches}
                            className="new-worktree-base"
                        />
                        {!branches && !loadError && (
                            <span className="panel-note"><LoaderCircle size={11} className="spin" /> Fetching origin, so the start point is new.</span>
                        )}
                        {loadError && <span className="form-error">{loadError}</span>}
                        {branches && !exists && base === branches.defaultBase && (
                            <span className="panel-note">The newest {base} from the remote. The new branch does not track it.</span>
                        )}
                    </div>
                    <label className="new-worktree-agent">
                        <input type="checkbox" checked={startAgent} onChange={event => setStartAgent(event.target.checked)} />
                        Start an agent in the new worktree
                    </label>
                    {error && <div className="form-error">{error}</div>}
                    <button type="submit" hidden />
                </form>
                <footer className="modal-footer">
                    <span className="panel-note">⌘↩ creates. Esc cancels.</span>
                    <button className="button" disabled={busy} onClick={onClose}>Cancel</button>
                    <button className="button primary" disabled={busy || !branchName} onClick={() => void submit()}>
                        {busy && <LoaderCircle size={13} className="spin" />} Create worktree
                    </button>
                </footer>
            </div>
        </div>
    );
}
