import { describe, expect, it } from 'vitest';
import type { CheckRun, PullRequest } from '@shared/github';
import { bannerChecks, failedCheckNames, failedChecksTitle } from './check-summary';
import type { CheckCounts } from './use-check-counts';

const check = (id: number, name: string): CheckRun => ({
    id,
    name,
    status: 'completed',
    conclusion: 'failure',
    startedAt: null,
    completedAt: null,
    url: null,
    isActions: true
});

const counts = (failedChecks: CheckRun[]): CheckCounts => ({
    total: 3,
    passed: 3 - failedChecks.length,
    failed: failedChecks.length,
    running: 0,
    failedChecks
});

describe('bannerChecks', () => {
    it('returns the failed checks of an open pull request', () => {
        const failed = [check(1, 'test')];
        expect(bannerChecks({ state: 'OPEN' } as PullRequest, counts(failed))).toEqual(failed);
    });

    it('returns no checks for a merged or closed pull request', () => {
        expect(bannerChecks({ state: 'MERGED' } as PullRequest, counts([check(1, 'test')]))).toEqual([]);
        expect(bannerChecks({ state: 'CLOSED' } as PullRequest, counts([check(1, 'test')]))).toEqual([]);
    });

    it('returns no checks without a pull request or without counts', () => {
        expect(bannerChecks(null, counts([check(1, 'test')]))).toEqual([]);
        expect(bannerChecks({ state: 'OPEN' } as PullRequest, undefined)).toEqual([]);
    });
});

describe('failedChecksTitle', () => {
    it('uses the singular for one check', () => {
        expect(failedChecksTitle(1)).toBe('1 check failed.');
    });

    it('uses the plural for more than one check', () => {
        expect(failedChecksTitle(3)).toBe('3 checks failed.');
    });
});

describe('failedCheckNames', () => {
    it('joins the names with commas', () => {
        expect(failedCheckNames([check(1, 'test'), check(2, 'lint')])).toBe('test, lint');
    });
});
