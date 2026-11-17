import { describe, expect, it } from 'vitest';
import { parseIssueUrl, parsePullRequestUrl } from './github';

describe('parsePullRequestUrl', () => {
    it('reads a GitHub pull request and its tab', () => {
        expect(parsePullRequestUrl('https://github.com/acme/api/pull/42')).toEqual({ repo: { owner: 'acme', name: 'api' }, number: 42, tab: 'overview' });
        expect(parsePullRequestUrl('https://github.com/acme/api/pull/42/files#diff-1')?.tab).toBe('files');
        expect(parsePullRequestUrl('https://github.com/acme/api/pull/42/checks?x=1')?.tab).toBe('checks');
        expect(parsePullRequestUrl('https://github.com/acme/api/pull/42/commits')?.tab).toBe('overview');
        expect(parsePullRequestUrl('https://github.com/acme/api/pull/42#issuecomment-7')?.number).toBe(42);
    });

    it('reads an Azure Repos pull request', () => {
        const repo = { owner: 'contoso/My Web', name: 'shop', host: 'azure' };
        expect(parsePullRequestUrl('https://dev.azure.com/contoso/My%20Web/_git/shop/pullrequest/7')).toEqual({ repo, number: 7, tab: 'overview' });
        expect(parsePullRequestUrl('https://contoso.visualstudio.com/DefaultCollection/My%20Web/_git/shop/pullrequest/7')?.repo).toEqual(repo);
    });

    it('refuses other addresses', () => {
        expect(parsePullRequestUrl('https://github.com/acme/api/issues/42')).toBeUndefined();
        expect(parsePullRequestUrl('https://github.com/acme/api/pull/42/commits/abc/extra')).toBeUndefined();
        expect(parsePullRequestUrl('https://example.com/acme/api/pull/42')).toBeUndefined();
        expect(parsePullRequestUrl('https://github.com/acme/api/pulls')).toBeUndefined();
    });
});

describe('parseIssueUrl', () => {
    it('reads a GitHub issue address', () => {
        expect(parseIssueUrl('https://github.com/acme/api/issues/12')).toEqual({ repo: { owner: 'acme', name: 'api' }, number: 12 });
        expect(parseIssueUrl('https://github.com/acme/api/issues/12#issuecomment-3')?.number).toBe(12);
    });

    it('refuses other addresses', () => {
        expect(parseIssueUrl('https://github.com/acme/api/issues')).toBeUndefined();
        expect(parseIssueUrl('https://github.com/acme/api/pull/12')).toBeUndefined();
    });
});
