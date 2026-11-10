import { describe, expect, it } from 'vitest';
import type { PullRequest } from '@shared/github';
import {
    autoMergeButtonText,
    autoMergeConfirm,
    canActOnMerge,
    descriptionChange,
    draftConfirm,
    hasConflicts,
    hasFooter,
    mergeBlocker,
    mergeButtonState,
    mergeCardTitle,
    mergeConfirmTitle,
    reviewText,
    selectMergeMethod,
    stateConfirm
} from './merge-state';

function pr(parts: Partial<PullRequest> = {}): PullRequest {
    return {
        number: 7,
        title: 'Fix login',
        body: 'Text',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        baseRefName: 'main',
        reviewDecision: null,
        allowedMergeMethods: ['merge', 'squash', 'rebase'],
        defaultMergeMethod: 'squash',
        autoMerge: null,
        viewerCanMerge: true,
        viewerCanEnableAutoMerge: false,
        viewerCanUpdate: false,
        ...parts
    } as PullRequest;
}

describe('hasConflicts', () => {
    it('is true for an open pull request with conflicts', () => {
        expect(hasConflicts(pr({ mergeable: 'CONFLICTING' }))).toBe(true);
    });

    it('is false for a closed pull request with conflicts', () => {
        expect(hasConflicts(pr({ state: 'CLOSED', mergeable: 'CONFLICTING' }))).toBe(false);
    });
});

