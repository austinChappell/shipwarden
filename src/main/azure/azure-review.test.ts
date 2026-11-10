import { describe, expect, it } from 'vitest';
import { azureRepoRef } from '@shared/azure-devops';
import { reviewGroup } from '@shared/review-queue';
import type { AzureDevOpsClient } from './azure-client';
import type { AzBuild, AzPullRequest } from './azure-mapping';
import { AzureDevOpsService } from './azure-service';

const ORG = 'https://dev.azure.com/contoso';
const PROJECT = `${ORG}/Web/_apis`;
const REPO_ID = '3411ebc1';
const VIEWER = 'viewer-id';
const SHOP = azureRepoRef({ organization: 'contoso', project: 'Web', repository: 'shop' });

const identity = (id: string, name: string) => ({ id, displayName: name, uniqueName: `${name}@contoso.com` });

function pr(id: number, change: Partial<AzPullRequest> = {}): AzPullRequest {
    return {
        pullRequestId: id,
        title: `Change ${id}`,
        status: 'active',
        createdBy: identity('author-id', 'ana'),
        creationDate: `2026-11-0${id}T10:00:00Z`,
        sourceRefName: `refs/heads/feature-${id}`,
        targetRefName: 'refs/heads/main',
        lastMergeSourceCommit: { commitId: `head${id}` },
        repository: { id: REPO_ID, name: 'shop', project: { id: 'p1', name: 'Web' } },
        ...change
    };
}

/** A failed pull request build of pull request 2. */
const FAILED_BUILD: AzBuild = {
    id: 90,
    buildNumber: '90',
    status: 'completed',
    result: 'failed',
    sourceBranch: 'refs/pull/2/merge',
    sourceVersion: 'merge2',
    definition: { id: 5, name: 'CI' },
    triggerInfo: { 'pr.number': '2', 'pr.sourceSha': 'head2' }
};

/** Records the requests and answers them by the start of the URL, without a network. */
function fakeService(answers: [string, unknown][]) {
    const urls: string[] = [];
    const client = {
        request: async (_method: string, url: string) => {
            urls.push(url);
            if (url.endsWith('/git/repositories/shop')) return { id: REPO_ID, name: 'shop', defaultBranch: 'refs/heads/main' };
            if (url.endsWith('/_apis/connectionData')) {
                return { authenticatedUser: { id: VIEWER, providerDisplayName: 'Vic', properties: { Account: { $value: 'vic@contoso.com' } } } };
            }
            const found = answers.find(([prefix]) => url.startsWith(prefix));
            if (!found) throw new Error(`No answer for ${url}`);
            return found[1];
        }
    } as unknown as AzureDevOpsClient;
    return { urls, service: new AzureDevOpsService(client, async () => '') };
}

