import { describe, expect, it } from 'vitest';
import { parseReviewPage, reviewPage } from './review-page';

describe('reviewPage', () => {
    it('gives no page for the entry page', () => {
        expect(reviewPage()).toBeUndefined();
        expect(parseReviewPage(undefined)).toEqual({});
    });

    it('reads the page of a repository and of a pull request', () => {
        expect(parseReviewPage(reviewPage('owner/repo'))).toEqual({ repo: 'owner/repo' });
        expect(parseReviewPage(reviewPage('owner/repo', 42))).toEqual({ repo: 'owner/repo', number: 42 });
    });

    it('reads an Azure repository with a pull request', () => {
        const repo = 'azure:org/project/repo';
        expect(parseReviewPage(reviewPage(repo, 7))).toEqual({ repo, number: 7 });
    });
});
