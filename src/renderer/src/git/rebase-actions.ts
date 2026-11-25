import { hasDiverged, hasUncommittedChanges, type GitChanges, type RebaseResult } from '@shared/git';
import type { PromptTemplate } from '@shared/prompt-templates';
import { CONFLICT_TEMPLATE_ID, rebaseConflictPrompt } from '@shared/rebase-conflict';
import type { WorktreeOverlap } from '@shared/worktree-overlap';
import { alertDialog, confirmDialog } from '../components/ConfirmDialog';
import { loadPromptTemplates } from '../prompts/prompt-queries';
import { branchPushed } from '../github/pull-request-mutations';
import { gitChanged } from './git-store';

const api = window.shipwarden.git;

interface RebaseOptions {
    /** The branch to rebase onto, without the remote, for example "main". Without it, the default branch of "origin". */
    onto?: string;
    /** Shows the Changes tab of the worktree: for uncommitted changes, a rebase in progress, and a conflict. */
    onShowChanges?(): void;
}

/** The title and the text of the question before a rebase. */
export function rebaseConfirm(changes: Pick<GitChanges, 'branch' | 'upstream' | 'ahead' | 'behind'>, target: string): { title: string; message: string } {
    const diverged = hasDiverged(changes)
        ? `\n\n${changes.upstream} has ${changes.behind} ${changes.behind === 1 ? 'commit' : 'commits'} that the branch does not have. The rebase does not include them. After a rebase in the past, these are the old copies of your commits.`
        : '';
    return {
        title: `Rebase "${changes.branch}" onto ${target}?`,
        message: `ShipWarden fetches origin, then runs "git rebase ${target}". When a commit has a conflict, the rebase stops and the Changes tab shows the files. ShipWarden does not push.${diverged}`
    };
}

/** The title and the text of the question before a push with "--force-with-lease". */
export function forcePushConfirm(upstream: string, onto?: string): { title: string; message: string } {
    return {
        title: onto ? `Rebased onto ${onto}. Push with --force-with-lease?` : `Push to ${upstream} with --force-with-lease?`,
        message: `The push replaces ${upstream} with the commits of your branch. The push stops if ${upstream} got new commits after the rebase started.`
    };
}

/**
 * Asks the user, then pushes the branch with "--force-with-lease". Resolves true after the push. ShipWarden never
 * pushes a rebased branch without this question.
 */
export async function confirmForcePush(worktree: string, upstream: string, onto?: string): Promise<boolean> {
    const ok = await confirmDialog({ ...forcePushConfirm(upstream, onto), confirmLabel: 'Push with --force-with-lease', cancelLabel: 'Not now', danger: true });
    if (!ok) return false;
    try {
        await api.pushWithLease(worktree);
        void branchPushed(worktree);
    } finally {
        gitChanged();
    }
    return true;
}

/**
 * Tells the user the result of a rebase step. After a complete rebase that changed the branch, it offers the push.
 * After a conflict, it shows the Changes tab.
 */
export async function afterRebase(worktree: string, result: RebaseResult, upstream: string | undefined, onShowChanges?: () => void): Promise<void> {
    if (result.status === 'conflict') {
        onShowChanges?.();
        return;
    }
    if (!result.changed) {
        await alertDialog(`The branch already has all commits of ${result.onto}.`, 'The rebase changed nothing.');
        return;
    }
    if (upstream) await confirmForcePush(worktree, upstream, result.onto);
    else await alertDialog(`Rebased onto ${result.onto}.`, 'The branch has no upstream branch yet. Push it from the Changes tab.');
}

/**
 * "Rebase onto": checks the worktree, asks the user, fetches origin, and rebases. It refuses uncommitted changes and
 * does not stash them. Throws the errors of git.
 */
export async function startRebase(worktree: string, options: RebaseOptions = {}): Promise<void> {
    const changes = await api.changes(worktree);
    if (changes.rebase) {
        options.onShowChanges?.();
        return;
    }
    if (!changes.branch) throw new Error('The worktree has no branch (a detached HEAD).');
    if (hasUncommittedChanges(changes)) {
        const title = 'Commit or stash your changes first';
        const message =
            'The worktree has uncommitted changes. ShipWarden does not rebase a worktree with uncommitted changes, and it does not stash them for you.';
        if (!options.onShowChanges) {
            await alertDialog(title, message);
        } else if (await confirmDialog({ title, message, confirmLabel: 'Show changes' })) {
            options.onShowChanges();
        }
        return;
    }
    const branch = options.onto ?? (await api.defaultBranch(worktree));
    const target = branch ? `origin/${branch}` : 'the default branch of origin';
    if (!(await confirmDialog({ ...rebaseConfirm(changes, target), confirmLabel: 'Rebase' }))) return;
    let result: RebaseResult;
    try {
        result = await api.rebase(worktree, options.onto);
    } finally {
        gitChanged();
    }
    await afterRebase(worktree, result, changes.upstream, options.onShowChanges);
}

/**
 * Makes the agent prompt for the conflict of the rebase in progress. A prompt template with the ID "pr-conflict"
 * replaces the default text.
 */
export async function conflictPromptFor(worktree: string, overlap: WorktreeOverlap | undefined): Promise<string> {
    const [input, templates] = await Promise.all([api.rebaseConflict(worktree), loadPromptTemplates().catch((): PromptTemplate[] => [])]);
    return rebaseConflictPrompt(input, overlap, templates.find(template => template.id === CONFLICT_TEMPLATE_ID)?.prompt);
}
