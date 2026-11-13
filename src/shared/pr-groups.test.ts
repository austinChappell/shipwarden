import { describe, expect, it } from 'vitest';
import {
    changedSinceReview,
    groupFolderNote,
    groupReviewPrompt,
    groupSize,
    movePullRequest,
    MAX_GROUP_PULL_REQUESTS,
    newGroup,
    normalizeGroup,
    parseGroupReview,
    parsePullRequestLink,
    prKey,
    withPullRequest
} from './pr-groups';

const api = { owner: 'octo', name: 'api' };
const web = { owner: 'octo', name: 'web' };
const azure = { owner: 'contoso/Web', name: 'app', host: 'azure' as const };

const PATCH = '@@ -1,2 +1,3 @@\n line one\n+added line\n line two';

function input(repo: typeof api, number: number, patch = PATCH) {
    return {
        repo,
        pr: {
            number,
            title: `PR ${number}`,
            url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
            baseRefName: 'main',
            headRefName: `feature-${number}`,
            baseRefOid: 'a'.repeat(40),
            headRefOid: 'b'.repeat(40)
        },
        files: [{ path: 'src/a.ts', status: 'modified', patch }]
    };
}

describe('parsePullRequestLink', () => {
    it('reads a GitHub link', () => {
        expect(parsePullRequestLink('https://github.com/octo/api/pull/12')).toEqual({ repo: api, number: 12 });
        expect(parsePullRequestLink(' https://github.com/octo/api/pull/12/files?x=1 ')).toEqual({ repo: api, number: 12 });
    });

    it('reads an Azure Repos link', () => {
        expect(parsePullRequestLink('https://dev.azure.com/contoso/Web/_git/app/pullrequest/7')).toEqual({ repo: azure, number: 7 });
        expect(parsePullRequestLink('https://contoso.visualstudio.com/Web/_git/app/pullrequest/7')).toEqual({ repo: azure, number: 7 });
    });

    it('reads the short form', () => {
        expect(parsePullRequestLink('octo/web#3')).toEqual({ repo: web, number: 3 });
    });

    it('refuses other texts', () => {
        expect(parsePullRequestLink('https://github.com/octo/api/issues/12')).toBeUndefined();
        expect(parsePullRequestLink('octo/web#0')).toBeUndefined();
        expect(parsePullRequestLink('hello')).toBeUndefined();
    });
});

describe('groups', () => {
    it('adds a pull request one time only', () => {
        const group = withPullRequest(newGroup(1), { repo: api, number: 1 });
        expect(withPullRequest(group, { repo: api, number: 1 })).toBe(group);
        expect(withPullRequest(group, { repo: web, number: 1 }).pullRequests.map(prKey)).toEqual(['octo/api#1', 'octo/web#1']);
    });

    it('refuses more than the maximum of pull requests', () => {
        let group = newGroup(1);
        for (let number = 1; number <= MAX_GROUP_PULL_REQUESTS; number++) group = withPullRequest(group, { repo: api, number });
        expect(() => withPullRequest(group, { repo: web, number: 1 })).toThrow(/at most/);
    });

    it('moves a pull request up and down', () => {
        const group = newGroup(1, 'x', [
            { repo: api, number: 1 },
            { repo: web, number: 2 },
            { repo: azure, number: 3 }
        ]);
        const keys = (value: typeof group) => value.pullRequests.map(prKey);
        expect(keys(movePullRequest(group, 'octo/web#2', -1))).toEqual(['octo/web#2', 'octo/api#1', 'azure:contoso/Web/app#3']);
        expect(keys(movePullRequest(group, 'octo/web#2', 1))).toEqual(['octo/api#1', 'azure:contoso/Web/app#3', 'octo/web#2']);
        expect(movePullRequest(group, 'octo/api#1', -1)).toBe(group);
        expect(movePullRequest(group, 'azure:contoso/Web/app#3', 1)).toBe(group);
        expect(movePullRequest(group, 'other/repo#9', 1)).toBe(group);
    });

    it('counts the repositories', () => {
        expect(groupSize(newGroup(1))).toBe('No PRs');
        expect(
            groupSize(
                newGroup(1, 'x', [
                    { repo: api, number: 1 },
                    { repo: api, number: 2 },
                    { repo: azure, number: 3 }
                ])
            )
        ).toBe('3 PRs in 2 repositories');
    });

    it('normalizes a saved group', () => {
        const group = normalizeGroup({
            id: 'g1',
            name: '  ',
            pullRequests: [
                { repo: api, number: 1 },
                { repo: api, number: 1 },
                { repo: { owner: '' }, number: 2 },
                { repo: azure, number: -1 }
            ],
            lastReview: { at: 5, agent: 'Claude Code', summary: 'ok', heads: { 'octo/api#1': 'abc' }, counts: { 'octo/api#1': { comments: 2, notes: -1 } } }
        });
        expect(group?.name).toBe('New group');
        expect(group?.pullRequests).toEqual([{ repo: api, number: 1 }]);
        expect(group?.lastReview?.counts['octo/api#1']).toEqual({ comments: 2, notes: 0 });
        expect(normalizeGroup({ name: 'no id' })).toBeUndefined();
    });

    it('finds a pull request that changed since the last review', () => {
        const group = { lastReview: { at: 1, agent: '', summary: '', heads: { 'octo/api#1': 'abc' }, counts: {} } };
        expect(changedSinceReview(group, 'octo/api#1', 'abc')).toBe(false);
        expect(changedSinceReview(group, 'octo/api#1', 'def')).toBe(true);
        expect(changedSinceReview(group, 'octo/web#2', 'abc')).toBe(true);
        expect(changedSinceReview({}, 'octo/api#1', 'abc')).toBe(false);
    });
});

