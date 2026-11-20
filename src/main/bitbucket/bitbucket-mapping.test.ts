import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { decodeBitbucketId } from '@shared/bitbucket';
import {
    branchSummaries,
    commitStatusToCheckRun,
    isPipelinesStatus,
    mapCommits,
    mapFiles,
    mapPullRequest,
    mergedBranches,
    mergeStateOf,
    myPullRequestItemOf,
    NumericIds,
    openPullRequestOf,
    pipelinesByCommit,
    pipelineState,
    pipelineToRun,
    pullRequestSummaryOf,
    repoOfPullRequest,
    reviewDecisionOf,
    stepProgressOf,
    stepToCheck,
    type BbBranch,
    type BbComment,
    type BbCommit,
    type BbCommitStatus,
    type BbDiffStat,
    type BbPipeline,
    type BbPullRequest,
    type BbStep
} from './bitbucket-mapping';
import branchJson from './fixtures/branch.json';
import commentsJson from './fixtures/comments.json';
import commitsJson from './fixtures/commits.json';
import diffstatJson from './fixtures/diffstat.json';
import pipelinesJson from './fixtures/pipelines.json';
import pullRequestJson from './fixtures/pull-request.json';
import pullRequestsJson from './fixtures/pull-requests.json';
import statusesJson from './fixtures/statuses.json';
import stepsJson from './fixtures/steps.json';

const repo = { workspace: 'acme', repo: 'api' };
const pr = pullRequestJson as unknown as BbPullRequest;
const comments = commentsJson as unknown as BbComment[];
const commits = commitsJson as unknown as BbCommit[];
const diffstat = diffstatJson as unknown as BbDiffStat[];
const pipelines = pipelinesJson as unknown as BbPipeline[];
const steps = stepsJson as unknown as BbStep[];
const statuses = statusesJson as unknown as BbCommitStatus[];
const branch = branchJson as BbBranch;
const list = pullRequestsJson as unknown as BbPullRequest[];
const diff = readFileSync(new URL('./fixtures/pull-request.diff', import.meta.url), 'utf8');
const VIEWER = { uuid: '{8c3e3f50-4d66-4f3e-9c98-3a3b8e3f2c03}', display_name: 'Viewer Person', nickname: 'viewer' };

