import { describe, expect, it } from 'vitest';
import {
    actionsStatusToCheck,
    commitStatusToCheck,
    decodeGiteaId,
    encodeGiteaId,
    giteaCreatePullRequestUrl,
    giteaDraftTitle,
    giteaMergeMethods,
    giteaRepoOf,
    hasDraftPrefix,
    parseGiteaRemote,
    parseServerVersion,
    remoteServerGuess
} from './gitea';
import { cloneUrl, hostLabel, parsePullRequestUrl, parseRepoId, pipelinesWebUrl, pullRequestRef, pullRequestWebUrl, repoId, targetKey } from './github';
import { parsePullRequestLink } from './pr-groups';
import { checkRepoRef, reviewCheckoutKey } from './review-checkout';

const SERVERS = ['https://git.example.com', 'https://codeberg.org', 'http://192.168.1.5:3000', 'https://example.org/forge'];

describe('parseGiteaRemote', () => {
    it.each([
        ['git@git.example.com:acme/api.git', { host: 'git.example.com', owner: 'acme', repo: 'api' }],
        ['ssh://git@git.example.com:2222/acme/api.git', { host: 'git.example.com', owner: 'acme', repo: 'api' }],
        ['https://git.example.com/acme/api.git', { host: 'git.example.com', owner: 'acme', repo: 'api' }],
        ['https://dana:token@codeberg.org/forgejo/forgejo', { host: 'codeberg.org', owner: 'forgejo', repo: 'forgejo' }],
        ['http://192.168.1.5:3000/home/lab.git', { host: '192.168.1.5:3000', owner: 'home', repo: 'lab' }],
        ['git@192.168.1.5:home/lab.git', { host: '192.168.1.5:3000', owner: 'home', repo: 'lab' }],
        ['https://example.org/forge/team/web.git', { host: 'example.org', owner: 'team', repo: 'web' }]
    ])('reads %s', (url, expected) => {
        expect(parseGiteaRemote(url, SERVERS)).toEqual(expected);
    });

    it.each([
        'git@github.com:acme/api.git',
        'https://git.example.com/acme/sub/api.git',
        'https://example.org/team/web.git',
        'https://git.example.com:8443/acme/api.git',
        'not a url'
    ])('refuses %s', url => {
        expect(parseGiteaRemote(url, SERVERS)).toBeUndefined();
    });

    it('knows no server without a provider', () => {
        expect(parseGiteaRemote('https://codeberg.org/forgejo/forgejo.git', [])).toBeUndefined();
    });
});

describe('remoteServerGuess', () => {
    it.each([
        ['https://dana@git.example.com/acme/api.git', 'https://git.example.com'],
        ['http://192.168.1.5:3000/home/lab.git', 'http://192.168.1.5:3000'],
        ['git@git.example.com:acme/api.git', 'https://git.example.com'],
        ['ssh://git@Git.Example.com:2222/acme/api.git', 'https://git.example.com']
    ])('guesses the server of %s', (url, expected) => {
        expect(remoteServerGuess(url)).toBe(expected);
    });

    it('gives nothing for a local path', () => {
        expect(remoteServerGuess('/srv/git/api.git')).toBeUndefined();
    });
});

describe('Gitea references', () => {
    const ref = { owner: 'git.example.com:3000/acme', name: 'api', host: 'gitea' as const };

    it('reads the server, the owner, and the repository', () => {
        expect(giteaRepoOf(ref)).toEqual({ host: 'git.example.com:3000', owner: 'acme', repo: 'api' });
        expect(giteaRepoOf({ owner: 'acme', name: 'api', host: 'gitea' })).toBeUndefined();
        expect(giteaRepoOf({ owner: 'git.example.com/acme/sub', name: 'api', host: 'gitea' })).toBeUndefined();
        expect(giteaRepoOf({ owner: 'git.example.com/acme', name: 'api' })).toBeUndefined();
    });

    it('makes IDs, web addresses, and refs', () => {
        expect(repoId(ref)).toBe('gitea:git.example.com:3000/acme/api');
        expect(parseRepoId(repoId(ref))).toEqual(ref);
        expect(targetKey(ref)).toBe('gitea:git.example.com:3000/acme/api');
        expect(pullRequestWebUrl(ref, 7)).toBe('https://git.example.com:3000/acme/api/pulls/7');
        expect(pipelinesWebUrl(ref)).toBe('https://git.example.com:3000/acme/api/actions');
        expect(cloneUrl(ref)).toBe('https://git.example.com:3000/acme/api.git');
        expect(pullRequestRef(ref, 7)).toBe('refs/pull/7/head');
        expect(hostLabel('gitea')).toBe('Gitea');
        expect(reviewCheckoutKey(ref, 7)).toBe('gitea:git.example.com:3000/acme/api#7');
        expect(giteaCreatePullRequestUrl('https://git.example.com/acme/api', 'main', 'feat/x')).toBe(
            'https://git.example.com/acme/api/compare/main...feat%2Fx'
        );
    });

    it('reads a pull request address and a pasted link', () => {
        expect(parsePullRequestUrl('https://git.example.com/acme/api/pulls/7/files')).toEqual({
            repo: { owner: 'git.example.com/acme', name: 'api', host: 'gitea' },
            number: 7,
            tab: 'files'
        });
        expect(parsePullRequestLink('https://codeberg.org/forgejo/forgejo/pulls/42')).toEqual({
            repo: { owner: 'codeberg.org/forgejo', name: 'forgejo', host: 'gitea' },
            number: 42
        });
        // GitHub uses "/pull/", and "/pulls" without a number is the list.
        expect(parsePullRequestUrl('https://github.com/acme/api/pull/7')?.repo.host).toBeUndefined();
        expect(parsePullRequestUrl('https://git.example.com/acme/api/pulls')).toBeUndefined();
    });

    it('checks a reference from the page', () => {
        expect(checkRepoRef(ref)).toEqual(ref);
        expect(() => checkRepoRef({ owner: 'git.example.com/../etc', name: 'api', host: 'gitea' })).toThrow('not a valid Gitea or Forgejo repository name');
        expect(() => checkRepoRef({ owner: 'acme', name: 'api', host: 'gitea' })).toThrow();
    });

    it('keeps the repository, the pull request, and the comment in an ID', () => {
        const repo = { host: 'git.example.com', owner: 'acme', repo: 'api' };
        expect(decodeGiteaId(encodeGiteaId(repo, 7))).toEqual({ repo, number: 7 });
        expect(decodeGiteaId(encodeGiteaId(repo, 7, 201))).toEqual({ repo, number: 7, commentId: 201 });
        expect(decodeGiteaId('gitlab:x/y/z/1')).toBeUndefined();
        expect(decodeGiteaId('gitea:git.example.com/acme/api/0')).toBeUndefined();
    });
});