describe('reviewText', () => {
    it('returns the text of each review decision', () => {
        expect(reviewText(pr({ reviewDecision: 'APPROVED' }))).toBe('Approved');
        expect(reviewText(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('Changes requested');
        expect(reviewText(pr({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe('Review required');
        expect(reviewText(pr())).toBe('No review decision');
    });
});

describe('mergeBlocker', () => {
    it('returns undefined when nothing blocks the merge', () => {
        expect(mergeBlocker(pr())).toBeUndefined();
    });

    it('returns the first reason in order of importance', () => {
        expect(mergeBlocker(pr({ state: 'CLOSED', isDraft: true }))).toBe('The pull request is not open.');
        expect(mergeBlocker(pr({ isDraft: true, mergeable: 'CONFLICTING' }))).toBe('The pull request is a draft.');
        expect(mergeBlocker(pr({ mergeable: 'CONFLICTING' }))).toBe('The branch has conflicts with the base branch.');
        expect(mergeBlocker(pr({ mergeStateStatus: 'BLOCKED' }))).toMatch(/^Branch rules block the merge/);
        expect(mergeBlocker(pr({ mergeStateStatus: 'BEHIND' }))).toBe('The branch is behind the base branch.');
    });

    it('names the host while the host checks the branch', () => {
        expect(mergeBlocker(pr({ mergeable: 'UNKNOWN' }))).toBe('GitHub is still checking whether the branch can merge.');
        expect(mergeBlocker(pr({ mergeable: 'UNKNOWN', host: 'azure' }))).toMatch(/^Azure/);
    });
});

describe('selectMergeMethod', () => {
    it('uses the choice of the user when the host allows it', () => {
        expect(selectMergeMethod(pr(), 'rebase')).toBe('rebase');
    });

    it('uses the default method when the user made no allowed choice', () => {
        expect(selectMergeMethod(pr(), undefined)).toBe('squash');
        expect(selectMergeMethod(pr({ allowedMergeMethods: ['merge', 'squash'] }), 'rebase')).toBe('squash');
    });

    it('uses the first allowed method when the host does not allow the default method', () => {
        expect(selectMergeMethod(pr({ allowedMergeMethods: ['rebase', 'merge'] }), undefined)).toBe('rebase');
    });

    it('returns undefined when the host allows no method', () => {
        expect(selectMergeMethod(pr({ allowedMergeMethods: [] }), 'merge')).toBeUndefined();
    });
});

describe('canActOnMerge', () => {
    it('is false when the user has no merge permission', () => {
        expect(canActOnMerge(pr({ viewerCanMerge: false }))).toBe(false);
    });

    it('is true when auto-merge is on or when the user can merge or change the pull request', () => {
        expect(canActOnMerge(pr({ viewerCanMerge: false, autoMerge: { method: 'merge', enabledBy: null } as PullRequest['autoMerge'] }))).toBe(true);
        expect(canActOnMerge(pr({ viewerCanMerge: false, viewerCanEnableAutoMerge: true }))).toBe(true);
        expect(canActOnMerge(pr({ viewerCanMerge: false, viewerCanUpdate: true }))).toBe(true);
    });
});

describe('hasFooter', () => {
    it('shows a footer for an open pull request', () => {
        expect(hasFooter(pr())).toBe(true);
    });

    it('shows a footer for a closed pull request only when the user can reopen it', () => {
        expect(hasFooter(pr({ state: 'CLOSED' }))).toBe(false);
        expect(hasFooter(pr({ state: 'CLOSED', viewerCanUpdate: true }))).toBe(true);
    });

    it('shows no footer for a merged pull request', () => {
        expect(hasFooter(pr({ state: 'MERGED', viewerCanUpdate: true }))).toBe(false);
    });
});

describe('mergeCardTitle', () => {
    it('adds a question mark when a condition does not pass', () => {
        expect(mergeCardTitle([{ state: 'ok', text: 'a' }])).toBe('Ready to merge');
        expect(
            mergeCardTitle([
                { state: 'ok', text: 'a' },
                { state: 'wait', text: 'b' }
            ])
        ).toBe('Ready to merge?');
    });
});

describe('autoMergeButtonText', () => {
    const waitForReview = [
        { state: 'ok' as const, text: 'No conflicts with main' },
        { state: 'wait' as const, text: 'Approving review required' }
    ];

    it('tells that the merge waits for an approval when only the review blocks it', () => {
        expect(autoMergeButtonText(pr({ reviewDecision: 'REVIEW_REQUIRED' }), waitForReview, true)).toBe('Auto-merge on approval');
    });

    it('uses the default text outside the Overview tab', () => {
        expect(autoMergeButtonText(pr({ reviewDecision: 'REVIEW_REQUIRED' }), waitForReview, false)).toBe('Enable auto-merge');
    });

    it('uses the default text when a different condition blocks the merge', () => {
        const conditions = [...waitForReview, { state: 'fail' as const, text: '1 of 2 checks failed' }];
        expect(autoMergeButtonText(pr({ reviewDecision: 'REVIEW_REQUIRED' }), conditions, true)).toBe('Enable auto-merge');
    });
});

describe('mergeButtonState', () => {
    it('merges with the method name in the panel', () => {
        expect(mergeButtonState(pr(), 'squash', false, false)).toEqual({ label: undefined, disabled: false, title: undefined, merges: true });
    });

    it('uses the short label in the Overview tab', () => {
        expect(mergeButtonState(pr(), 'squash', true, false).label).toBe('Squash');
    });

    it('turns off the button and tells why when a condition blocks the merge', () => {
        expect(mergeButtonState(pr({ isDraft: true }), 'merge', false, false)).toMatchObject({ disabled: true, title: 'The pull request is a draft.' });
    });

    it('turns off the button while an action runs', () => {
        expect(mergeButtonState(pr(), 'merge', false, true).disabled).toBe(true);
    });

    it('turns on auto-merge when the user cannot merge', () => {
        expect(mergeButtonState(pr({ viewerCanMerge: false, isDraft: true }), 'merge', true, false)).toEqual({
            label: 'Enable auto-merge',
            disabled: false,
            title: undefined,
            merges: false
        });
    });
});

describe('confirmations', () => {
    it('names the method and the base branch before a merge', () => {
        expect(mergeConfirmTitle(pr(), 'squash')).toBe('Squash and merge: pull request #7 into main?');
    });

    it('names the method when auto-merge goes on', () => {
        expect(autoMergeConfirm(pr(), 'rebase')).toEqual({
            title: 'Turn on auto-merge for pull request #7? GitHub merges it into main with "Rebase and merge" when all the requirements pass.',
            confirmLabel: 'Enable auto-merge'
        });
    });

    it('asks before auto-merge goes off', () => {
        expect(autoMergeConfirm(pr(), null)).toEqual({ title: 'Turn off auto-merge for pull request #7?', confirmLabel: 'Disable auto-merge' });
    });

    it('asks before the user closes or reopens a pull request', () => {
        expect(stateConfirm(pr(), 'closed')).toEqual({ title: 'Close pull request #7 without a merge?', confirmLabel: 'Close pull request' });
        expect(stateConfirm(pr(), 'open')).toEqual({ title: 'Reopen pull request #7?', confirmLabel: 'Reopen' });
    });

    it('asks before the draft state changes', () => {
        expect(draftConfirm(pr(), true)).toEqual({ title: 'Convert pull request #7 to a draft?', confirmLabel: 'Convert to draft' });
        expect(draftConfirm(pr(), false)).toEqual({ title: 'Mark pull request #7 as ready for review?', confirmLabel: 'Ready for review' });
    });
});

describe('descriptionChange', () => {
    it('sends only the fields that changed', () => {
        expect(descriptionChange(pr(), 'Fix login', 'New text')).toEqual({ kind: 'details', title: undefined, body: 'New text' });
        expect(descriptionChange(pr(), 'New title', 'Text')).toEqual({ kind: 'details', title: 'New title', body: undefined });
    });
});
