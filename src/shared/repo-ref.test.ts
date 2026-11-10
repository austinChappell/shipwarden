import { describe, expect, it } from 'vitest';
import { azureRepoOf, azureRepoRef } from './azure-devops';
import { cloneUrl, parseRepoId, pipelinesWebUrl, pullRequestRef, pullRequestWebUrl, repoId, repoLabel, repoWebUrl, sameRepoRef, targetKey } from './github';
import { checkRepoRef, isSafeRepoName, reviewCheckoutKey } from './review-checkout';

const AZURE = azureRepoRef({ organization: 'contoso', project: 'My Web', repository: 'shop' });
const GITHUB = { owner: 'acme', name: 'api' };

describe('repository references', () => {
    it('makes an Azure reference with "organization/project" as the owner', () => {
        expect(AZURE).toEqual({ owner: 'contoso/My Web', name: 'shop', host: 'azure' });
        expect(azureRepoOf(AZURE)).toEqual({ organization: 'contoso', project: 'My Web', repository: 'shop' });
    });

    it('gives no Azure repository for a GitHub reference or a bad owner', () => {
        expect(azureRepoOf(GITHUB)).toBeUndefined();
        expect(azureRepoOf({ owner: 'contoso', name: 'shop', host: 'azure' })).toBeUndefined();
        expect(azureRepoOf({ owner: 'contoso/', name: 'shop', host: 'azure' })).toBeUndefined();
        expect(azureRepoOf(null)).toBeUndefined();
    });

    it('reads the ID of a repository back', () => {
        expect(repoId(GITHUB)).toBe('acme/api');
        expect(repoId(AZURE)).toBe('azure:contoso/My Web/shop');
        expect(parseRepoId('acme/api')).toEqual(GITHUB);
        expect(parseRepoId('azure:contoso/My Web/shop')).toEqual(AZURE);
        expect(repoLabel(AZURE)).toBe('contoso/My Web/shop');
    });

    it('gives a different cache key for each host', () => {
        expect(targetKey(GITHUB)).toBe('github:acme/api');
        expect(targetKey(AZURE)).toBe('azure:contoso/My Web/shop');
        expect(targetKey('/work/shop')).toBe('/work/shop');
    });

    it('compares the host, the owner and the name', () => {
        expect(sameRepoRef({ owner: 'ACME', name: 'Api' }, GITHUB)).toBe(true);
        expect(sameRepoRef({ ...AZURE, owner: 'Contoso/my web' }, AZURE)).toBe(true);
        expect(sameRepoRef({ owner: 'contoso/My Web', name: 'shop' }, AZURE)).toBe(false);
        expect(sameRepoRef(null, GITHUB)).toBe(false);
    });

    it('makes the web pages and the clone URL of each host', () => {
        expect(repoWebUrl(GITHUB)).toBe('https://github.com/acme/api');
        expect(pullRequestWebUrl(GITHUB, 7)).toBe('https://github.com/acme/api/pull/7');
        expect(pipelinesWebUrl(GITHUB)).toBe('https://github.com/acme/api/actions');
        expect(cloneUrl(GITHUB)).toBe('https://github.com/acme/api.git');
        expect(pullRequestWebUrl(AZURE, 7)).toBe('https://dev.azure.com/contoso/My%20Web/_git/shop/pullrequest/7');
        expect(pipelinesWebUrl(AZURE)).toBe('https://dev.azure.com/contoso/My%20Web/_build');
        expect(cloneUrl(AZURE)).toBe('https://dev.azure.com/contoso/My%20Web/_git/shop');
    });

    it('fetches the merge ref of an Azure pull request', () => {
        expect(pullRequestRef(GITHUB, 4)).toBe('refs/pull/4/head');
        expect(pullRequestRef(AZURE, 4)).toBe('refs/pull/4/merge');
    });
});

describe('Azure references in the review checkouts', () => {
    it('accepts Azure names with spaces and keeps the host', () => {
        expect(checkRepoRef(AZURE)).toEqual(AZURE);
        expect(isSafeRepoName({ name: 'my repo', host: 'azure' })).toBe(true);
        expect(isSafeRepoName({ name: 'my repo' })).toBe(false);
    });

    it('refuses Azure names that are not safe folder names', () => {
        expect(() => checkRepoRef({ owner: 'contoso', name: 'shop', host: 'azure' })).toThrow('not a valid Azure Repos repository name');
        expect(() => checkRepoRef({ owner: 'contoso/../x', name: 'shop', host: 'azure' })).toThrow();
        expect(() => checkRepoRef({ owner: 'contoso/Web', name: '..', host: 'azure' })).toThrow();
        expect(() => checkRepoRef({ owner: 'contoso/Web', name: 'a\\b', host: 'azure' })).toThrow();
    });

    it('keeps GitHub and Azure checkouts apart in the index', () => {
        expect(reviewCheckoutKey(GITHUB, 3)).toBe('acme/api#3');
        expect(reviewCheckoutKey(AZURE, 3)).toBe('azure:contoso/my web/shop#3');
    });
});
