import { FileWarning } from 'lucide-react';
import { overlapChipText, overlapTooltip, worktreeName, type WorktreeOverlap } from '@shared/worktree-overlap';
import { pluralize } from '@shared/format';
import { Chip } from './ui';

/** The warning chip of a worktree that changes the same files as a different worktree. The tooltip lists the files. */
export function OverlapChip({ overlap }: { overlap: WorktreeOverlap }) {
    return (
        <Chip tone="warning" icon={<FileWarning size={12} strokeWidth={1.8} aria-hidden="true" />} title={overlapTooltip(overlap)}>
            {overlapChipText(overlap)}
        </Chip>
    );
}

/**
 * The overlap of a worktree in the Changes panel: the chip, and a list of the shared files of each other worktree.
 * The list opens with a click on the chip.
 */
export function OverlapNote({ overlap }: { overlap: WorktreeOverlap }) {
    return (
        <details className="changes-overlap">
            <summary aria-label={`${overlapChipText(overlap)}: ${pluralize(overlap.files.length, 'file')}`}>
                <OverlapChip overlap={overlap} />
            </summary>
            <p className="changes-overlap-hint">A merge of these branches can have conflicts in these files.</p>
            {overlap.peers.map(peer => (
                <section key={peer.path} className="changes-overlap-peer">
                    <span className="changes-overlap-name" title={peer.path}>
                        {worktreeName(peer)}
                    </span>
                    {/* biome-ignore lint/a11y/noRedundantRoles: Safari removes the list role when the list has no bullets. */}
                    <ul role="list">
                        {peer.files.map(file => (
                            <li key={file} title={file}>
                                {file}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </details>
    );
}
