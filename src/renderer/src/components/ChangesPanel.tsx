import { useState, type ReactNode } from 'react';
import {
    ArrowDown,
    ArrowUp,
    Bot,
    Check,
    ChevronRight,
    Download,
    FileText,
    GitBranch,
    GitCompareArrows,
    GitMerge,
    LoaderCircle,
    Minus,
    Plus,
    Undo2,
    Upload
} from 'lucide-react';
import { baseName, parentPath } from '@shared/files';
import { changeLetter, hasDiverged, type ChangeSide, type FetchResult, type FileChange, type GitChanges, type RebaseState } from '@shared/git';
import { gitChanged } from '../git/git-store';
import { confirmDialog } from './ConfirmDialog';
import { errorText } from '../util';
import { itemKeys, moveListFocus } from '../keyboard/list-nav';
import { pluralize } from '@shared/format';
import { Button, Checkbox, Count, IconButton, RefreshButton, SkeletonRows, TextArea } from './ui';
import { DraftButton } from './DraftButton';
import { OverlapNote } from './OverlapChip';
import { useWorktreeOverlap } from '../git/overlap-query';
import { afterRebase, confirmForcePush, conflictPromptFor } from '../git/rebase-actions';

interface Props {
    worktree: string;
    /** The repository of the worktree (its main worktree). The panel shows the files that other worktrees also change. */
    repo?: string;
    changes: GitChanges | undefined;
    error: string | undefined;
    /** The last background fetch of the upstream remote. */
    fetched: FetchResult | undefined;
    /** Reads the changes again, and fetches the remote now. */
    onReload(): void;
    /** True while a load from `onReload` is running. The Refresh icon turns. */
    refreshing?: boolean;
    /** Opens the diff of a file in a tab. */
    onOpenChange(change: FileChange, side: ChangeSide): void;
    /** Opens one tab with the diffs of all changed files. */
    onOpenAllChanges(): void;
    onOpenFile(path: string): void;
    /** Sends a prompt to the agent of the worktree. Without it, a rebase conflict has no "Send to agent" button. */
    onSendToAgent?(prompt: string): void;
}

const api = window.shipwarden.git;

/**
 * Asks before a discard and then discards. Untracked files go to the Trash. Changed files get the version of the
 * index, and a copy of the working version goes to the Trash. Resolves true when the files were discarded.
 */
export async function confirmDiscard(worktree: string, files: FileChange[]): Promise<boolean> {
    const untracked = files.filter(change => change.kind === 'untracked').length;
    const changed = files.length - untracked;
    const name = files.length === 1 ? `"${baseName(files[0].path)}"` : `${files.length} files`;
    const single = files.length === 1;
    const parts = [
        changed
            ? `${single ? 'The file gets its' : `${changed} changed ${changed === 1 ? 'file gets its' : 'files get their'}`} staged or committed version again. A copy of your version goes to the Trash.`
            : '',
        untracked ? `${single ? 'The new file goes' : `${untracked} new ${untracked === 1 ? 'file goes' : 'files go'}`} to the Trash.` : ''
    ].filter(Boolean);
    const ok = await confirmDialog({
        title: `Discard the changes in ${name}?`,
        message: `${parts.join(' ')} Staged changes stay.`,
        confirmLabel: 'Discard',
        danger: true
    });
    if (!ok) return false;
    await api.discard(
        worktree,
        files.map(change => change.path)
    );
    return true;
}

/** The text of the place of a rebase, for example "feature onto origin/main · commit 2 of 5". */
export function rebaseText(state: RebaseState): string {
    const onto = state.ontoName ?? state.onto.slice(0, 7);
    const step = state.step && state.total ? ` · commit ${state.step} of ${state.total}` : '';
    return `${state.branch ?? 'HEAD'} onto ${onto}${step}`;
}

/** A group of changed files: a header with a count and an action for all, and a row for each file. */
function Group({
    title,
    files,
    open,
    onToggle,
    action,
    children
}: {
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
                <button className="row-toggle" data-nav-item aria-expanded={open}>
                    <ChevronRight size={13} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                    <span className="changes-group-title">{title}</span>
                    <Count className="changes-group-count" value={files.length} label={pluralize(files.length, 'file')} />
                </button>
                <span className="changes-group-action" onClick={event => event.stopPropagation()}>
                    {action}
                </span>
            </div>
            {open && children}
        </section>
    );
}

