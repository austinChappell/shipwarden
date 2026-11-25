import { GitCommitHorizontal } from 'lucide-react';
import type { GitChanges } from '@shared/git';
import { Button } from './ui';
import { localWorkWarnings } from './local-work';

/**
 * A warning in the Pull request tab: the worktree has commits that are not pushed, or changes that are not committed.
 * The pull request does not include this work. The warning does not block an action.
 */
export function LocalWorkNotice({ changes, onShowChanges }: { changes: GitChanges | undefined; onShowChanges?(): void }) {
    const warnings = changes ? localWorkWarnings(changes) : [];
    if (warnings.length === 0) return null;
    return (
        <div className="pr-conflict-banner pr-local-work" role="status">
            <GitCommitHorizontal size={16} strokeWidth={1.8} />
            <div className="pr-conflict-text">
                <strong>The pull request does not include all of your local work.</strong>
                {warnings.map(warning => (
                    <span key={warning}>{warning}</span>
                ))}
            </div>
            {onShowChanges && <Button onClick={onShowChanges}>Show changes</Button>}
        </div>
    );
}
