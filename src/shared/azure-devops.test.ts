import { describe, expect, it } from 'vitest';
import {
    azureCreatePullRequestUrl,
    azureProjectApi,
    azureRepoWebUrl,
    buildResultToConclusion,
    buildStatusToCheck,
    decodeAzureId,
    encodeAzureId,
    fromRefName,
    gitStatusToCheck,
    isAzureId,
    parseAzureRemote,
    reviewDecisionFromVotes,
    reviewStateForVote,
    threadIsResolved,
    timelineResultToConclusion,
    timelineStateToCheck,
    toRefName,
    voteForEvent
} from './azure-devops';

describe('parseAzureRemote', () => {
    const repo = { organization: 'contoso', project: 'Web', repository: 'shop' };
    it.each([
        'https://dev.azure.com/contoso/Web/_git/shop',
        'https://dev.azure.com/contoso/Web/_git/shop/',
        'https://dev.azure.com/contoso/Web/_git/shop.git',
        'https://contoso@dev.azure.com/contoso/Web/_git/shop',
        'git@ssh.dev.azure.com:v3/contoso/Web/shop',
        'ssh://git@ssh.dev.azure.com/v3/contoso/Web/shop',
        'https://contoso.visualstudio.com/Web/_git/shop',
        'https://contoso.visualstudio.com/DefaultCollection/Web/_git/shop',
        'https://user@contoso.visualstudio.com/Web/_git/shop',
        'contoso@vs-ssh.visualstudio.com:v3/contoso/Web/shop',
        '  https://dev.azure.com/contoso/Web/_git/shop\n'
    ])('parses %s', url => {
        expect(parseAzureRemote(url)).toEqual(repo);
    });

    it('decodes spaces and other escaped characters', () => {
        expect(parseAzureRemote('https://dev.azure.com/contoso/My%20Project/_git/My%20Repo')).toEqual({
            organization: 'contoso',
            project: 'My Project',
            repository: 'My Repo'
        });
        expect(parseAzureRemote('git@ssh.dev.azure.com:v3/contoso/My%20Project/My%20Repo')).toEqual({
            organization: 'contoso',
            project: 'My Project',
            repository: 'My Repo'
        });
    });

    it.each([
        'https://github.com/acme/api.git',
        'git@github.com:acme/api.git',
        'https://dev.azure.com/contoso/Web',
        'https://dev.azure.com/contoso/Web/_git',
        'https://example.com/contoso/Web/_git/shop',
        'git@ssh.dev.azure.com:v3/contoso/Web',
        ''
    ])('refuses %s', url => {
        expect(parseAzureRemote(url)).toBeUndefined();
    });
});

describe('URLs', () => {
    const repo = { organization: 'contoso', project: 'My Project', repository: 'shop' };
    it('makes the REST and web URLs', () => {
        expect(azureProjectApi(repo)).toBe('https://dev.azure.com/contoso/My%20Project/_apis');
        expect(azureRepoWebUrl(repo)).toBe('https://dev.azure.com/contoso/My%20Project/_git/shop');
        expect(azureCreatePullRequestUrl(repo, 'feat/x')).toBe('https://dev.azure.com/contoso/My%20Project/_git/shop/pullrequestcreate?sourceRef=feat%2Fx');
    });

    it('adds and removes refs/heads/', () => {
        expect(toRefName('main')).toBe('refs/heads/main');
        expect(toRefName('refs/pull/4/merge')).toBe('refs/pull/4/merge');
        expect(fromRefName('refs/heads/feat/x')).toBe('feat/x');
        expect(fromRefName(undefined)).toBe('');
    });
});

