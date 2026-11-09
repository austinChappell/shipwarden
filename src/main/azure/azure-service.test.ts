import { describe, expect, it } from 'vitest';
import { encodeAzureId } from '@shared/azure-devops';
import type { PullRequestChange } from '@shared/github';
import type { AzureDevOpsClient } from './azure-client';
import { withApiVersion } from './azure-client';
import { AzureDevOpsService } from './azure-service';
import buildsJson from './fixtures/builds.json';
import statusesJson from './fixtures/statuses.json';
import timelineJson from './fixtures/timeline.json';

const ROOT = '/work/shop';
const PROJECT = 'https://dev.azure.com/contoso/Web/_apis';
const REPO_ID = '3411ebc1';
const PR = `${PROJECT}/git/repositories/${REPO_ID}/pullrequests/22`;
const VIEWER = 'viewer-id';

/** Records the requests of the service and gives fixed answers, without a network. */
function recordCalls(answers: Record<string, unknown> = {}) {
    const calls: [string, string, unknown][] = [];
    const client = {
        request: async (method: string, url: string, body?: unknown) => {
            calls.push([method, url, body]);
            if (url.endsWith('/git/repositories/shop')) return { id: REPO_ID, name: 'shop', defaultBranch: 'refs/heads/main' };
            if (url.endsWith('/_apis/connectionData')) return { authenticatedUser: { id: VIEWER } };
            for (const [key, value] of Object.entries(answers)) {
                if (url.includes(key)) return value;
            }
            return undefined;
        },
        text: async (url: string) => `2026-11-02T11:28:10.1234567Z output of log ${url.split('/').pop()}`
    } as unknown as AzureDevOpsClient;
    const service = new AzureDevOpsService(client, async root => root === ROOT ? 'https://dev.azure.com/contoso/Web/_git/shop' : 'git@github.com:acme/api.git');
    const changes = () => calls.filter(([method]) => method !== 'GET');
    return { calls, changes, service };
}

