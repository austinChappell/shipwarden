import { useEffect, useRef, useState } from 'react';
import { History, LoaderCircle, X } from 'lucide-react';
import { checkpointTitle, type Checkpoint, type RewindPreview, type RewindResult } from '@shared/checkpoints';
import { pluralize } from '@shared/format';
import { gitChanged } from '../git/git-store';
import { errorText } from '../util';
import { Button, Checkbox, IconButton } from '../components/ui';
import { useModal } from '../components/use-modal';
import { checkpointsChanged } from './checkpoint-queries';

const api = window.shipwarden;

const ACTION_LABELS: Record<RewindPreview['files'][number]['action'], string> = {
    restore: 'Restore',
    revert: 'Revert',
    remove: 'Remove'
};

interface Props {
    worktree: string;
    checkpoint: Checkpoint;
    onClose(): void;
    onDone(result: RewindResult): void;
}

/** The class of one line of a unified diff, for its color. */
function lineClass(line: string): string | undefined {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) return 'meta';
    if (line.startsWith('@@')) return 'hunk';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return undefined;
}

/**
 * The dialog that rewinds a worktree to a checkpoint. It shows the diff first. The user can also reset the commits
 * after the checkpoint and tell the agent about the rewind. Both choices are off by default.
 */
export function RewindDialog({ worktree, checkpoint, onClose, onDone }: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const [preview, setPreview] = useState<RewindPreview>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [showDiff, setShowDiff] = useState(false);
    const [reset, setReset] = useState(false);
    const [tellAgent, setTellAgent] = useState(false);

    useEffect(() => {
        let live = true;
        api.checkpoints.preview(worktree, checkpoint.ref, checkpoint.session).then(
            value => live && setPreview(value),
            err => live && setError(errorText(err))
        );
        return () => {
            live = false;
        };
    }, [worktree, checkpoint.ref, checkpoint.session]);

    const removes = preview?.files.filter(file => file.action === 'remove').length ?? 0;
    const nothingToDo = !!preview && preview.files.length === 0 && !reset;

    const submit = async () => {
        setBusy(true);
        setError(undefined);
        try {
            const result = await api.checkpoints.rewind(worktree, checkpoint.ref, { reset, tellAgent });
            gitChanged();
            void checkpointsChanged(worktree);
            onDone(result);
        } catch (err) {
            setError(errorText(err));
            setBusy(false);
        }
    };

    const title = checkpoint.kind === 'prompt' ? 'Rewind to before this prompt' : 'Rewind to this checkpoint';

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
            <div
                ref={dialog}
                className="modal rewind-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onKeyDown={event => {
                    if (event.key === 'Escape' && !busy) onClose();
                }}
            >
                <header className="modal-header">
                    <History size={15} strokeWidth={1.8} />
                    <h2>{title}</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close" title="Close (Esc)" disabled={busy} onClick={onClose} />
                </header>
                <div className="modal-body">
                    <p className="rewind-prompt" title={checkpointTitle(checkpoint)}>
                        {checkpointTitle(checkpoint)}
                    </p>
                    {!preview && !error && (
                        <p className="panel-note">
                            <LoaderCircle size={13} className="spin" /> Comparing the files with the checkpoint…
                        </p>
                    )}
                    {preview && preview.files.length === 0 && <p className="panel-note">The files are the same as in the checkpoint.</p>}
                    {preview && preview.files.length > 0 && (
                        <>
                            <div className="section-title rewind-section">
                                <span>{pluralize(preview.files.length, 'file')} change</span>
                                <Button variant="link" onClick={() => setShowDiff(value => !value)}>
                                    {showDiff ? 'Hide the diff' : 'Show the diff'}
                                </Button>
                            </div>
                            <ul className="rewind-files">
                                {preview.files.map(file => (
                                    <li key={file.path} className="rewind-file">
                                        <span className={`rewind-action ${file.action}`}>{ACTION_LABELS[file.action]}</span>
                                        <span className="rewind-path" title={file.path}>
                                            {file.path}
                                        </span>
                                        <span className="rewind-count">
                                            {file.binary ? (
                                                'Binary'
                                            ) : (
                                                <>
                                                    <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
                                                </>
                                            )}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            {showDiff && (
                                <pre className="rewind-patch">
                                    {preview.patch.split('\n').map((line, index) => (
                                        // biome-ignore lint/suspicious/noArrayIndexKey: The lines of the diff do not change while the dialog shows.
                                        <span key={index} className={lineClass(line)}>
                                            {line}
                                            {'\n'}
                                        </span>
                                    ))}
                                    {preview.truncated && <span className="meta">The diff is too long to show in full.</span>}
                                </pre>
                            )}
                            {removes > 0 && (
                                <p className="panel-note">
                                    The rewind deletes {pluralize(removes, 'new file')} that {removes === 1 ? 'is' : 'are'} not in the checkpoint. Files that
                                    .gitignore ignores stay.
                                </p>
                            )}
                        </>
                    )}
                    {preview && preview.commits.length > 0 && (
                        <Checkbox
                            checked={reset}
                            onChange={setReset}
                            label={`Also remove ${pluralize(preview.commits.length, 'commit')} after the checkpoint`}
                            description={`git reset moves the branch back. Without it, the commits stay, and the files show their reverse as uncommitted changes. Commits: ${preview.commits
                                .map(commit => commit.subject)
                                .join(', ')}`}
                        />
                    )}
                    {preview?.headDiverged && (
                        <p className="panel-note">The branch moved to other commits since the checkpoint. The rewind restores only the files.</p>
                    )}
                    {preview?.agentRunning && (
                        <Checkbox
                            checked={tellAgent}
                            onChange={setTellAgent}
                            label="Tell the agent about the rewind"
                            description="Sends a short note to the agent terminal, so the agent reads the files again."
                        />
                    )}
                    {preview && (
                        <p className="panel-note">ShipWarden saves the current files first, so you can rewind back. Stop the agent before you rewind.</p>
                    )}
                    {error && (
                        <div className="form-error" role="alert">
                            {error}
                        </div>
                    )}
                </div>
                <footer className="modal-footer">
                    <Button onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button variant="danger-solid" disabled={busy || !preview || nothingToDo} onClick={() => void submit()}>
                        {busy ? 'Rewinding…' : 'Rewind'}
                    </Button>
                </footer>
            </div>
        </div>
    );
}