describe('drafts and merge methods', () => {
    it('adds and removes the "WIP:" prefix', () => {
        expect(hasDraftPrefix('WIP: Add limits')).toBe(true);
        expect(hasDraftPrefix('[WIP] Add limits')).toBe(true);
        expect(hasDraftPrefix('Add limits')).toBe(false);
        expect(giteaDraftTitle('Add limits', true)).toBe('WIP: Add limits');
        expect(giteaDraftTitle('[wip] Add limits', false)).toBe('Add limits');
        expect(giteaDraftTitle('WIP: Add limits', true)).toBe('WIP: Add limits');
    });

    it('reads the merge methods of a repository', () => {
        expect(giteaMergeMethods({ allow_merge_commits: true, allow_squash_merge: true, allow_rebase: false, default_merge_style: 'squash' })).toEqual({
            allowed: ['merge', 'squash'],
            preferred: 'squash'
        });
        expect(giteaMergeMethods({ allow_merge_commits: false, allow_squash_merge: false, allow_rebase: true, default_merge_style: 'merge' })).toEqual({
            allowed: ['rebase'],
            preferred: 'rebase'
        });
        expect(giteaMergeMethods({}).allowed).toEqual(['merge', 'squash', 'rebase']);
    });
});

describe('status mapping', () => {
    it.each([
        ['completed', 'success', { status: 'completed', conclusion: 'success' }],
        ['completed', 'failure', { status: 'completed', conclusion: 'failure' }],
        ['in_progress', null, { status: 'in_progress', conclusion: null }],
        ['queued', null, { status: 'queued', conclusion: null }],
        ['success', undefined, { status: 'completed', conclusion: 'success' }],
        ['cancelled', undefined, { status: 'completed', conclusion: 'cancelled' }],
        ['running', undefined, { status: 'in_progress', conclusion: null }],
        ['blocked', undefined, { status: 'waiting', conclusion: null }],
        ['unknown', undefined, { status: 'queued', conclusion: null }]
    ])('maps the Actions status %s with %s', (status, conclusion, expected) => {
        expect(actionsStatusToCheck(status, conclusion)).toEqual(expected);
    });

    it('maps the commit status states', () => {
        expect(commitStatusToCheck('success')).toEqual({ status: 'completed', conclusion: 'success' });
        expect(commitStatusToCheck('error')).toEqual({ status: 'completed', conclusion: 'error' });
        expect(commitStatusToCheck('warning')).toEqual({ status: 'completed', conclusion: 'neutral' });
        expect(commitStatusToCheck('pending')).toEqual({ status: 'pending', conclusion: null });
    });
});

describe('parseServerVersion', () => {
    it('tells Gitea from Forgejo', () => {
        expect(parseServerVersion('1.24.3')).toEqual({ product: 'Gitea', version: '1.24.3' });
        expect(parseServerVersion('7.0.0+gitea-1.22.0')).toEqual({ product: 'Forgejo', version: '7.0.0', gitea: '1.22.0' });
        expect(parseServerVersion('11.0.1-87-abc+gitea-1.22.0')).toEqual({ product: 'Forgejo', version: '11.0.1', gitea: '1.22.0' });
        expect(parseServerVersion('')).toEqual({ product: 'Gitea', version: 'unknown' });
    });
});
