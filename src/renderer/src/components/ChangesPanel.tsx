import { useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronRight, FileText, GitBranch, LoaderCircle, Minus, Plus, RefreshCw, Upload } from 'lucide-react';
import { baseName, parentPath } from '@shared/files';
import { changeLetter, type ChangeSide, type FileChange, type GitChanges } from '@shared/git';
import { gitChanged } from '../git/git-store';
import { errorText } from '../util';

interface Props {
    worktree: string;
    changes: GitChanges | undefined;
    error: string | undefined;
    onReload(): void;
    /** Opens the diff of a file in a tab. */
    onOpenChange(change: FileChange, side: ChangeSide): void;
    onOpenFile(path: string): void;
}

const api = window.shipwarden.git;

/** A group of changed files: a header with a count and an action for all, and a row for each file. */
function Group({ title, files, open, onToggle, action, children }: {
    title: string;
    files: FileChange[];
    open: boolean;
    onToggle(): void;
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="changes-group">
            <div className="changes-group-head" onClick={onToggle}>
                <ChevronRight size={13} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                <span className="changes-group-title">{title}</span>
                <span className="changes-group-count">{files.length}</span>
                <span className="changes-group-action" onClick={event => event.stopPropagation()}>{action}</span>
            </div>
            {open && children}
        </section>
    );
}

/**
 * The Changes tab of the right panel: the git changes of the worktree. The user stages and unstages files, opens
 * the diff of a file, writes a commit message and commits, and pushes the branch.
 */
