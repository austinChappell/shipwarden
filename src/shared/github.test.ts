import { describe, expect, it } from 'vitest';
import { cleanActionsLog, latestChecks, parseActionsRunId, parseGitHubRemote, pullRequestSearch, signedImageUrls, summarizeChecks, tailLines, targetKey, withSignedImages, type CheckRun } from './github';

describe('parseGitHubRemote', () => {
    it.each([
        ['git@github.com:band-office/band-office.git', { owner: 'band-office', name: 'band-office' }],
        ['git@github.com:austinChappell/drum_app', { owner: 'austinChappell', name: 'drum_app' }],
        ['https://github.com/owner/repo.git', { owner: 'owner', name: 'repo' }],
        ['https://token@github.com/owner/repo', { owner: 'owner', name: 'repo' }],
        ['ssh://git@github.com/owner/my.repo.git', { owner: 'owner', name: 'my.repo' }],
        ['git@gitlab.com:owner/repo.git', undefined],
        ['', undefined]
    ])('parses %p', (url, expected) => {
        expect(parseGitHubRemote(url)).toEqual(expected);
    });
});

describe('parseActionsRunId', () => {
    it('finds the run ID in a job URL', () => {
        expect(parseActionsRunId('https://github.com/o/r/actions/runs/123456/job/789')).toBe(123456);
        expect(parseActionsRunId('https://example.com/build/1')).toBeUndefined();
        expect(parseActionsRunId(null)).toBeUndefined();
    });
});

describe('latestChecks', () => {
    it('keeps the newest check run of each name', () => {
        const run = (id: number, name: string, conclusion: CheckRun['conclusion']): CheckRun =>
            ({ id, name, status: 'completed', conclusion, startedAt: null, completedAt: null, url: null, isActions: true });
        const result = latestChecks([run(1, 'test', 'failure'), run(5, 'test', 'success'), run(2, 'lint', 'success')]);
        expect(result.map(check => `${check.name}:${check.id}`).sort()).toEqual(['lint:2', 'test:5']);
    });
});

describe('summarizeChecks', () => {
    const check = (status: CheckRun['status'], conclusion: CheckRun['conclusion']): CheckRun =>
        ({ id: 1, name: 'x', status, conclusion, startedAt: null, completedAt: null, url: null, isActions: true });

    it('reports failure first, then pending, then success', () => {
        expect(summarizeChecks([])).toBe('none');
        expect(summarizeChecks([check('completed', 'success'), check('completed', 'skipped')])).toBe('success');
        expect(summarizeChecks([check('completed', 'success'), check('in_progress', null)])).toBe('pending');
        expect(summarizeChecks([check('in_progress', null), check('completed', 'failure')])).toBe('failure');
    });
});

describe('cleanActionsLog', () => {
    it('removes timestamps and ANSI codes', () => {
        const log = '﻿2026-11-07T05:51:12.1234567Z ##[group]Run npm test\n2026-11-07T05:51:13.0000000Z \x1b[31mFAIL\x1b[0m src/a.test.ts';
        expect(cleanActionsLog(log)).toBe('##[group]Run npm test\nFAIL src/a.test.ts');
    });
});

describe('tailLines', () => {
    it('returns the last lines', () => {
        expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd');
        expect(tailLines('a', 5)).toBe('a');
    });
});

describe('pullRequestSearch', () => {
    const repo = { owner: 'acme', name: 'api' };

    it('builds the GitHub search query of a filter', () => {
        expect(pullRequestSearch(repo, 'open')).toBe('repo:acme/api is:pr is:open');
        expect(pullRequestSearch(repo, 'review', '  fix login ')).toBe('repo:acme/api is:pr is:open review-requested:@me fix login');
        expect(pullRequestSearch(repo, 'closed', '')).toBe('repo:acme/api is:pr is:closed');
    });

    it('gives a repository and a worktree root different keys', () => {
        expect(targetKey(repo)).not.toBe(targetKey('/r/api'));
    });
});

describe('signed images', () => {
    const id = '34a15867-5bac-4ecb-8394-baa1987c06e5';
    const signed = `https://private-user-images.githubusercontent.com/1/2-${id}.png?jwt=abc.def-g_h&amp;x=1`;

    it('finds the signed URL of each attachment and replaces the attachment link', () => {
        const urls = signedImageUrls([`<p><img alt="a" src="${signed}" style="x"></p>`]);
        expect(urls.get(id)).toBe(signed.replace('&amp;', '&'));
        const body = `Before <img src="https://github.com/user-attachments/assets/${id}" /> and ![b](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000)`;
        expect(withSignedImages(body, urls)).toBe(
            `Before <img src="${signed.replace('&amp;', '&')}" /> and ![b](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000)`
        );
    });

    it('keeps the text when there are no signed URLs', () => {
        expect(withSignedImages('no images', new Map())).toBe('no images');
    });
});
