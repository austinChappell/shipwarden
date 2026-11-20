import { describe, expect, it } from 'vitest';
import {
    bitbucketRepoOf,
    cleanBitbucketLog,
    commitStatusToCheck,
    decodeBitbucketId,
    encodeBitbucketId,
    mergeMethodsOfStrategies,
    parseBitbucketRemote,
    pipelineStateToCheck,
    splitUnifiedDiff,
    strategyForMethod
} from './bitbucket';
import { cloneUrl, hostLabel, parsePullRequestUrl, parseRepoId, pullRequestRef, pullRequestWebUrl, repoId } from './github';
import { reviewEventsAfter } from './gitlab';
import { parsePullRequestLink } from './pr-groups';
import { checkRepoRef, reviewCheckoutKey } from './review-checkout';

describe('parseBitbucketRemote', () => {
    it.each([
        ['git@bitbucket.org:acme/api.git', { workspace: 'acme', repo: 'api' }],
        ['git@bitbucket.org:acme/api', { workspace: 'acme', repo: 'api' }],
        ['ssh://git@bitbucket.org/acme/api.git', { workspace: 'acme', repo: 'api' }],
        ['ssh://git@altssh.bitbucket.org:443/acme/api.git', { workspace: 'acme', repo: 'api' }],
        ['https://bitbucket.org/acme/api.git', { workspace: 'acme', repo: 'api' }],
        ['https://dana@bitbucket.org/acme/api.git', { workspace: 'acme', repo: 'api' }],
        ['https://x-token-auth:secret@bitbucket.org/acme/web-app', { workspace: 'acme', repo: 'web-app' }],
        ['https://bitbucket.org/acme/api/', { workspace: 'acme', repo: 'api' }]
    ])('reads %s', (url, expected) => {
        expect(parseBitbucketRemote(url)).toEqual(expected);
    });

    it.each([
        'git@github.com:acme/api.git',
        'https://gitlab.com/acme/api.git',
        'https://bitbucket.example.com/scm/acme/api.git',
        'https://bitbucket.org/acme',
        'https://bitbucket.org/acme/api/pull-requests/1',
        'git@bitbucket.org:acme/group/api.git',
        ''
    ])('refuses %s', url => {
        expect(parseBitbucketRemote(url)).toBeUndefined();
    });
});

describe('Bitbucket references', () => {
    const ref = { owner: 'acme', name: 'api', host: 'bitbucket' as const };

    it('makes IDs, web pages, clone URLs, and labels', () => {
        expect(repoId(ref)).toBe('bitbucket:acme/api');
        expect(parseRepoId('bitbucket:acme/api')).toEqual(ref);
        expect(pullRequestWebUrl(ref, 17)).toBe('https://bitbucket.org/acme/api/pull-requests/17');
        expect(cloneUrl(ref)).toBe('https://bitbucket.org/acme/api.git');
        expect(hostLabel('bitbucket')).toBe('Bitbucket');
        expect(bitbucketRepoOf(ref)).toEqual({ workspace: 'acme', repo: 'api' });
        expect(bitbucketRepoOf({ owner: 'acme', name: 'api' })).toBeUndefined();
        expect(pullRequestRef(ref, 17)).toBe('+refs/heads/*:refs/remotes/origin/*');
    });

    it('reads the web page of a pull request', () => {
        expect(parsePullRequestUrl('https://bitbucket.org/acme/api/pull-requests/17')).toEqual({ repo: ref, number: 17, tab: 'overview' });
        expect(parsePullRequestUrl('https://bitbucket.org/acme/api/pull-requests/17/diff')).toEqual({ repo: ref, number: 17, tab: 'files' });
        expect(parsePullRequestLink('https://bitbucket.org/acme/api/pull-requests/17')).toEqual({ repo: ref, number: 17 });
    });

    it('checks a reference and makes a checkout key', () => {
        expect(checkRepoRef(ref)).toEqual(ref);
        expect(() => checkRepoRef({ owner: '../x', name: 'api', host: 'bitbucket' })).toThrow('not a valid Bitbucket repository name');
        expect(reviewCheckoutKey({ owner: 'Acme', name: 'API', host: 'bitbucket' }, 3)).toBe('bitbucket:acme/api#3');
    });

    it('encodes the pull request and the comment in an ID', () => {
        const id = encodeBitbucketId({ workspace: 'acme', repo: 'api' }, 17, 501);
        expect(decodeBitbucketId(id)).toEqual({ repo: { workspace: 'acme', repo: 'api' }, id: 17, commentId: 501 });
        expect(decodeBitbucketId(encodeBitbucketId({ workspace: 'acme', repo: 'api' }, 17))).toEqual({ repo: { workspace: 'acme', repo: 'api' }, id: 17 });
        expect(decodeBitbucketId('gitlab:x/y/1')).toBeUndefined();
        expect(decodeBitbucketId('bitbucket:acme/api/0')).toBeUndefined();
    });
});