export function ChangesPanel({ worktree, changes, error, onReload, onOpenChange, onOpenFile }: Props) {
    const [message, setMessage] = useState('');
    const [amend, setAmend] = useState(false);
    const [busy, setBusy] = useState<string>();
    const [actionError, setActionError] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const [closed, setClosed] = useState(new Set<string>());

    /** Runs a git action, then reads the changes again. `label` shows on the busy button. */
    const act = async (label: string, action: () => Promise<void>) => {
        setBusy(label);
        setActionError(undefined);
        try {
            await action();
        } catch (err) {
            setActionError(errorText(err));
        } finally {
            setBusy(undefined);
            gitChanged();
        }
    };
    const stage = (paths: string[]) => act('stage', () => api.stage(worktree, paths));
    const unstage = (paths: string[]) => act('unstage', () => api.unstage(worktree, paths));
    const commit = () => act('commit', async () => {
        const result = await api.commit(worktree, message, amend);
        setMessage('');
        setAmend(false);
        setNotice(`Committed ${result.hash}: ${result.summary}`);
        setTimeout(() => setNotice(undefined), 6000);
    });
    const push = () => act('push', async () => {
        await api.push(worktree);
        setNotice('Pushed the branch.');
        setTimeout(() => setNotice(undefined), 6000);
    });
    const toggleAmend = async (value: boolean) => {
        setAmend(value);
        // "Amend" starts from the message of the last commit, unless the user typed one.
        if (value && !message.trim()) {
            try {
                setMessage(await api.lastMessage(worktree));
            } catch {
                // The user types the message.
            }
        }
    };
    const toggleGroup = (id: string) => setClosed(set => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    if (!changes) {
        return <div className="panel-message">{error ?? <><LoaderCircle size={14} className="spin" /> Reading the changes…</>}</div>;
    }

    const staged = changes.staged;
    const canCommit = message.trim() !== '' && (staged.length > 0 || amend) && !busy;
    const canPush = !!changes.branch && !changes.unborn && (changes.ahead > 0 || !changes.upstream);

    const row = (change: FileChange, side: ChangeSide | 'conflict') => {
        const inIndex = side === 'staged';
        return (
            <div
                key={`${side}:${change.path}`}
                className="change-row"
                title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
                onClick={() => onOpenChange(change, side === 'conflict' ? 'unstaged' : side)}
            >
                <span className={`change-letter ${change.kind}`}>{changeLetter(change.kind)}</span>
                <span className={`change-name${change.kind === 'deleted' ? ' deleted' : ''}`}>{baseName(change.path)}</span>
                <span className="change-dir">{parentPath(change.path)}</span>
                <span className="change-actions" onClick={event => event.stopPropagation()}>
                    {change.kind !== 'deleted' && (
                        <button className="icon-button" title="Open the file" onClick={() => onOpenFile(change.path)}><FileText size={13} strokeWidth={1.7} /></button>
                    )}
                    {inIndex
                        ? <button className="icon-button" title="Unstage" disabled={!!busy} onClick={() => void unstage([change.path])}><Minus size={14} strokeWidth={2} /></button>
                        : (
                            <button className="icon-button" title={side === 'conflict' ? 'Mark as resolved (stage)' : 'Stage'} disabled={!!busy} onClick={() => void stage([change.path])}>
                                {side === 'conflict' ? <Check size={14} strokeWidth={2} /> : <Plus size={14} strokeWidth={2} />}
                            </button>
                        )}
                </span>
            </div>
        );
    };

    const clean = staged.length === 0 && changes.unstaged.length === 0 && changes.conflicted.length === 0;

    return (
        <div className="changes-panel">
            <div className="changes-branch">
                <GitBranch size={14} strokeWidth={1.7} />
                <span className="changes-branch-name" title={changes.upstream ? `Tracks ${changes.upstream}` : 'No upstream branch'}>{changes.branch ?? 'Detached HEAD'}</span>
                {changes.ahead > 0 && <span className="changes-ab" title={`${changes.ahead} commits to push`}><ArrowUp size={12} strokeWidth={2} />{changes.ahead}</span>}
                {changes.behind > 0 && <span className="changes-ab" title={`${changes.behind} commits to pull`}><ArrowDown size={12} strokeWidth={2} />{changes.behind}</span>}
                <span className="header-spacer" />
                {canPush && (
                    <button className="button changes-push" disabled={!!busy} title={changes.upstream ? `Push to ${changes.upstream}` : 'Push, and track origin'} onClick={() => void push()}>
                        {busy === 'push' ? <LoaderCircle size={13} className="spin" /> : <Upload size={13} strokeWidth={1.8} />} Push
                    </button>
                )}
                <button className="icon-button" title="Refresh" onClick={onReload}><RefreshCw size={14} strokeWidth={1.6} /></button>
            </div>

            <div className="changes-commit">
                <textarea
                    className="settings-input changes-message"
                    rows={Math.min(8, Math.max(2, message.split('\n').length))}
                    value={message}
                    placeholder={amend ? 'The message of the amended commit' : 'Commit message (⌘↩ to commit)'}
                    spellCheck
                    onChange={event => setMessage(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canCommit) {
                            event.preventDefault();
                            void commit();
                        }
                    }}
                />
                <div className="changes-commit-row">
                    <label className="changes-amend" title="Replace the last commit with the staged changes and this message">
                        <input type="checkbox" checked={amend} disabled={changes.unborn} onChange={event => void toggleAmend(event.target.checked)} />
                        Amend
                    </label>
                    <span className="header-spacer" />
                    <button className="button primary" disabled={!canCommit} onClick={() => void commit()}
                        title={staged.length === 0 && !amend ? 'Stage changes first' : message.trim() ? undefined : 'Type a commit message'}>
                        {busy === 'commit' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} strokeWidth={2} />}
                        {amend ? 'Amend commit' : staged.length ? `Commit ${staged.length} ${staged.length === 1 ? 'file' : 'files'}` : 'Commit'}
                    </button>
                </div>
            </div>

            {(actionError || error) && <div className="form-error changes-error">{actionError ?? error}</div>}
            {notice && <div className="changes-notice">{notice}</div>}

            <div className="changes-list">
                {clean && <p className="panel-note changes-clean">No changes. The working tree is clean.</p>}
                {changes.conflicted.length > 0 && (
                    <Group title="Merge conflicts" files={changes.conflicted} open={!closed.has('conflicts')} onToggle={() => toggleGroup('conflicts')}>
                        {changes.conflicted.map(change => row(change, 'conflict'))}
                    </Group>
                )}
                {staged.length > 0 && (
                    <Group
                        title="Staged"
                        files={staged}
                        open={!closed.has('staged')}
                        onToggle={() => toggleGroup('staged')}
                        action={<button className="link-button" disabled={!!busy} onClick={() => void unstage(staged.map(change => change.path))}>Unstage all</button>}
                    >
                        {staged.map(change => row(change, 'staged'))}
                    </Group>
                )}
                {changes.unstaged.length > 0 && (
                    <Group
                        title="Changes"
                        files={changes.unstaged}
                        open={!closed.has('unstaged')}
                        onToggle={() => toggleGroup('unstaged')}
                        action={<button className="link-button" disabled={!!busy} onClick={() => void stage(changes.unstaged.map(change => change.path))}>Stage all</button>}
                    >
                        {changes.unstaged.map(change => row(change, 'unstaged'))}
                    </Group>
                )}
            </div>
        </div>
    );
}
