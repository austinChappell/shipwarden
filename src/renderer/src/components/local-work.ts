import { pluralize } from '@shared/format';
import { changeCount, type GitChanges } from '@shared/git';

/**
 * Returns the warnings about local work that the remote does not have: commits that are not pushed, and files with
 * changes that are not committed. An empty list means that the remote has all the work.
 * The commits count only when the upstream branch is on the remote. Without it, the Pull request tab shows that the
 * branch is not pushed.
 */
export function localWorkWarnings(changes: Pick<GitChanges, 'upstream' | 'upstreamGone' | 'ahead' | 'staged' | 'unstaged' | 'conflicted'>): string[] {
    const warnings: string[] = [];
    if (changes.upstream && !changes.upstreamGone && changes.ahead > 0) {
        warnings.push(`${pluralize(changes.ahead, 'commit')} ${changes.ahead === 1 ? 'is' : 'are'} not pushed to ${changes.upstream}.`);
    }
    const files = changeCount(changes);
    if (files > 0) {
        warnings.push(`${pluralize(files, 'file')} ${files === 1 ? 'has' : 'have'} changes that are not committed.`);
    }
    return warnings;
}