describe('status mapping', () => {
    it.each([
        ['notStarted', 'queued'],
        ['none', 'queued'],
        ['postponed', 'waiting'],
        ['inProgress', 'in_progress'],
        ['cancelling', 'in_progress'],
        ['completed', 'completed']
    ] as const)('maps the build status %s to %s', (status, expected) => {
        expect(buildStatusToCheck(status)).toBe(expected);
    });

    it.each([
        ['succeeded', 'success'],
        ['partiallySucceeded', 'neutral'],
        ['failed', 'failure'],
        ['canceled', 'cancelled'],
        ['none', null],
        [undefined, null]
    ] as const)('maps the build result %s to %s', (result, expected) => {
        expect(buildResultToConclusion(result)).toBe(expected);
    });

    it('maps the timeline states and results', () => {
        expect(timelineStateToCheck('pending')).toBe('queued');
        expect(timelineStateToCheck('inProgress')).toBe('in_progress');
        expect(timelineStateToCheck('completed')).toBe('completed');
        expect(timelineResultToConclusion('succeeded')).toBe('success');
        expect(timelineResultToConclusion('succeededWithIssues')).toBe('neutral');
        expect(timelineResultToConclusion('failed')).toBe('failure');
        expect(timelineResultToConclusion('skipped')).toBe('skipped');
        expect(timelineResultToConclusion('abandoned')).toBe('cancelled');
        expect(timelineResultToConclusion(null)).toBeNull();
    });

    it('maps the states of external statuses', () => {
        expect(gitStatusToCheck('succeeded')).toEqual({ status: 'completed', conclusion: 'success' });
        expect(gitStatusToCheck('failed')).toEqual({ status: 'completed', conclusion: 'failure' });
        expect(gitStatusToCheck('error')).toEqual({ status: 'completed', conclusion: 'error' });
        expect(gitStatusToCheck('notApplicable')).toEqual({ status: 'completed', conclusion: 'skipped' });
        expect(gitStatusToCheck('pending')).toEqual({ status: 'pending', conclusion: null });
        expect(gitStatusToCheck('notSet')).toEqual({ status: 'pending', conclusion: null });
    });

    it('tells which thread states are resolved', () => {
        expect(threadIsResolved('active')).toBe(false);
        expect(threadIsResolved('pending')).toBe(false);
        expect(threadIsResolved(undefined)).toBe(false);
        expect(threadIsResolved('fixed')).toBe(true);
        expect(threadIsResolved('wontFix')).toBe(true);
        expect(threadIsResolved('closed')).toBe(true);
        expect(threadIsResolved('byDesign')).toBe(true);
    });
});

describe('votes', () => {
    it('gives the vote of each review event', () => {
        expect(voteForEvent('APPROVE')).toBe(10);
        expect(voteForEvent('APPROVE_WITH_SUGGESTIONS')).toBe(5);
        expect(voteForEvent('WAIT_FOR_AUTHOR')).toBe(-5);
        expect(voteForEvent('REQUEST_CHANGES')).toBe(-5);
        expect(voteForEvent('REJECT')).toBe(-10);
        expect(voteForEvent('COMMENT')).toBeUndefined();
    });

    it('gives the review state of each vote', () => {
        expect(reviewStateForVote(10)).toBe('APPROVED');
        expect(reviewStateForVote(5)).toBe('APPROVED_WITH_SUGGESTIONS');
        expect(reviewStateForVote(0)).toBeUndefined();
        expect(reviewStateForVote(-5)).toBe('WAITING_FOR_AUTHOR');
        expect(reviewStateForVote(-10)).toBe('REJECTED');
    });

    it('finds the review decision', () => {
        expect(reviewDecisionFromVotes([])).toBeNull();
        expect(reviewDecisionFromVotes([{ vote: 0 }])).toBe('REVIEW_REQUIRED');
        expect(reviewDecisionFromVotes([{ vote: 10 }, { vote: 0 }])).toBe('APPROVED');
        expect(reviewDecisionFromVotes([{ vote: 10 }, { vote: 0, isRequired: true }])).toBe('REVIEW_REQUIRED');
        expect(reviewDecisionFromVotes([{ vote: 10 }, { vote: -5 }])).toBe('CHANGES_REQUESTED');
        expect(reviewDecisionFromVotes([{ vote: 5, isRequired: true }])).toBe('APPROVED');
    });
});

describe('Azure IDs', () => {
    const repo = { organization: 'contoso', project: 'My Project', repository: 'a/b' };
    it('keeps the repository, the pull request and the thread', () => {
        const id = encodeAzureId(repo, 12, 7);
        expect(isAzureId(id)).toBe(true);
        expect(decodeAzureId(id)).toEqual({ repo, pullRequestId: 12, threadId: 7 });
        expect(decodeAzureId(encodeAzureId(repo, 12))).toEqual({ repo, pullRequestId: 12, threadId: undefined });
    });

    it('refuses other IDs', () => {
        expect(isAzureId('PRRT_kwDOAbc')).toBe(false);
        expect(decodeAzureId('PRRT_kwDOAbc')).toBeUndefined();
        expect(decodeAzureId('azure:a/b/c/x')).toBeUndefined();
    });
});
