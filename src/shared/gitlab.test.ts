import { describe, expect, it } from 'vitest';
import { parsePullRequestUrl, pipelinesWebUrl, pullRequestRef, pullRequestWebUrl, repoId, parseRepoId, cloneUrl } from './github';
import {
    cleanGitLabTrace,
    decodeGitLabId,
    diffLinePosition,
    draftTitle,
    encodeGitLabId,
    gitlabHostOf,
    gitlabProjectId,
    gitlabRepoOf,
    gitlabRepoRef,
    inGroups,
    jobStatusToCheck,
    normalizeGitLabUrl,
    parseGitLabRemote,
    patchLineCounts,
    reviewEventsAfter
} from './gitlab';

describe('parseGitLabRemote', () => {
    it('reads gitlab.com remotes with nested groups', () => {
        const expected = { host: 'gitlab.com', namespace: 'acme/platform/backend', project: 'api' };
        expect(parseGitLabRemote('git@gitlab.com:acme/platform/backend/api.git')).toEqual(expected);
        expect(parseGitLabRemote('ssh://git@gitlab.com/acme/platform/backend/api.git')).toEqual(expected);
        expect(parseGitLabRemote('https://gitlab.com/acme/platform/backend/api.git')).toEqual(expected);
        expect(parseGitLabRemote('https://oauth2:secret@gitlab.com/acme/platform/backend/api')).toEqual(expected);
        expect(parseGitLabRemote('https://gitlab.com/acme/platform/backend/api/')).toEqual(expected);
    });

    it('reads a remote of a configured self-hosted server', () => {
        const servers = ['https://git.example.com'];
        expect(parseGitLabRemote('git@git.example.com:team/web.git', servers)).toEqual({ host: 'git.example.com', namespace: 'team', project: 'web' });
        expect(parseGitLabRemote('ssh://git@git.example.com:2222/team/sub/web.git', servers)).toEqual({
            host: 'git.example.com',
            namespace: 'team/sub',
            project: 'web'
        });
        expect(parseGitLabRemote('https://git.example.com/team/web.git', servers)?.project).toBe('web');
    });

    it('matches the port and the folder of a self-hosted server', () => {
        const servers = ['https://example.com:8443/gitlab'];
        expect(parseGitLabRemote('https://example.com:8443/gitlab/team/web.git', servers)).toEqual({
            host: 'example.com:8443',
            namespace: 'team',
            project: 'web'
        });
        // SSH uses another port, so only the host name must match. The folder is not in an SSH path.
        expect(parseGitLabRemote('git@example.com:team/web.git', servers)).toEqual({ host: 'example.com:8443', namespace: 'team', project: 'web' });
        expect(parseGitLabRemote('https://example.com:8443/team/web.git', servers)).toBeUndefined();
    });

    it('ignores other hosts and short paths', () => {
        expect(parseGitLabRemote('git@github.com:acme/api.git')).toBeUndefined();
        expect(parseGitLabRemote('https://dev.azure.com/contoso/Web/_git/shop')).toBeUndefined();
        expect(parseGitLabRemote('https://git.example.com/team/web.git')).toBeUndefined();
        expect(parseGitLabRemote('https://gitlab.com/acme')).toBeUndefined();
        expect(parseGitLabRemote('')).toBeUndefined();
    });

    it('decodes the parts of the path', () => {
        expect(parseGitLabRemote('https://gitlab.com/acme/my%20group/api.git')?.namespace).toBe('acme/my group');
    });
});

describe('GitLab references', () => {
    const repo = { host: 'gitlab.com', namespace: 'acme/platform', project: 'api' };

    it('round-trips a reference and URL-encodes the full path for the API', () => {
        const ref = gitlabRepoRef(repo);
        expect(ref).toEqual({ owner: 'gitlab.com/acme/platform', name: 'api', host: 'gitlab' });
        expect(gitlabRepoOf(ref)).toEqual(repo);
        expect(gitlabRepoOf({ owner: 'acme', name: 'api' })).toBeUndefined();
        expect(gitlabProjectId(repo)).toBe('acme%2Fplatform%2Fapi');
    });

    it('gives the web pages, the clone URL and the head ref of a merge request', () => {
        const ref = gitlabRepoRef(repo);
        expect(pullRequestWebUrl(ref, 42)).toBe('https://gitlab.com/acme/platform/api/-/merge_requests/42');
        expect(pipelinesWebUrl(ref)).toBe('https://gitlab.com/acme/platform/api/-/pipelines');
        expect(cloneUrl(ref)).toBe('https://gitlab.com/acme/platform/api.git');
        expect(pullRequestRef(ref, 42)).toBe('refs/merge-requests/42/head');
    });

    it('round-trips a repository ID', () => {
        const ref = gitlabRepoRef(repo);
        expect(repoId(ref)).toBe('gitlab:gitlab.com/acme/platform/api');
        expect(parseRepoId(repoId(ref))).toEqual(ref);
    });

    it('reads a merge request web URL', () => {
        expect(parsePullRequestUrl('https://gitlab.com/acme/platform/api/-/merge_requests/42/diffs?commit_id=abc')).toEqual({
            repo: { owner: 'gitlab.com/acme/platform', name: 'api', host: 'gitlab' },
            number: 42,
            tab: 'files'
        });
    });

    it('round-trips a thread ID with a discussion', () => {
        const id = encodeGitLabId(repo, 42, '6a9c1750b37d');
        expect(id.startsWith('gitlab:')).toBe(true);
        expect(decodeGitLabId(id)).toEqual({ repo, iid: 42, discussionId: '6a9c1750b37d' });
        expect(decodeGitLabId(encodeGitLabId(repo, 7))).toEqual({ repo, iid: 7 });
        expect(decodeGitLabId('azure:a/b/c/1')).toBeUndefined();
    });

    it('checks the groups of a scope, with subgroups', () => {
        expect(inGroups('acme/platform/api', ['acme'])).toBe(true);
        expect(inGroups('acme/platform/api', ['ACME/platform'])).toBe(true);
        expect(inGroups('acmecorp/api', ['acme'])).toBe(false);
        expect(inGroups('other/api', undefined)).toBe(true);
    });
});