describe('mapPullRequest', () => {
    const mapped = mapPullRequest({ repo, pr, comments, commits, diffstat, branch, checkCount: 3, viewer: VIEWER });

    it('maps the details, the branches, and the full head commit', () => {
        expect(mapped).toMatchObject({
            number: 17,
            title: 'Add rate limits to the public API',
            body: 'This adds a token bucket to the public endpoints.\n\nCloses #12.',
            url: 'https://bitbucket.org/acme/api/pull-requests/17',
            state: 'OPEN',
            isDraft: false,
            host: 'bitbucket',
            author: { login: 'dana', name: 'Dana Kim', avatarUrl: 'https://avatar-management.example/dana.png' },
            baseRefName: 'main',
            headRefName: 'feature/rate-limits',
            isCrossRepository: false,
            headRefOid: '9f2c4e1b7a6d5c4b3a291807f6e5d4c3b2a19080',
            baseRefOid: '3b5d7f9a1c2e',
            additions: 5,
            deletions: 3,
            changedFiles: 4,
            checkCount: 3,
            commitCount: 2,
            hasAssignees: false,
            labels: [],
            reactionKinds: []
        });
        expect(decodeBitbucketId(mapped.id)).toEqual({ repo, id: 17 });
    });

    it('maps the approvals and the reviewers who did not review yet', () => {
        expect(mapped.reviewDecision).toBe('APPROVED');
        expect(mapped.reviews).toEqual([expect.objectContaining({ author: expect.objectContaining({ login: 'lee' }), state: 'APPROVED' })]);
        expect(mapped.reviewRequests).toEqual([{ kind: 'user', login: 'viewer' }]);
        expect(mapped.viewerIsRequested).toBe(true);
        expect(mapped.reviewEvents).toEqual(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']);
    });

    it('swaps the approve button when the viewer approved', () => {
        const approved = mapPullRequest({
            repo,
            pr: { ...pr, participants: [{ user: VIEWER, role: 'REVIEWER', approved: true, state: 'approved' }] },
            comments: [],
            commits,
            viewer: VIEWER
        });
        expect(approved.reviewEvents).toEqual(['COMMENT', 'REQUEST_CHANGES', 'UNAPPROVE']);
        expect(approved.viewerIsRequested).toBe(false);
    });

    it('maps the merge strategies of the destination branch', () => {
        expect(mapped.allowedMergeMethods).toEqual(['merge', 'squash', 'rebase']);
        expect(mapped.defaultMergeMethod).toBe('squash');
        expect(mapped.mergeable).toBe('MERGEABLE');
        expect(mapped.mergeStateStatus).toBe('CLEAN');
        expect(mapped.viewerCanEnableAutoMerge).toBe(false);
    });

    it('makes threads of the inline comments, with replies to replies in the thread of the first comment', () => {
        expect(mapped.threads).toHaveLength(2);
        const [open, resolved] = mapped.threads;
        expect(open).toMatchObject({ path: 'src/limits.ts', line: 12, side: 'RIGHT', isResolved: false, isOutdated: false });
        expect(open.comments.map(comment => comment.body)).toEqual([
            'Should the limit come from the settings?',
            'Yes. I will move it.',
            'Done in the next commit.'
        ]);
        expect(open.comments.every(comment => comment.databaseId === 501)).toBe(true);
        expect(decodeBitbucketId(open.id)).toEqual({ repo, id: 17, commentId: 501 });
        expect(resolved).toMatchObject({
            path: 'src/server.ts',
            line: null,
            originalLine: 7,
            originalStartLine: 5,
            side: 'LEFT',
            isResolved: true,
            isOutdated: true
        });
    });

    it('keeps the general comments in the conversation and leaves out deleted comments', () => {
        expect(mapped.issueComments).toEqual([
            {
                id: 'bitbucket-comment:520',
                author: expect.objectContaining({ login: 'sam' }),
                body: 'Thanks. The tests pass on my machine.',
                createdAt: '2026-11-18T11:00:00.000000+00:00',
                url: 'https://bitbucket.org/acme/api/pull-requests/17#comment-520'
            }
        ]);
    });

    it('maps the commits, the oldest first', () => {
        expect(mapCommits(repo, commits)).toEqual([
            expect.objectContaining({ abbreviatedOid: '1a2b3c4', messageHeadline: 'Add a token bucket', author: 'CI Bot' }),
            expect.objectContaining({
                abbreviatedOid: '9f2c4e1',
                messageHeadline: 'Move the limit to the settings',
                author: 'dana',
                url: 'https://bitbucket.org/acme/api/commits/9f2c4e1b7a6d5c4b3a291807f6e5d4c3b2a19080'
            })
        ]);
    });
});

describe('review and merge state', () => {
    it('reads the review decision from the participants', () => {
        expect(
            reviewDecisionOf(
                [
                    { user: VIEWER, state: 'changes_requested' },
                    { user: { uuid: 'x' }, approved: true }
                ],
                1
            )
        ).toBe('CHANGES_REQUESTED');
        expect(reviewDecisionOf([{ user: VIEWER, approved: true }], 1)).toBe('APPROVED');
        expect(reviewDecisionOf([], 2)).toBe('REVIEW_REQUIRED');
        expect(reviewDecisionOf(undefined, 0)).toBeNull();
    });

    it('finds conflicts in the diffstat', () => {
        expect(mergeStateOf(pr, [{ status: 'merge conflict', new: { path: 'a' } }], null)).toEqual({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
        expect(mergeStateOf({ ...pr, draft: true }, diffstat, null)).toEqual({ mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' });
        expect(mergeStateOf(pr, diffstat, 'CHANGES_REQUESTED').mergeStateStatus).toBe('BLOCKED');
        expect(mergeStateOf(pr, undefined, null)).toEqual({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
    });
});

describe('mapFiles', () => {
    it('maps the diffstat with the hunks of each file', () => {
        const files = mapFiles(diffstat, diff);
        expect(files.map(file => [file.path, file.status, file.additions, file.deletions, file.previousPath])).toEqual([
            ['src/limits.ts', 'modified', 2, 1, undefined],
            ['src/bucket.ts', 'added', 3, 0, undefined],
            ['docs/limits.md', 'renamed', 0, 0, 'docs/old.md'],
            ['src/legacy.ts', 'removed', 0, 2, undefined]
        ]);
        expect(files[0].patch).toBe('@@ -10,4 +10,5 @@ export const limits = {\n   window: 60,\n-  max: 100,\n+  max: settings.max,\n+  burst: 10,\n };');
        expect(files[1].patch).toBe('@@ -0,0 +1,3 @@\n+export class Bucket {\n+  tokens = 0;\n+}');
        expect(files[2].patch).toBeUndefined();
        expect(files[3].patch).toContain('-export const old = true;');
    });
});

describe('pipelines', () => {
    const ids = new NumericIds();

    it('maps the steps of a pipeline to checks with logs', () => {
        const checks = steps.map(step => stepToCheck(repo, pipelines[0], step, ids));
        expect(checks.map(check => [check.name, check.status, check.conclusion, check.isActions])).toEqual([
            ['Lint', 'completed', 'success', true],
            ['Unit tests', 'completed', 'failure', true],
            ['Deploy to staging', 'completed', 'skipped', true]
        ]);
        expect(checks[1].url).toBe('https://bitbucket.org/acme/api/pipelines/results/42/steps/%7Bb0000000-0000-0000-0000-000000000002%7D');
        expect(new Set(checks.map(check => check.id)).size).toBe(3);
        expect(checks.every(check => check.runId === checks[0].runId)).toBe(true);
        expect(ids.keyOf(checks[1].id)).toBe('step:{a0000000-0000-0000-0000-000000000042}:{b0000000-0000-0000-0000-000000000002}');
        expect(stepProgressOf(steps[1])).toMatchObject({ status: 'completed', conclusion: 'failure', steps: [] });
    });

    it('maps the commit statuses and finds the statuses of Pipelines', () => {
        expect(statuses.map(isPipelinesStatus)).toEqual([true, false, false]);
        expect(commitStatusToCheckRun(statuses[1], ids)).toMatchObject({ name: 'SonarCloud', conclusion: 'success', isStatus: true, isActions: false });
        expect(commitStatusToCheckRun(statuses[2], ids)).toMatchObject({ name: 'jenkins-e2e', status: 'in_progress', completedAt: null });
    });

    it('maps the pipelines to runs', () => {
        const runs = pipelines.map(pipeline => pipelineToRun(repo, pipeline, ids));
        expect(runs[0]).toMatchObject({
            title: 'Pipeline #42 on Add rate limits to the public API',
            runNumber: 42,
            branch: 'feature/rate-limits',
            event: 'push',
            status: 'completed',
            conclusion: 'failure',
            actor: 'dana',
            url: 'https://bitbucket.org/acme/api/pipelines/results/42'
        });
        expect(runs[1]).toMatchObject({ branch: 'main', event: 'manual', status: 'in_progress', conclusion: null });
        expect(ids.keyOf(runs[0].id)).toBe('pipeline:{a0000000-0000-0000-0000-000000000042}');
    });

    it('gives the newest pipeline of each commit by its short hash', () => {
        const byCommit = pipelinesByCommit(pipelines);
        expect(pipelineState(byCommit.get('9f2c4e1b7a6d'))).toBe('FAILURE');
        expect(pipelineState(byCommit.get('3b5d7f9a1c2e'))).toBe('PENDING');
        expect(pipelineState(byCommit.get('1a2b3c4d5e6f'))).toBe('SUCCESS');
        expect(pipelineState(undefined)).toBeNull();
    });
});

describe('lists', () => {
    const byCommit = pipelinesByCommit(pipelines);

    it('maps the open pull requests for the review queue', () => {
        const items = list.map(item => openPullRequestOf(repo, item, byCommit, VIEWER));
        expect(items[0]).toMatchObject({ number: 17, reviewRequested: true, checks: { state: 'FAILURE', failing: 1, total: 1 }, reviewers: ['viewer'] });
        expect(items[1]).toMatchObject({ number: 18, viewerDidAuthor: true, reviewDecision: 'CHANGES_REQUESTED', actions: ['changes-requested'] });
        // A draft asks for no review.
        expect(items[2]).toMatchObject({ number: 19, isDraft: true, reviewRequested: false });
    });

    it('maps the rows of the pull request list', () => {
        expect(pullRequestSummaryOf(list[1], byCommit, VIEWER)).toMatchObject({
            number: 18,
            author: 'viewer',
            reviewStatus: 'changes-requested',
            checks: null,
            viewerDidAuthor: true
        });
        expect(pullRequestSummaryOf({ ...list[0], state: 'DECLINED' }, byCommit, VIEWER)).toMatchObject({ state: 'CLOSED', checks: null });
    });

    it('maps the Dashboard items, the merged branches, and the branch summaries', () => {
        expect(myPullRequestItemOf(repo, list[1])).toMatchObject({
            number: 18,
            reasons: ['changes-requested'],
            repo: { owner: 'acme', name: 'api', host: 'bitbucket' }
        });
        expect(myPullRequestItemOf(repo, list[0])).toBeUndefined();
        expect(repoOfPullRequest(list[2])).toEqual(repo);
        expect(mergedBranches([{ ...list[0], state: 'MERGED' }, list[1]])).toEqual({
            'feature/rate-limits': { number: 17, title: 'Add rate limits to the public API', headSha: '9f2c4e1b7a6d' }
        });
        const summaries = branchSummaries(list, byCommit, VIEWER);
        expect(summaries['feature/rate-limits']).toMatchObject({ number: 17, checks: 'FAILURE', viewerRole: 'involved' });
        expect(summaries['fix/login']).toMatchObject({ viewerRole: 'author', reviewDecision: 'CHANGES_REQUESTED' });
    });
});
