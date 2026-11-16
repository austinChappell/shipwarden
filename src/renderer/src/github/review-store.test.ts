import { describe, expect, it } from 'vitest';
import type { PendingComment, PullRequestFile } from '@shared/github';
import { queryClient } from '../query-client';
import { reviewKeys, reviewStore, withViewed, withoutAgentReview } from './review-store';

const REPO = { owner: 'acme', name: 'app' };
const PATCH = ['@@ -1,2 +1,2 @@', ' a', '-b', '+c'].join('\n');
const mine: PendingComment = { path: 'x.ts', line: 1, side: 'RIGHT', body: 'Mine.' };
const agentComment: PendingComment = {
    path: 'x.ts',
    line: 2,
    side: 'RIGHT',
    body: 'Agent.',
    fromAgent: true,
    needsDecision: true,
    fromReview: true,
    lineText: 'c'
};
const review = { summary: 'Agent summary.', comments: [agentComment], unplaced: [] };

describe('withViewed', () => {
    it('changes the viewed flag of the file with the path only', () => {
        const files = [
            { path: 'a.ts', viewed: false },
            { path: 'b.ts', viewed: false }
        ] as PullRequestFile[];
        expect(withViewed(files, 'b.ts', true).map(file => file.viewed)).toEqual([false, true]);
    });
});

describe('reviewKeys', () => {
    it('puts the pull request under the pull request root, so that invalidatePullRequestData reaches it', () => {
        expect(reviewKeys.pullRequest({ owner: 'acme', name: 'app' }, 7)).toEqual(['github', 'pullRequest', 'github:acme/app', 7]);
    });
});

describe('withoutAgentReview', () => {
    it('removes the agent comments, accepted or not, and the agent text', () => {
        const accepted = { ...agentComment, needsDecision: undefined };
        const state = { pending: [mine, agentComment, accepted], body: 'My note.\n\nAgent summary.', agentBody: 'x', agentTexts: ['Agent summary.'] };
        expect(withoutAgentReview(state)).toEqual({ pending: [mine], body: 'My note.', agentBody: undefined, agentTexts: undefined });
    });
});

describe('reviewStore agent review', () => {
    it('replaces the last agent review with a new one', () => {
        reviewStore.addPending(REPO, 1, mine);
        reviewStore.setBody(REPO, 1, 'My note.');
        reviewStore.applyAgentReview(REPO, 1, review, 'claude');
        reviewStore.applyAgentReview(REPO, 1, { ...review, summary: 'Second.' }, 'claude');
        const state = reviewStore.get(REPO, 1);
        expect(state.pending).toEqual([mine, agentComment]);
        expect(state.body).toBe('My note.\n\nSecond.');
    });

    it('clears the agent comments and the summary', () => {
        reviewStore.addPending(REPO, 2, mine);
        reviewStore.applyAgentReview(REPO, 2, review, 'claude');
        reviewStore.clearAgentReview(REPO, 2);
        const state = reviewStore.get(REPO, 2);
        expect(state.pending).toEqual([mine]);
        expect(state.body).toBe('');
        expect(state.agentReview).toBeUndefined();
    });

    it('removes an agent comment when new files change its line', () => {
        queryClient.setQueryData(reviewKeys.files(REPO, 3), [{ path: 'x.ts', patch: PATCH }]);
        reviewStore.addPending(REPO, 3, mine);
        reviewStore.applyAgentReview(REPO, 3, review, 'claude');
        expect(reviewStore.get(REPO, 3).pending).toEqual([mine, agentComment]);
        queryClient.setQueryData(reviewKeys.files(REPO, 3), [{ path: 'x.ts', patch: ['@@ -1,2 +1,2 @@', ' a', '-b', '+d'].join('\n') }]);
        expect(reviewStore.get(REPO, 3).pending).toEqual([mine]);
    });
});
