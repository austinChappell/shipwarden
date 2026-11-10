import { describe, expect, it } from 'vitest';
import type { PullRequestFile } from '@shared/github';
import { reviewKeys, withViewed } from './review-store';

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