describe('AzureDevOpsService for the Review view', () => {
    it('owns an Azure reference without a worktree', async () => {
        const { service } = fakeService([]);
        expect(await service.owns(SHOP)).toBe(true);
        expect(await service.owns({ owner: 'contoso/Web', name: 'shop' })).toBe(false);
    });

    it('lists the repositories of the organizations without the disabled ones', async () => {
        const { service } = fakeService([
            [
                `${ORG}/_apis/git/repositories`,
                {
                    value: [
                        { id: '1', name: 'shop', project: { id: 'p1', name: 'Web' } },
                        { id: '2', name: 'old', project: { id: 'p1', name: 'Web' }, isDisabled: true }
                    ]
                }
            ]
        ]);
        expect(await service.repositories(['contoso'])).toEqual([SHOP]);
    });

    it('uses the organizations of the project remotes when the account API fails', async () => {
        const { service, urls } = fakeService([[`${ORG}/_apis/git/repositories`, { value: [] }]]);
        expect(await service.repositories(undefined, ['contoso'])).toEqual([]);
        expect(urls.some(url => url.startsWith('https://app.vssps.visualstudio.com/_apis/profile/profiles/me'))).toBe(true);
        expect(urls).toContain(`${ORG}/_apis/git/repositories`);
    });

    it('asks the user to type the organizations when none is known', async () => {
        const { service } = fakeService([]);
        await expect(service.repositories(undefined, [])).rejects.toThrow('Settings › Code review');
    });

    it('groups the active pull requests by the vote of the viewer', async () => {
        const { service } = fakeService([
            [
                `${PROJECT}/git/repositories/${REPO_ID}/pullrequests?searchCriteria.status=active`,
                {
                    value: [
                        pr(1, { reviewers: [{ ...identity(VIEWER, 'vic'), vote: 0 }] }),
                        pr(2, { createdBy: identity(VIEWER, 'vic'), reviewers: [{ ...identity('r', 'rob'), vote: 10 }], mergeStatus: 'succeeded' }),
                        pr(3, { reviewers: [{ ...identity(VIEWER, 'vic'), vote: 10 }] }),
                        pr(4, { isDraft: true, reviewers: [{ ...identity(VIEWER, 'vic'), vote: 0 }] })
                    ]
                }
            ],
            [`${PROJECT}/build/builds`, { value: [FAILED_BUILD] }]
        ]);
        const data = await service.repoPullRequests(SHOP);
        expect(data.viewer).toBe('vic@contoso.com');
        expect(data.openCount).toBe(4);
        expect(data.pullRequests.map(item => [item.number, reviewGroup(item)])).toEqual([
            [1, 'new'],
            [2, 'mine'],
            [3, 'waiting'],
            [4, 'other']
        ]);
        const mine = data.pullRequests[1];
        expect(mine.checks).toEqual({ state: 'FAILURE', failing: 1, pending: 0, total: 1 });
        expect(mine.actions).toEqual(['ci-failing']);
        expect(mine.url).toBe('https://dev.azure.com/contoso/Web/_git/shop/pullrequest/2');
    });

    it('lists the completed pull requests for the merged filter and searches them', async () => {
        const { service, urls } = fakeService([
            [
                `${PROJECT}/git/repositories/${REPO_ID}/pullrequests?searchCriteria.status=completed`,
                { value: [pr(1, { status: 'completed', closedDate: '2026-11-08T00:00:00Z' }), pr(2, { status: 'completed', title: 'Fix login' })] }
            ]
        ]);
        const list = await service.pullRequests(SHOP, 'merged', 'login');
        expect(list.map(item => [item.number, item.state, item.checks])).toEqual([[2, 'MERGED', null]]);
        expect(urls.some(url => url.includes('/build/builds'))).toBe(false);
    });

    it('gives no pull requests for the assigned filter', async () => {
        const { service, urls } = fakeService([]);
        expect(await service.pullRequests(SHOP, 'assigned')).toEqual([]);
        expect(urls).toEqual([]);
    });

    it('finds the review requests and the pull requests of the viewer in each project for the Dashboard', async () => {
        const { service } = fakeService([
            [`${ORG}/_apis/projects`, { value: [{ name: 'Web', state: 'wellFormed' }] }],
            [
                `${PROJECT}/git/pullrequests?searchCriteria.status=active&searchCriteria.reviewerId=${VIEWER}`,
                { value: [pr(1, { reviewers: [{ ...identity(VIEWER, 'vic'), vote: 0 }] }), pr(3, { reviewers: [{ ...identity(VIEWER, 'vic'), vote: -5 }] })] }
            ],
            [
                `${PROJECT}/git/pullrequests?searchCriteria.status=active&searchCriteria.creatorId=${VIEWER}`,
                { value: [pr(2, { createdBy: identity(VIEWER, 'vic') }), pr(5, { createdBy: identity(VIEWER, 'vic') })] }
            ],
            [`${PROJECT}/build/builds`, { value: [FAILED_BUILD] }]
        ]);
        const result = await service.dashboardPullRequests(['contoso']);
        expect(result.reviewRequests.map(item => [item.repo, item.number])).toEqual([[SHOP, 1]]);
        // Pull request 5 waits for the reviewers, so the viewer has nothing to do.
        expect(result.myPullRequests.map(item => [item.number, item.reasons])).toEqual([[2, ['ci-failing']]]);
    });
});
