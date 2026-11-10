import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ReviewProviderInfo } from '@shared/review-providers';
import {
    applyProviderChange,
    changeAffectsRepos,
    providerChanged,
    providerRemoved,
    providerTokenChanged,
    reviewProviderKeys,
    reviewScopeKey
} from './review-providers-store';

function provider(id: string, change: Partial<ReviewProviderInfo> = {}): ReviewProviderInfo {
    return { id, kind: 'github', name: id, enabled: true, tokenSaved: false, ...change };
}

describe('applyProviderChange', () => {
    it('trims the name and the CLI account, and ignores an empty name', () => {
        expect(applyProviderChange(provider('a'), { name: ' Work ', cliAccount: ' me ' })).toMatchObject({ name: 'Work', cliAccount: 'me' });
        expect(applyProviderChange(provider('a'), { name: ' ' }).name).toBe('a');
    });

    it('removes the scope and the CLI account with null', () => {
        const after = applyProviderChange(provider('a', { scope: ['org'], cliAccount: 'me' }), { scope: null, cliAccount: null });
        expect(after.scope).toBeUndefined();
        expect(after.cliAccount).toBeUndefined();
    });
});

describe('changeAffectsRepos', () => {
    it('ignores a new name', () => {
        expect(changeAffectsRepos(provider('a'), { name: 'Work' })).toBe(false);
    });

    it('ignores a change of a provider that is off and stays off', () => {
        expect(changeAffectsRepos(provider('a', { enabled: false }), { scope: ['org'] })).toBe(false);
        expect(changeAffectsRepos(provider('a', { enabled: false }), { enabled: false })).toBe(false);
    });

    it('sees a new on/off state, scope or CLI account', () => {
        expect(changeAffectsRepos(provider('a', { enabled: false }), { enabled: true })).toBe(true);
        expect(changeAffectsRepos(provider('a'), { scope: ['org'] })).toBe(true);
        expect(changeAffectsRepos(provider('a'), { cliAccount: 'me' })).toBe(true);
    });
});

describe('reviewScopeKey', () => {
    it('is undefined before the load and null without a provider that is on', () => {
        expect(reviewScopeKey(undefined)).toBeUndefined();
        expect(reviewScopeKey([provider('a', { enabled: false })])).toBeNull();
    });

    it('does not change with a new name', () => {
        expect(reviewScopeKey([provider('a')])).toBe(reviewScopeKey([provider('a', { name: 'Work' })]));
    });
});

describe('the cache updates', () => {
    const pullRequestKey = ['github', 'pullRequest', 'o/r', 1];
    const repoOfKey = ['github', 'repoOf', '/repo'];

    function client(): QueryClient {
        const result = new QueryClient();
        result.setQueryData(reviewProviderKeys.list, [provider('a'), provider('b', { enabled: false })]);
        result.setQueryData(reviewProviderKeys.tokenSource('a'), 'cli');
        result.setQueryData(pullRequestKey, {});
        result.setQueryData(repoOfKey, { owner: 'o', name: 'r' });
        result.setQueryData(['dashboard', 'pullRequests'], {});
        return result;
    }

    it('patches the list after a new name, and keeps the GitHub data fresh', () => {
        const cache = client();
        providerChanged(cache, provider('a'), { name: 'Work' });
        expect(cache.getQueryData<ReviewProviderInfo[]>(reviewProviderKeys.list)?.[0].name).toBe('Work');
        expect(cache.getQueryState(pullRequestKey)?.isInvalidated).toBe(false);
    });

    it('marks the GitHub data and the Dashboard as stale after a new scope, but not the remote of a local repository', () => {
        const cache = client();
        providerChanged(cache, provider('a'), { scope: ['org'] });
        expect(cache.getQueryState(pullRequestKey)?.isInvalidated).toBe(true);
        expect(cache.getQueryState(['dashboard', 'pullRequests'])?.isInvalidated).toBe(true);
        expect(cache.getQueryState(repoOfKey)?.isInvalidated).toBe(false);
    });

    it('marks the token source as stale after a new token', () => {
        const cache = client();
        providerTokenChanged(cache, provider('a'), true);
        expect(cache.getQueryData<ReviewProviderInfo[]>(reviewProviderKeys.list)?.[0].tokenSaved).toBe(true);
        expect(cache.getQueryState(reviewProviderKeys.tokenSource('a'))?.isInvalidated).toBe(true);
        expect(cache.getQueryState(pullRequestKey)?.isInvalidated).toBe(true);
    });

    it('keeps the GitHub data fresh after the removal of a provider that is off', () => {
        const cache = client();
        providerRemoved(cache, provider('b', { enabled: false }));
        expect(cache.getQueryData<ReviewProviderInfo[]>(reviewProviderKeys.list)?.map(item => item.id)).toEqual(['a']);
        expect(cache.getQueryState(pullRequestKey)?.isInvalidated).toBe(false);
    });
});