describe('merge strategies', () => {
    it('gives the methods that the branch allows', () => {
        expect(mergeMethodsOfStrategies(['merge_commit', 'squash', 'fast_forward'], 'squash')).toEqual({
            allowed: ['merge', 'squash', 'rebase'],
            preferred: 'squash'
        });
        expect(mergeMethodsOfStrategies(['squash'], 'merge_commit')).toEqual({ allowed: ['squash'], preferred: 'squash' });
        expect(mergeMethodsOfStrategies(undefined, undefined)).toEqual({ allowed: ['merge', 'squash', 'rebase'], preferred: 'merge' });
    });

    it('selects the strategy of a method', () => {
        expect(strategyForMethod('squash', ['merge_commit', 'squash_fast_forward'], 'merge_commit')).toBe('squash_fast_forward');
        expect(strategyForMethod('rebase', ['rebase_merge', 'fast_forward'], 'fast_forward')).toBe('fast_forward');
        expect(strategyForMethod('merge', undefined, undefined)).toBe('merge_commit');
    });
});

describe('states', () => {
    it('maps the pipeline states', () => {
        expect(pipelineStateToCheck('COMPLETED', 'SUCCESSFUL')).toEqual({ status: 'completed', conclusion: 'success' });
        expect(pipelineStateToCheck('COMPLETED', 'FAILED')).toEqual({ status: 'completed', conclusion: 'failure' });
        expect(pipelineStateToCheck('COMPLETED', 'STOPPED')).toEqual({ status: 'completed', conclusion: 'cancelled' });
        expect(pipelineStateToCheck('COMPLETED', 'NOT_RUN')).toEqual({ status: 'completed', conclusion: 'skipped' });
        expect(pipelineStateToCheck('IN_PROGRESS', null, 'PAUSED')).toEqual({ status: 'waiting', conclusion: null });
        expect(pipelineStateToCheck('IN_PROGRESS')).toEqual({ status: 'in_progress', conclusion: null });
        expect(pipelineStateToCheck('PENDING')).toEqual({ status: 'queued', conclusion: null });
    });

    it('maps the commit status states', () => {
        expect(commitStatusToCheck('SUCCESSFUL').conclusion).toBe('success');
        expect(commitStatusToCheck('FAILED').conclusion).toBe('failure');
        expect(commitStatusToCheck('STOPPED').conclusion).toBe('cancelled');
        expect(commitStatusToCheck('INPROGRESS')).toEqual({ status: 'in_progress', conclusion: null });
    });

    it('swaps the approval button after an approval and after a request for changes', () => {
        const events = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] as const;
        const approved = reviewEventsAfter('bitbucket', [...events], 'APPROVE');
        expect(approved).toEqual(['COMMENT', 'REQUEST_CHANGES', 'UNAPPROVE']);
        expect(reviewEventsAfter('bitbucket', approved, 'REQUEST_CHANGES')).toEqual([...events]);
        expect(reviewEventsAfter('gitlab', ['COMMENT', 'UNAPPROVE'], 'REQUEST_CHANGES')).toEqual(['COMMENT', 'UNAPPROVE']);
    });
});

describe('splitUnifiedDiff', () => {
    it('splits a diff of many files, with added, removed, renamed, and binary files', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 1..2 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,2 @@',
            '-old',
            '+new',
            ' same',
            'diff --git a/new.txt b/new.txt',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/new.txt',
            '@@ -0,0 +1 @@',
            '+hello',
            'diff --git a/logo.png b/logo.png',
            'Binary files a/logo.png and b/logo.png differ',
            ''
        ].join('\n');
        expect(splitUnifiedDiff(diff)).toEqual([
            { oldPath: 'src/a.ts', newPath: 'src/a.ts', patch: '@@ -1,2 +1,2 @@\n-old\n+new\n same' },
            { oldPath: null, newPath: 'new.txt', patch: '@@ -0,0 +1 @@\n+hello' },
            { oldPath: 'logo.png', newPath: 'logo.png' }
        ]);
    });

    it('cleans the color codes of a log', () => {
        expect(cleanBitbucketLog('\x1b[32m+ npm test\x1b[0m\r\nprogress 10%\rprogress 100%\n')).toBe('+ npm test\nprogress 100%\n');
    });
});