describe('server URLs', () => {
    it('cleans a server URL', () => {
        expect(normalizeGitLabUrl('git.example.com/')).toBe('https://git.example.com');
        expect(normalizeGitLabUrl('http://example.com:8080/gitlab/')).toBe('http://example.com:8080/gitlab');
        expect(normalizeGitLabUrl('')).toBeUndefined();
        expect(normalizeGitLabUrl('ftp://example.com')).toBeUndefined();
        expect(gitlabHostOf(undefined)).toBe('gitlab.com');
        expect(gitlabHostOf('https://Git.Example.com:8443')).toBe('git.example.com:8443');
    });
});

describe('review events', () => {
    it('swaps the approval button after an approval and after a revoke', () => {
        expect(reviewEventsAfter('gitlab', ['COMMENT', 'APPROVE'], 'APPROVE')).toEqual(['COMMENT', 'UNAPPROVE']);
        expect(reviewEventsAfter('gitlab', ['COMMENT', 'UNAPPROVE'], 'UNAPPROVE')).toEqual(['COMMENT', 'APPROVE']);
        expect(reviewEventsAfter('gitlab', ['COMMENT', 'APPROVE'], 'COMMENT')).toEqual(['COMMENT', 'APPROVE']);
        expect(reviewEventsAfter('azure', ['COMMENT', 'APPROVE'], 'APPROVE')).toEqual(['COMMENT', 'APPROVE']);
    });
});

describe('jobStatusToCheck', () => {
    it('maps the job states to the checks panel', () => {
        expect(jobStatusToCheck('success')).toEqual({ status: 'completed', conclusion: 'success' });
        expect(jobStatusToCheck('failed')).toEqual({ status: 'completed', conclusion: 'failure' });
        expect(jobStatusToCheck('failed', true)).toEqual({ status: 'completed', conclusion: 'neutral' });
        expect(jobStatusToCheck('manual')).toEqual({ status: 'completed', conclusion: 'skipped' });
        expect(jobStatusToCheck('running')).toEqual({ status: 'in_progress', conclusion: null });
        expect(jobStatusToCheck('pending')).toEqual({ status: 'queued', conclusion: null });
        expect(jobStatusToCheck('scheduled')).toEqual({ status: 'waiting', conclusion: null });
        expect(jobStatusToCheck('canceled')).toEqual({ status: 'completed', conclusion: 'cancelled' });
    });
});

describe('cleanGitLabTrace', () => {
    it('removes the section markers and the color codes', () => {
        const trace =
            '\x1b[0KRunning with gitlab-runner 17.5.0\r\nsection_start:1731601000:prepare_script\r\x1b[0K\x1b[0K\x1b[36;1mPreparing\x1b[0;m\nok\nsection_end:1731601002:prepare_script\r\x1b[0K\n50%\r100%\n';
        expect(cleanGitLabTrace(trace)).toBe('Running with gitlab-runner 17.5.0\nPreparing\nok\n\n100%\n');
    });
});

describe('diffLinePosition', () => {
    const patch = [
        '@@ -8,6 +8,9 @@ import',
        ' export interface Limit {',
        '     perMinute: number;',
        ' }',
        '+',
        '+export const DEFAULT_LIMIT = 100;',
        '+export const limitOf = () => 1;',
        ' ',
        ' export function check(): boolean {',
        '-    return used < 60;',
        '+    return used < limit;',
        ' }'
    ].join('\n');

    it('gives only the new line for an added line and only the old line for a removed line', () => {
        expect(diffLinePosition(patch, 'RIGHT', 12)).toEqual({ new_line: 12 });
        expect(diffLinePosition(patch, 'LEFT', 13)).toEqual({ old_line: 13 });
        expect(diffLinePosition(patch, 'RIGHT', 16)).toEqual({ new_line: 16 });
    });

    it('gives both lines for a line without a change', () => {
        expect(diffLinePosition(patch, 'RIGHT', 9)).toEqual({ old_line: 9, new_line: 9 });
        expect(diffLinePosition(patch, 'RIGHT', 15)).toEqual({ old_line: 12, new_line: 15 });
        expect(diffLinePosition(patch, 'LEFT', 12)).toEqual({ old_line: 12, new_line: 15 });
        expect(diffLinePosition(patch, 'RIGHT', 17)).toEqual({ old_line: 14, new_line: 17 });
    });

    it('moves the lines out of the hunks by the change of the hunks before them', () => {
        expect(diffLinePosition(patch, 'RIGHT', 3)).toEqual({ old_line: 3, new_line: 3 });
        expect(diffLinePosition(patch, 'RIGHT', 30)).toEqual({ old_line: 27, new_line: 30 });
        expect(diffLinePosition(undefined, 'RIGHT', 5)).toEqual({ new_line: 5 });
    });
});

describe('small helpers', () => {
    it('counts the lines of a patch and sets the draft prefix', () => {
        expect(patchLineCounts('@@ -1,2 +1,2 @@\n-a\n+b\n c')).toEqual({ additions: 1, deletions: 1 });
        expect(draftTitle('Add limits', true)).toBe('Draft: Add limits');
        expect(draftTitle('Draft: Add limits', false)).toBe('Add limits');
        expect(draftTitle('[WIP] Add limits', true)).toBe('Draft: Add limits');
    });
});
