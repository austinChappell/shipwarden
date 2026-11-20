import { useState } from 'react';
import { Bot, ChevronRight, History } from 'lucide-react';
import { checkpointTitle, groupCheckpoints, type Checkpoint, type CheckpointFileStatus, type RewindResult } from '@shared/checkpoints';
import { pluralize } from '@shared/format';
import { EmptyState } from '../components/EmptyState';
import { Age, Button, RefreshButton, SkeletonRows } from '../components/ui';
import { errorText } from '../util';
import { useCheckpoints } from './checkpoint-queries';
import { RewindDialog } from './RewindDialog';

const STATUS_LETTERS: Record<CheckpointFileStatus, string> = { added: 'A', modified: 'M', deleted: 'D' };

interface Props {
    worktreePath: string;
}

/** The text of the result of a rewind, for example "Rewound 3 files. Removed 1 new file." */
function resultText(result: RewindResult): string {
    return [
        `Rewound ${pluralize(result.restored, 'file')}.`,
        result.removed > 0 ? `Removed ${pluralize(result.removed, 'new file')}.` : '',
        result.reset ? 'Moved the branch back.' : ''
    ]
        .filter(Boolean)
        .join(' ');
}

function CheckpointRow({ checkpoint, onRewind }: { checkpoint: Checkpoint; onRewind(): void }) {
    const [open, setOpen] = useState(false);
    const title = checkpointTitle(checkpoint);
    const files = checkpoint.files;
    return (
        <div className="checkpoint">
            <div className="checkpoint-line">
                <button
                    className={`process-toggle${files.length ? '' : ' empty'}`}
                    title={files.length ? `${open ? 'Hide' : 'Show'} the changed files` : 'No files changed after this checkpoint'}
                    disabled={!files.length}
                    onClick={() => setOpen(value => !value)}
                >
                    {files.length > 0 && <ChevronRight size={12} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />}
                </button>
                <span className={`checkpoint-title${checkpoint.kind === 'prompt' ? '' : ' muted'}`} title={title}>
                    {title}
                </span>
                <span className="checkpoint-meta" title="The files that changed after this checkpoint">
                    {pluralize(files.length, 'file')}
                </span>
                <Age date={new Date(checkpoint.at).toISOString()} plain />
                <Button
                    size="sm"
                    title={checkpoint.kind === 'prompt' ? 'Rewind the files to before this prompt' : 'Rewind the files to this checkpoint'}
                    onClick={onRewind}
                >
                    Rewind
                </Button>
            </div>
            {open && (
                <ul className="checkpoint-files">
                    {files.map(file => (
                        <li key={file.path} title={file.path}>
                            <span className={`checkpoint-status ${file.status}`}>{STATUS_LETTERS[file.status]}</span>
                            {file.path}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * The Checkpoints tab of the right panel. ShipWarden saves the files of the worktree at the start of each agent turn.
 * The tab lists the turns of each agent session, with the prompt and the changed files. "Rewind" restores the files.
 */
export function CheckpointsPanel({ worktreePath }: Props) {
    const query = useCheckpoints(worktreePath);
    const [target, setTarget] = useState<Checkpoint>();
    const [notice, setNotice] = useState<string>();
    const groups = groupCheckpoints(query.data ?? []);

    if (query.isPending) {
        return (
            <div className="processes-panel">
                <SkeletonRows count={4} dot={false} label="Loading checkpoints" />
            </div>
        );
    }

    return (
        <div className="processes-panel checkpoints-panel">
            <div className="processes-header">
                <span className="processes-summary">{query.data?.length ? pluralize(query.data.length, 'checkpoint') : 'No checkpoints'}</span>
                <RefreshButton size="sm" onRefresh={() => query.refetch()} />
            </div>
            {query.error && <div className="form-error">{errorText(query.error)}</div>}
            {notice && <p className="panel-note checkpoints-notice">{notice}</p>}
            {groups.length === 0 && !query.error && (
                <EmptyState icon={History} title="No checkpoints" size="compact">
                    ShipWarden saves the files of this worktree when an agent gets a prompt. The checkpoints show here for 7 days.
                </EmptyState>
            )}
            {groups.map(group => (
                <section key={group.session} className="processes-section">
                    <div className="section-title processes-terminal">
                        <Bot size={12} strokeWidth={1.8} />
                        <span>{group.agent ?? 'Agent'}</span>
                    </div>
                    {group.checkpoints.map(checkpoint => (
                        <CheckpointRow key={checkpoint.ref} checkpoint={checkpoint} onRewind={() => setTarget(checkpoint)} />
                    ))}
                </section>
            ))}
            {target && (
                <RewindDialog
                    worktree={worktreePath}
                    checkpoint={target}
                    onClose={() => setTarget(undefined)}
                    onDone={result => {
                        setTarget(undefined);
                        setNotice(resultText(result));
                    }}
                />
            )}
        </div>
    );
}
