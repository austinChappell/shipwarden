import { describe, expect, it } from 'vitest';
import { checkCommitSha, checkPullNumber, checkRepoRef, isSafeRepoPart, reviewCheckoutKey } from './review-checkout';

describe('review checkout input', () => {
    it('accepts GitHub owner and repository names and refuses paths', () => {
        expect(isSafeRepoPart('octo-org')).toBe(true);
        expect(isSafeRepoPart('my.repo_2')).toBe(true);
        expect(isSafeRepoPart('..')).toBe(false);
        expect(isSafeRepoPart('.')).toBe(false);
        expect(isSafeRepoPart('a/b')).toBe(false);
        expect(isSafeRepoPart('')).toBe(false);
        expect(() => checkRepoRef({ owner: '..', name: 'x' })).toThrow('is not a valid repository name');
        expect(checkRepoRef({ owner: 'Octo', name: 'App' })).toEqual({ owner: 'Octo', name: 'App' });
    });

    it('accepts only positive pull request numbers and full commit SHAs', () => {
        expect(checkPullNumber('12')).toBe(12);
        expect(() => checkPullNumber(0)).toThrow();
        expect(() => checkPullNumber(1.5)).toThrow();
        expect(checkCommitSha('A'.repeat(40))).toBe('a'.repeat(40));
        expect(() => checkCommitSha('abc123')).toThrow('is not a full commit SHA');
        expect(() => checkCommitSha('--upload-pack=x'.padEnd(40, 'a'))).toThrow();
    });

    it('makes the same key for owner and name in any case', () => {
        expect(reviewCheckoutKey({ owner: 'Octo', name: 'App' }, 7)).toBe(reviewCheckoutKey({ owner: 'octo', name: 'app' }, 7));
    });
});