/**
 * The Changes tab of the right panel: the git changes of the worktree. The user stages and unstages files, opens
 * the diff of a file, writes a commit message and commits, and pushes the branch.
 */
export function ChangesPanel({
    worktree,
    repo,
    changes,
    error,
    fetched,
    refreshing,
    onReload,
    onOpenChange,
    onOpenAllChanges,
    onOpenFile,
    onSendToAgent
}: Props) {
    const overlap = useWorktreeOverlap(repo, worktree);
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
    const commit = () =>
        act('commit', async () => {
            const result = await api.commit(worktree, message, amend);
            setMessage('');
            setAmend(false);
            setNotice(`Committed ${result.hash}: ${result.summary}`);
            setTimeout(() => setNotice(undefined), 6000);
        });
    const discard = async (files: FileChange[]) => {
        let done = false;
        await act('discard', async () => {
            done = await confirmDiscard(worktree, files);
        });
        if (done) {
            setNotice(
                `Discarded the changes in ${files.length === 1 ? baseName(files[0].path) : `${files.length} files`}. You can get them back from the Trash.`
            );
            setTimeout(() => setNotice(undefined), 6000);
        }
    };
    const pull = () =>
        act('pull', async () => {
            await api.pull(worktree);
            setNotice('Pulled the upstream branch.');
            setTimeout(() => setNotice(undefined), 6000);
        });
    const push = () =>
        act('push', async () => {
            await api.push(worktree);
            setNotice('Pushed the branch.');
            setTimeout(() => setNotice(undefined), 6000);
        });
    const continueRebase = (skip: boolean) =>
        act(skip ? 'skip' : 'continue', async () => {
            const state = changes?.rebase;
            if (skip) {
                const ok = await confirmDialog({
                    title: state?.stopped ? `Skip the commit ${state.stopped.hash}?` : 'Skip the commit?',
                    message: 'The changes of this commit are not in the branch after the rebase.',
                    confirmLabel: 'Skip',
                    danger: true
                });
                if (!ok) return;
            }
            const result = skip ? await api.rebaseSkip(worktree) : await api.rebaseContinue(worktree);
            gitChanged();
            await afterRebase(worktree, result, changes?.upstream);
        });
    const abortRebase = () =>
        act('abort', async () => {
            const ok = await confirmDialog({
                title: 'Abort the rebase?',
                message: 'Git runs "git rebase --abort". The branch gets its commits from before the rebase again. The resolutions that you made are lost.',
                confirmLabel: 'Abort rebase',
                danger: true
            });
            if (ok) await api.rebaseAbort(worktree);
        });
    const sendConflict = (send: (prompt: string) => void) =>
        act('agent', async () => {
            send(await conflictPromptFor(worktree, overlap));
        });
    const forcePush = (upstream: string) =>
        act('forcePush', async () => {
            if (await confirmForcePush(worktree, upstream)) {
                setNotice('Pushed the branch.');
                setTimeout(() => setNotice(undefined), 6000);
            }
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
    const toggleGroup = (id: string) =>
        setClosed(set => {
            const next = new Set(set);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    if (!changes) {
        return error ? <div className="panel-message">{error}</div> : <SkeletonRows count={5} dot={false} label="Loading the changes" />;
    }

    const staged = changes.staged;
    const rebase = changes.rebase;
    const canCommit = message.trim() !== '' && (staged.length > 0 || amend) && !busy;
    const upstream = changes.upstream;
    const diverged = hasDiverged(changes) && !rebase;
    const canPush = !!changes.branch && !changes.unborn && (changes.ahead > 0 || !changes.upstream) && !rebase && !diverged;
    const spinner = (label: string, icon: ReactNode) => (busy === label ? <LoaderCircle size={13} className="spin" /> : icon);

    const row = (change: FileChange, side: ChangeSide | 'conflict') => {
        const inIndex = side === 'staged';
        const open = () => onOpenChange(change, side === 'conflict' ? 'unstaged' : side);
        return (
            <div
                key={`${side}:${change.path}`}
                className="change-row"
                title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
                tabIndex={0}
                role="button"
                aria-label={change.path}
                data-nav-item
                onClick={open}
                onKeyDown={itemKeys(open)}
            >
                <span className={`change-letter ${change.kind}`}>{changeLetter(change.kind)}</span>
                <span className={`change-name${change.kind === 'deleted' ? ' deleted' : ''}`}>{baseName(change.path)}</span>
                <span className="change-dir">{parentPath(change.path)}</span>
                <span className="change-actions" onClick={event => event.stopPropagation()}>
                    {change.kind !== 'deleted' && (
                        <IconButton size="sm" icon={<FileText size={13} strokeWidth={1.7} />} label="Open the file" onClick={() => onOpenFile(change.path)} />
                    )}
                    {side === 'unstaged' && (
                        <IconButton
                            size="sm"
                            icon={<Undo2 size={13} strokeWidth={1.8} />}
                            label="Discard the changes"
                            disabled={!!busy}
                            onClick={() => void discard([change])}
                        />
                    )}
                    {inIndex ? (
                        <IconButton
                            size="sm"
                            icon={<Minus size={14} strokeWidth={2} />}
                            label="Unstage"
                            disabled={!!busy}
                            onClick={() => void unstage([change.path])}
                        />
                    ) : (
                        <IconButton
                            size="sm"
                            icon={side === 'conflict' ? <Check size={14} strokeWidth={2} /> : <Plus size={14} strokeWidth={2} />}
                            label={side === 'conflict' ? 'Mark as resolved (stage)' : 'Stage'}
                            disabled={!!busy}
                            onClick={() => void stage([change.path])}
                        />
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
                <span className="changes-branch-name" title={changes.upstream ? `Tracks ${changes.upstream}` : 'No upstream branch'}>
                    {changes.branch ?? 'Detached HEAD'}
                </span>
                {changes.ahead > 0 && (
                    <span className="changes-ab" title={`${changes.ahead} commits to push`}>
                        <ArrowUp size={12} strokeWidth={2} />
                        {changes.ahead}
                    </span>
                )}
                {changes.behind > 0 && (
                    <span className="changes-ab" title={`${changes.behind} commits to pull`}>
                        <ArrowDown size={12} strokeWidth={2} />
                        {changes.behind}
                    </span>
                )}
                <span className="header-spacer" />
                {changes.upstream && changes.behind === 0 && !rebase && (
                    <Button
                        disabled={!!busy}
                        title={`Pull from ${changes.upstream} with a fast-forward only${changes.behind ? `: ${changes.behind} new commits` : ''}`}
                        icon={busy === 'pull' ? <LoaderCircle size={13} className="spin" /> : <Download size={13} strokeWidth={1.8} />}
                        onClick={() => void pull()}
                    >
                        Pull
                    </Button>
                )}
                {canPush && (
                    <Button
                        disabled={!!busy}
                        title={changes.upstream ? `Push to ${changes.upstream}` : 'Push, and track origin'}
                        icon={busy === 'push' ? <LoaderCircle size={13} className="spin" /> : <Upload size={13} strokeWidth={1.8} />}
                        onClick={() => void push()}
                    >
                        Push
                    </Button>
                )}
                {!clean && (
                    <Button
                        title="Show the diffs of all changed files in one list"
                        icon={<GitCompareArrows size={13} strokeWidth={1.8} />}
                        onClick={onOpenAllChanges}
                    >
                        View all
                    </Button>
                )}
                <RefreshButton
                    label={`Refresh, and check the remote for new commits${fetched?.at ? `. Last check: ${new Date(fetched.at).toLocaleTimeString()}` : ''}`}
                    refreshing={refreshing}
                    onRefresh={onReload}
                />
            </div>
            {rebase && (
                <div className="changes-rebase" role="status">
                    <div className="changes-rebase-text">
                        <strong>Rebase in progress</strong>
                        <span>{rebaseText(rebase)}</span>
                        {rebase.stopped && (
                            <span className="changes-rebase-commit" title={rebase.stopped.subject}>
                                Stopped at {rebase.stopped.hash} {rebase.stopped.subject}
                            </span>
                        )}
                        <span className="changes-rebase-hint">
                            {changes.conflicted.length
                                ? `Resolve the conflicts in ${pluralize(changes.conflicted.length, 'file')}, and stage the files. Then continue.`
                                : 'Stage the resolved files. Then continue.'}
                        </span>
                    </div>
                    <div className="changes-rebase-actions">
                        <Button variant="link-danger" disabled={!!busy} onClick={() => void abortRebase()}>
                            Abort
                        </Button>
                        <Button disabled={!!busy} title="Skip the commit that stopped the rebase" onClick={() => void continueRebase(true)}>
                            Skip
                        </Button>
                        {onSendToAgent && changes.conflicted.length > 0 && (
                            <Button
                                disabled={!!busy}
                                title="Send the conflict, the commits of both sides, and the overlap with other worktrees to the agent"
                                icon={spinner('agent', <Bot size={13} strokeWidth={1.6} />)}
                                onClick={() => void sendConflict(onSendToAgent)}
                            >
                                Send to agent
                            </Button>
                        )}
                        <Button
                            variant="primary"
                            disabled={!!busy || changes.conflicted.length > 0}
                            title={changes.conflicted.length ? 'Resolve and stage the files with conflicts first' : 'Run "git rebase --continue"'}
                            icon={spinner('continue', <GitMerge size={13} strokeWidth={1.8} />)}
                            onClick={() => void continueRebase(false)}
                        >
                            Continue
                        </Button>
                    </div>
                </div>
            )}
            {diverged && upstream && (
                <div className="changes-behind">
                    <GitCompareArrows size={14} strokeWidth={2} />
                    <span>The branch and {upstream} have different commits, for example after a rebase.</span>
                    <span className="header-spacer" />
                    <Button
                        disabled={!!busy}
                        title={`Replace ${upstream} with the commits of the branch`}
                        icon={spinner('forcePush', <Upload size={13} strokeWidth={1.8} />)}
                        onClick={() => void forcePush(upstream)}
                    >
                        Push with --force-with-lease
                    </Button>
                </div>
            )}
            {changes.behind > 0 && changes.upstream && !diverged && !rebase && (
                <div className="changes-behind">
                    <ArrowDown size={14} strokeWidth={2} />
                    <span>
                        {changes.behind} new {changes.behind === 1 ? 'commit' : 'commits'} on {changes.upstream}
                    </span>
                    <span className="header-spacer" />
                    <Button
                        disabled={!!busy}
                        icon={busy === 'pull' ? <LoaderCircle size={13} className="spin" /> : <Download size={13} strokeWidth={1.8} />}
                        onClick={() => void pull()}
                    >
                        Pull
                    </Button>
                </div>
            )}
            {fetched?.error && (
                <div className="changes-fetch-error" title={fetched.error}>
                    ShipWarden cannot check {changes.upstream ?? 'the remote'} for new commits. Pull and push can still work in a terminal.
                </div>
            )}
            {overlap && <OverlapNote overlap={overlap} />}

            {!rebase && (
                <div className="changes-commit">
                    <TextArea
                        className="changes-message"
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
                        <Checkbox
                            label="Amend"
                            title="Replace the last commit with the staged changes and this message"
                            checked={amend}
                            disabled={changes.unborn}
                            onChange={checked => void toggleAmend(checked)}
                        />
                        <span className="header-spacer" />
                        <DraftButton
                            worktree={worktree}
                            kind="commit"
                            amend={amend}
                            current={message}
                            disabled={(staged.length === 0 && !amend) || !!busy}
                            onDraft={setMessage}
                            onError={setActionError}
                        />
                        <Button
                            variant="primary"
                            disabled={!canCommit}
                            onClick={() => void commit()}
                            title={staged.length === 0 && !amend ? 'Stage changes first' : message.trim() ? undefined : 'Type a commit message'}
                            icon={busy === 'commit' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} strokeWidth={2} />}
                        >
                            {amend ? 'Amend commit' : staged.length ? `Commit ${staged.length} ${staged.length === 1 ? 'file' : 'files'}` : 'Commit'}
                        </Button>
                    </div>
                </div>
            )}

            {(actionError || error) && <div className="form-error changes-error">{actionError ?? error}</div>}
            {notice && <div className="changes-notice">{notice}</div>}

            <div className="changes-list" onKeyDown={moveListFocus}>
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
                        action={
                            <Button variant="link" disabled={!!busy} onClick={() => void unstage(staged.map(change => change.path))}>
                                Unstage all
                            </Button>
                        }
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
                        action={
                            <>
                                <Button variant="link-danger" disabled={!!busy} onClick={() => void discard(changes.unstaged)}>
                                    Discard all
                                </Button>
                                <Button variant="link" disabled={!!busy} onClick={() => void stage(changes.unstaged.map(change => change.path))}>
                                    Stage all
                                </Button>
                            </>
                        }
                    >
                        {changes.unstaged.map(change => row(change, 'unstaged'))}
                    </Group>
                )}
            </div>
        </div>
    );
}
