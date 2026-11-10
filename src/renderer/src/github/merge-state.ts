import { hostLabel, type MergeMethod, type PullRequest, type PullRequestChange } from '@shared/github';
import type { MergeCondition } from '../components/PullRequestSummary';

export const MERGE_LABELS: Record<MergeMethod, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };

/** The short text of the merge button in the narrow side column of the Overview tab. */
export const SHORT_MERGE_LABELS: Record<MergeMethod, string> = { merge: 'Merge', squash: 'Squash', rebase: 'Rebase' };

/** True when the pull request is open and GitHub reports conflicts with the base branch. */
export function hasConflicts(pr: PullRequest): boolean {
    return pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING';
}

export function reviewText(pr: PullRequest): string {
    switch (pr.reviewDecision) {
        case 'APPROVED': return 'Approved';
        case 'CHANGES_REQUESTED': return 'Changes requested';
        case 'REVIEW_REQUIRED': return 'Review required';
        default: return 'No review decision';
    }
}

/** Returns the reason that the merge cannot start, or undefined when nothing blocks it. */
export function mergeBlocker(pr: PullRequest): string | undefined {
    if (pr.state !== 'OPEN') return 'The pull request is not open.';
    if (pr.isDraft) return 'The pull request is a draft.';
    if (pr.mergeable === 'CONFLICTING') return 'The branch has conflicts with the base branch.';
    if (pr.mergeable === 'UNKNOWN') return `${hostLabel(pr.host)} is still checking whether the branch can merge.`;
    if (pr.mergeStateStatus === 'BLOCKED') return 'Branch rules block the merge, for example required reviews or checks.';
    if (pr.mergeStateStatus === 'BEHIND') return 'The branch is behind the base branch.';
    return undefined;
}

/**
 * Returns the merge method for the button. The choice of the user applies when the host allows it.
 * Else the default method of the repository applies. Else the first allowed method applies.
 */
export function selectMergeMethod(pr: PullRequest, chosen: MergeMethod | undefined): MergeMethod | undefined {
    if (chosen && pr.allowedMergeMethods.includes(chosen)) return chosen;
    return pr.allowedMergeMethods.includes(pr.defaultMergeMethod) ? pr.defaultMergeMethod : pr.allowedMergeMethods[0];
}

/** True when the user can do a merge action on the pull request. Then the panel shows the merge card. */
export function canActOnMerge(pr: PullRequest): boolean {
    return !!(pr.autoMerge || pr.viewerCanMerge || pr.viewerCanEnableAutoMerge || pr.viewerCanUpdate);
}

/** True when the panel shows a footer: the review and merge cards, or the button that reopens the pull request. */
export function hasFooter(pr: PullRequest): boolean {
    return pr.state === 'OPEN' || (pr.state === 'CLOSED' && pr.viewerCanUpdate);
}

/** The title of the merge card of the Overview tab. */
export function mergeCardTitle(conditions: MergeCondition[]): string {
    return conditions.every(item => item.state === 'ok') ? 'Ready to merge' : 'Ready to merge?';
}

/**
 * The text of the button that turns on auto-merge.
 * In the Overview tab, when only a required approval blocks the merge, the text tells that the merge waits for the approval.
 */
export function autoMergeButtonText(pr: PullRequest, conditions: MergeCondition[], overview: boolean): string {
    const onlyReviewBlocks = conditions.every(item => item.state === 'ok' || item.text === 'Approving review required');
    return overview && onlyReviewBlocks && pr.reviewDecision === 'REVIEW_REQUIRED' ? 'Auto-merge on approval' : 'Enable auto-merge';
}

/** The properties of the main merge button. */
export interface MergeButtonState {
    /** The text of the button. Undefined shows the name of the method. */
    label?: string;
    disabled: boolean;
    /** The text that tells why the merge cannot start. */
    title?: string;
    /** True when the button merges. False when it turns on auto-merge. */
    merges: boolean;
}

/** Returns the state of the main merge button. A user who cannot merge gets a button that turns on auto-merge. */
export function mergeButtonState(pr: PullRequest, method: MergeMethod, overview: boolean, busy: boolean): MergeButtonState {
    const blocker = mergeBlocker(pr);
    if (!pr.viewerCanMerge) return { label: 'Enable auto-merge', disabled: busy, title: undefined, merges: false };
    return { label: overview ? SHORT_MERGE_LABELS[method] : undefined, disabled: busy || !!blocker, title: blocker, merges: true };
}

/** The question before a merge. */
export function mergeConfirmTitle(pr: PullRequest, method: MergeMethod): string {
    return `${MERGE_LABELS[method]}: pull request #${pr.number} into ${pr.baseRefName}?`;
}

/** The question and the button text before the user turns auto-merge on or off. */
export function autoMergeConfirm(pr: PullRequest, method: MergeMethod | null): { title: string; confirmLabel: string } {
    if (method) {
        return {
            title: `Turn on auto-merge for pull request #${pr.number}? GitHub merges it into ${pr.baseRefName} with "${MERGE_LABELS[method]}" when all the requirements pass.`,
            confirmLabel: 'Enable auto-merge'
        };
    }
    return { title: `Turn off auto-merge for pull request #${pr.number}?`, confirmLabel: 'Disable auto-merge' };
}

/** The question and the button text before the user closes or reopens a pull request. */
export function stateConfirm(pr: PullRequest, state: 'open' | 'closed'): { title: string; confirmLabel: string } {
    return state === 'closed'
        ? { title: `Close pull request #${pr.number} without a merge?`, confirmLabel: 'Close pull request' }
        : { title: `Reopen pull request #${pr.number}?`, confirmLabel: 'Reopen' };
}

/** The question and the button text before the user converts a pull request to a draft, or marks it as ready. */
export function draftConfirm(pr: PullRequest, draft: boolean): { title: string; confirmLabel: string } {
    return draft
        ? { title: `Convert pull request #${pr.number} to a draft?`, confirmLabel: 'Convert to draft' }
        : { title: `Mark pull request #${pr.number} as ready for review?`, confirmLabel: 'Ready for review' };
}

/** Returns the change for a new title and description. A field that did not change is undefined. */
export function descriptionChange(pr: PullRequest, title: string, body: string): PullRequestChange {
    return {
        kind: 'details',
        title: title === pr.title ? undefined : title,
        body: body === pr.body ? undefined : body
    };
}