describe('AzureDevOpsService', () => {
    it('owns only worktrees with an Azure Repos remote', async () => {
        const { service } = recordCalls();
        expect(await service.owns(ROOT)).toBe(true);
        expect(await service.owns('/work/api')).toBe(false);
        expect(await service.owns({ owner: 'acme', name: 'api' })).toBe(false);
    });

    it('sends the comments, the body and the vote of a review', async () => {
        const { changes, service } = recordCalls();
        await service.submitReview(ROOT, 22, 'abc', 'APPROVE_WITH_SUGGESTIONS', 'Looks good.', [
            { path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Rename this.' },
            { path: 'src/b.ts', line: 9, side: 'LEFT', body: 'Why?' }
        ]);
        expect(changes()).toEqual([
            ['POST', `${PR}/threads`, {
                comments: [{ parentCommentId: 0, content: 'Rename this.', commentType: 'text' }],
                status: 'active',
                threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 1 } }
            }],
            ['POST', `${PR}/threads`, {
                comments: [{ parentCommentId: 0, content: 'Why?', commentType: 'text' }],
                status: 'active',
                threadContext: { filePath: '/src/b.ts', leftFileStart: { line: 9, offset: 1 }, leftFileEnd: { line: 9, offset: 1 } }
            }],
            ['POST', `${PR}/threads`, { comments: [{ parentCommentId: 0, content: 'Looks good.', commentType: 'text' }], status: 'active' }],
            ['PUT', `${PR}/reviewers/${VIEWER}`, { vote: 5 }]
        ]);
    });

    it('sends no vote for a comment', async () => {
        const { changes, service } = recordCalls();
        await service.submitReview(ROOT, 22, 'abc', 'COMMENT', 'A note.', []);
        expect(changes().map(([method, url]) => [method, url])).toEqual([['POST', `${PR}/threads`]]);
    });

    it('completes a pull request with the head commit and the strategy', async () => {
        const { changes, service } = recordCalls();
        await service.merge(ROOT, 22, 'b602', 'merge');
        expect(changes()).toEqual([['PATCH', PR, { status: 'completed', lastMergeSourceCommit: { commitId: 'b602' }, completionOptions: { mergeStrategy: 'noFastForward' } }]]);
    });

    it('replies to a thread and resolves it', async () => {
        const { changes, service } = recordCalls();
        await service.replyToComment(ROOT, 22, 101, 'Fixed.');
        await service.setThreadResolved(encodeAzureId({ organization: 'contoso', project: 'Web', repository: 'shop' }, 22, 101), true);
        expect(changes()).toEqual([
            ['POST', `${PR}/threads/101/comments`, { content: 'Fixed.', parentCommentId: 1, commentType: 'text' }],
            ['PATCH', `${PR}/threads/101`, { status: 'fixed' }]
        ]);
    });

    it.each<[PullRequestChange, [string, string, unknown]]>([
        [{ kind: 'details', title: 'New title' }, ['PATCH', PR, { title: 'New title' }]],
        [{ kind: 'details', state: 'closed' }, ['PATCH', PR, { status: 'abandoned' }]],
        [{ kind: 'details', state: 'open' }, ['PATCH', PR, { status: 'active' }]],
        [{ kind: 'draft', pullRequestId: 'x', draft: true }, ['PATCH', PR, { isDraft: true }]],
        [{ kind: 'autoMerge', pullRequestId: 'x', method: 'squash', headSha: 'h' }, ['PATCH', PR, { autoCompleteSetBy: { id: VIEWER }, completionOptions: { mergeStrategy: 'squash' } }]],
        [{ kind: 'autoMerge', pullRequestId: 'x', method: null, headSha: 'h' }, ['PATCH', PR, { autoCompleteSetBy: { id: '00000000-0000-0000-0000-000000000000' } }]],
        [{ kind: 'label', name: 'ui', add: true }, ['POST', `${PR}/labels`, { name: 'ui' }]],
        [{ kind: 'label', name: 'a b', add: false }, ['DELETE', `${PR}/labels/a%20b`, undefined]]
    ])('changes a pull request: %j', async (change, expected) => {
        const { changes, service } = recordCalls();
        await service.changePullRequest(ROOT, 22, change);
        expect(changes()).toEqual([expected]);
    });

    it('adds and removes a reviewer by the ID of the login', async () => {
        const { changes, service } = recordCalls({ [PR]: { reviewers: [{ id: 'ana-id', displayName: 'Ana', uniqueName: 'ana@contoso.com', vote: 0 }] } });
        await service.changePullRequest(ROOT, 22, { kind: 'reviewer', reviewer: { kind: 'user', login: 'ana@contoso.com' }, add: false });
        expect(changes()).toEqual([['DELETE', `${PR}/reviewers/ana-id`, undefined]]);
    });

    it('refuses assignees', async () => {
        const { service } = recordCalls();
        await expect(service.changePullRequest(ROOT, 22, { kind: 'assignee', login: 'ana', add: true })).rejects.toThrow('no assignees');
    });

    it('gives the builds and the statuses of a commit as checks', async () => {
        const { service } = recordCalls({ '/build/builds?': buildsJson, '/statuses': statusesJson });
        const checks = await service.checks(ROOT, 'b60280bc6e62e2f880f1b63c1e24987664d3bda3');
        expect(checks.map(check => [check.name, check.status, check.conclusion])).toEqual([
            ['deploy-preview', 'pending', null],
            ['shop-ci', 'in_progress', null],
            ['shop-lint', 'completed', 'success'],
            ['sonarqube/quality-gate', 'completed', 'success']
        ]);
    });

    it('retries, cancels and queues builds', async () => {
        const { changes, service } = recordCalls();
        await service.rerunFailedJobs(ROOT, 905);
        await service.cancelRun(ROOT, 905);
        await service.dispatchWorkflow(ROOT, 7, 'feat/cart', { env: 'test' });
        expect(changes()).toEqual([
            ['PATCH', `${PROJECT}/build/builds/905?retry=true`, {}],
            ['PATCH', `${PROJECT}/build/builds/905`, { status: 'cancelling' }],
            ['POST', `${PROJECT}/build/builds`, { definition: { id: 7 }, sourceBranch: 'refs/heads/feat/cart', templateParameters: { env: 'test' } }]
        ]);
    });

    it('joins the task logs of a build in the order of the timeline, without timestamps', async () => {
        const { service } = recordCalls({ '/timeline': timelineJson });
        expect(await service.jobLog(ROOT, 905)).toBe([
            '##[section]Compile › Checkout shop@feat/cart',
            'output of log 3',
            '##[section]Compile › npm ci',
            'output of log 4'
        ].join('\n'));
    });

    it('keeps the viewed files in memory', async () => {
        const { service } = recordCalls({
            '/iterations/2/changes': { changeEntries: [{ changeType: 'edit', item: { path: '/src/a.ts' } }] },
            '/iterations': { value: [{ id: 1 }, { id: 2 }] }
        });
        await service.setFileViewed(encodeAzureId({ organization: 'contoso', project: 'Web', repository: 'shop' }, 22), 'src/a.ts', true);
        expect(await service.pullRequestFiles(ROOT, 22)).toEqual([{ path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0, viewed: true }]);
    });
});

describe('withApiVersion', () => {
    it('adds version 7.1 once', () => {
        expect(withApiVersion('https://dev.azure.com/a/_apis/x')).toBe('https://dev.azure.com/a/_apis/x?api-version=7.1');
        expect(withApiVersion('https://dev.azure.com/a/_apis/x?$top=5')).toBe('https://dev.azure.com/a/_apis/x?$top=5&api-version=7.1');
        expect(withApiVersion('https://dev.azure.com/a/_apis/x?api-version=7.0')).toBe('https://dev.azure.com/a/_apis/x?api-version=7.0');
        expect(withApiVersion('https://dev.azure.com/a/_apis/connectionData')).toBe('https://dev.azure.com/a/_apis/connectionData');
    });
});
