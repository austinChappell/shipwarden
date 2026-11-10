import { describe, expect, it } from 'vitest';
import type { BranchSummary } from '@shared/github';
import { branchSummariesQuery, summariesByRepo } from './use-branch-status';

const summary: BranchSummary = { number: 1, url: 'u', isDraft: false, reviewDecision: null, checks: null };

describe('summariesByRepo', () => {
    it('maps the loaded results to their repositories', () => {
        expect(summariesByRepo(['/a', '/b', '/c'], [{ data: { main: summary } }, { data: undefined }, { data: {} }])).toEqual({
            '/a': { main: summary },
            '/c': {}
        });
    });
});

describe('branchSummariesQuery', () => {
    it('uses one key for each repository', () => {
        expect(branchSummariesQuery('/a').queryKey).toEqual(['github', 'branchSummaries', '/a']);
    });
});