describe('groupReviewPrompt', () => {
    it('has each pull request, the note and the answer shape', () => {
        const prompt = groupReviewPrompt({ name: 'Auth', note: 'Merge the API first.', pullRequests: [input(api, 1), input(web, 2)] });
        expect(prompt).toContain('Review these 2 pull requests together');
        expect(prompt).toContain('Merge the API first.');
        expect(prompt).toContain('## Pull request 1: octo/api#1');
        expect(prompt).toContain('## Pull request 2: octo/web#2');
        expect(prompt).toContain('"pullRequests"');
    });

    it('has the instructions of the strictness level and the group scope', () => {
        const prompt = groupReviewPrompt({ name: 'Auth', note: '', pullRequests: [input(api, 1)], strictness: 'strict' });
        expect(prompt).toContain('also for small problems');
        expect(prompt).toContain('Look most at the problems between the pull requests');
    });

    it('gives each pull request a part of the diff limit', () => {
        const big = `@@ -1 +1 @@\n+${'x'.repeat(150_000)}`;
        const prompt = groupReviewPrompt({ name: 'Big', note: '', pullRequests: [input(api, 1, big), input(web, 2)] });
        expect(prompt).toContain('the diff is too large for this prompt');
        expect(prompt).toContain('+added line');
    });
});

describe('groupFolderNote', () => {
    it('lists the folders', () => {
        expect(groupFolderNote([{ key: 'octo/api#1', path: '/r/api' }])).toContain('- octo/api#1: /r/api');
    });
});

describe('parseGroupReview', () => {
    const files = [{ path: 'src/a.ts', patch: PATCH }];

    it('puts the comments on the pull requests', () => {
        const answer = JSON.stringify({
            summary: 'The client does not send the new field.',
            pullRequests: [
                { pr: 'octo/api#1', summary: 'API ok', comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Check this' }] },
                { pr: 'OCTO/WEB#2', summary: '', comments: [{ path: 'src/a.ts', line: 99, body: 'Not on a line' }] }
            ]
        });
        const result = parseGroupReview(answer, [
            { key: 'octo/api#1', files },
            { key: 'octo/web#2', files }
        ]);
        expect(result.summary).toBe('The client does not send the new field.');
        expect(result.reviews.get('octo/api#1')?.comments).toHaveLength(1);
        expect(result.reviews.get('octo/web#2')?.comments).toHaveLength(0);
        expect(result.reviews.get('octo/web#2')?.unplaced).toHaveLength(1);
    });

    it('keeps the notes for an unknown pull request in the summary', () => {
        const answer = JSON.stringify({ summary: 'S', pullRequests: [{ pr: 'other/repo#9', summary: 'Lost', comments: [{ path: 'x', line: 1, body: 'B' }] }] });
        const result = parseGroupReview(answer, [{ key: 'octo/api#1', files }]);
        expect(result.reviews.size).toBe(0);
        expect(result.summary).toContain('Notes for other/repo#9');
        expect(result.summary).toContain('Lost');
        expect(result.summary).toContain('B');
    });

    it('uses all of an answer that is not JSON as the summary', () => {
        expect(parseGroupReview('plain text', [])).toEqual({ summary: 'plain text', reviews: new Map() });
    });
});
