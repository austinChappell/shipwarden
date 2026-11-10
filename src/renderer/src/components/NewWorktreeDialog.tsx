import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderGit2, LoaderCircle, X } from 'lucide-react';
import { branchFromName, localNameOfRemote, type BranchList } from '@shared/worktrees';
import { errorText } from '../util';
import { Combobox, type ComboboxGroup } from './Combobox';
import { radioGroupKeys } from './keyboard';
import { useModal } from './use-modal';

export interface NewWorktreeRequest {
    /** The display name. Empty: the worktree shows its branch. */
    name: string;
    branch: string;
    /** The start point of a new branch, for example "origin/main". Undefined for an existing local branch. */
    baseRef?: string;
    /** The remote branch to check out and track, for example "origin/feature". Undefined for a new branch. */
    trackRef?: string;
    startAgent: boolean;
}

/** "new": a new branch from a start point. "remote": a checkout of a remote branch. */
type Mode = 'new' | 'remote';

interface Props {
    /** The display name of the repository, for the title. */
    repoName: string;
    repoPath: string;
    onClose(): void;
    onCreate(request: NewWorktreeRequest): Promise<void>;
    /** A start point for a new branch that is not a branch, for example a commit from the graph. */
    initialBase?: { ref: string; label: string };
    /** A remote branch to check out. The dialog opens in remote mode. */
    initialRemote?: string;
}

/**
 * The dialog for a new worktree. It has two modes:
 * - New branch: a display name, a branch name (made from the name until the user changes it) and the branch to start from.
 * - Remote branch: a remote branch to check out. The local branch gets the same name and tracks the remote branch.
 * In both modes, the user chooses whether an agent starts in the worktree.
 */
export function NewWorktreeDialog({ repoName, repoPath, onClose, onCreate, initialBase, initialRemote }: Props) {
    const [mode, setMode] = useState<Mode>(initialRemote ? 'remote' : 'new');
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const [remoteRef, setRemoteRef] = useState<string | undefined>(initialRemote);
    const [name, setName] = useState('');
    const [branch, setBranch] = useState('');
    /** True after the user types a branch name. Then the name does not change the branch any more. */
    const [branchEdited, setBranchEdited] = useState(false);
    const [base, setBase] = useState<string | undefined>(initialBase?.ref);
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

    /** In remote mode, the local branch name comes from the remote branch: "origin/feature" gives "feature". */
    const remoteLocalName = remoteRef && branches ? localNameOfRemote(remoteRef, branches.remotes) : undefined;
    const branchName = mode === 'remote' ? remoteLocalName ?? '' : branch.trim();
    /** A local branch with this name exists: the worktree checks it out, and the start point does not apply. */
    const exists = !!branches?.local.includes(branchName);
    const remoteGroups = useMemo((): ComboboxGroup[] => {
        if (!branches) return [];
        // One group for each remote. The branches stay newest first.
        const byRemote = new Map<string, ComboboxGroup['items']>();
        for (const ref of branches.remote) {
            const local = localNameOfRemote(ref, branches.remotes);
            if (!local) continue;
            const remote = ref.slice(0, ref.length - local.length - 1);
            byRemote.set(remote, [...(byRemote.get(remote) ?? []), { value: ref, label: ref }]);
        }
        return [...byRemote].map(([label, items]) => ({ label, items }));
    }, [branches]);
    const groups = useMemo((): ComboboxGroup[] => (branches ? [
        { label: 'Commit', items: initialBase ? [{ value: initialBase.ref, label: initialBase.label }] : [] },
        { label: 'Remote', items: branches.remote.map(ref => ({ value: ref, label: ref })) },
        { label: 'Local', items: branches.local.map(ref => ({ value: ref, label: ref })) }
    ].filter(group => group.items.length > 0) : []), [branches, initialBase]);

    const changeName = (value: string) => {
        setName(value);
        if (!branchEdited) setBranch(branchFromName(value));
    };

    const submit = async () => {
        if (mode === 'remote') {
            if (!remoteRef || !branchName) {
                setError('Choose the remote branch to check out.');
                return;
            }
            setBusy(true);
            setError(undefined);
            try {
                await onCreate({ name: name.trim(), branch: branchName, trackRef: exists ? undefined : remoteRef, startAgent });
            } catch (err) {
                setError(errorText(err));
                setBusy(false);
            }
            return;
        }
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
                ref={dialog}
                className="modal new-worktree-dialog"
                role="dialog"
                aria-modal="true"
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
                    <div className="segmented new-worktree-mode" role="radiogroup" aria-label="Branch source" onKeyDown={radioGroupKeys}>
                        {(['new', 'remote'] as const).map(value => (
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
                                {value === 'new' ? 'New branch' : 'Remote branch'}
                            </button>
                        ))}
                    </div>
                    {mode === 'remote' && (
                        <div className="run-field">
                            <span className="setting-label">Remote branch</span>
                            <Combobox
                                value={remoteRef}
                                groups={remoteGroups}
                                onChange={setRemoteRef}
                                placeholder={loadError ? 'No branches' : !branches ? 'Fetching the branches…' : remoteGroups.length === 0 ? 'No remote branches' : 'Choose a remote branch'}
                                searchPlaceholder="Find a remote branch"
                                disabled={!branches || remoteGroups.length === 0}
                                className="new-worktree-base"
                            />
                            {!branches && !loadError && (
                                <span className="panel-note"><LoaderCircle size={11} className="spin" /> Fetching origin, so the list is new.</span>
                            )}
                            {loadError && <span className="form-error">{loadError}</span>}
                            {remoteRef && branchName && (exists
                                ? <span className="panel-note">The local branch {branchName} exists. The worktree checks it out. Pull to get the newest commits.</span>
                                : <span className="panel-note">The worktree gets the local branch {branchName}. It tracks {remoteRef}.</span>)}
                        </div>
                    )}
                    <label className="run-field">
                        <span className="setting-label">Name <span className="new-worktree-optional">(optional)</span></span>
                        <input
                            className="settings-input"
                            autoFocus
                            value={name}
                            placeholder={mode === 'remote' ? branchName || 'Login page rework' : 'Login page rework'}
                            onChange={event => changeName(event.target.value)}
                        />
                        <span className="panel-note">The sidebar shows this name. Without a name, it shows the branch.</span>
                    </label>
                    {mode === 'new' && (
                        <>
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
                        </>
                    )}
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
