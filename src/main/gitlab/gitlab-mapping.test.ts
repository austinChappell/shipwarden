import { describe, expect, it } from 'vitest';
import { decodeGitLabId } from '@shared/gitlab';
import {
    branchSummaries,
    jobProgressOf,
    jobToCheck,
    latestJobs,
    mapDiffs,
    mapMergeRequest,
    mergedBranches,
    mergeMethodsOf,
    mergeRequestSummaryOf,
    mergeStateOf,
    myMergeRequestItemOf,
    openMergeRequestOf,
    pipelinesBySha,
    pipelineState,
    pipelineToRun,
    repoOfMergeRequest,
    reviewDecisionOf,
    type GlApprovals,
    type GlCommit,
    type GlDiff,
    type GlDiscussion,
    type GlJob,
    type GlMergeRequest,
    type GlPipeline
} from './gitlab-mapping';
import approvalsJson from './fixtures/approvals.json';
import commitsJson from './fixtures/commits.json';
import diffsJson from './fixtures/diffs.json';
import discussionsJson from './fixtures/discussions.json';
import jobsJson from './fixtures/jobs.json';
import mergeRequestJson from './fixtures/merge-request.json';
import mergeRequestsJson from './fixtures/merge-requests.json';
import pipelinesJson from './fixtures/pipelines.json';

const repo = { host: 'gitlab.com', namespace: 'acme/platform', project: 'api' };
const mr = mergeRequestJson as unknown as GlMergeRequest;
const approvals = approvalsJson as unknown as GlApprovals;
const discussions = discussionsJson as unknown as GlDiscussion[];
const commits = commitsJson as GlCommit[];
const diffs = diffsJson as GlDiff[];
const jobs = jobsJson as unknown as GlJob[];
const pipelines = pipelinesJson as unknown as GlPipeline[];
const list = mergeRequestsJson as unknown as GlMergeRequest[];
const VIEWER = 303;

describe('mapMergeRequest', () => {
    const pr = mapMergeRequest({
        repo,
        mr,
        approvals,
        discussions,
        commits,
        checkCount: 1,
        viewerId: VIEWER,
        project: { id: 3471, path_with_namespace: 'acme/platform/api' }
    });

    it('maps the fields of the merge request', () => {
        expect(pr).toMatchObject({
            number: 42,
            title: 'Draft: Add rate limits to the public API',
            body: 'Adds a token bucket per API key.\n\nCloses #17.',
            url: 'https://gitlab.com/acme/platform/api/-/merge_requests/42',
            state: 'OPEN',
            isDraft: true,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'DRAFT',
            author: { login: 'dana', name: 'Dana Ruiz' },
            baseRefName: 'main',
            headRefName: 'feature/rate-limits',
            isCrossRepository: false,
            baseRefOid: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
            headRefOid: '9f2c1e7a4b5d6c8e0f1a2b3c4d5e6f708192a3b4',
            changedFiles: 3,
            viewerDidAuthor: false,
            commitCount: 2,
            checkCount: 1,
            host: 'gitlab',
            viewerCanMerge: true,
            autoMerge: null,
            viewerCanEnableAutoMerge: true
        });
        expect(decodeGitLabId(pr.id)).toEqual({ repo, iid: 42 });
    });

    it('maps the approvals, the reviewers, the assignees, and the labels', () => {
        expect(pr.reviewDecision).toBe('REVIEW_REQUIRED');
        expect(pr.reviews).toEqual([expect.objectContaining({ author: expect.objectContaining({ login: 'lee' }), state: 'APPROVED' })]);
        // Lee approved, so only the viewer is still asked for a review.
        expect(pr.reviewRequests).toEqual([{ kind: 'user', login: 'viewer' }]);
        expect(pr.viewerIsRequested).toBe(false);
        expect(pr.assignees.map(user => user.login)).toEqual(['dana']);
        expect(pr.labels).toEqual([
            { name: 'backend', color: '8b949e' },
            { name: 'api', color: '8b949e' }
        ]);
        expect(pr.reviewEvents).toEqual(['COMMENT', 'APPROVE']);
        expect(pr.reactionKinds).toEqual([]);
    });

    it('gives the revoke button when the viewer approved', () => {
        const approved = mapMergeRequest({ repo, mr, approvals: { ...approvals, user_has_approved: true }, discussions, commits, viewerId: VIEWER });
        expect(approved.reviewEvents).toEqual(['COMMENT', 'UNAPPROVE']);
    });

    it('splits the discussions into threads and conversation comments', () => {
        expect(pr.threads).toHaveLength(2);
        const [current, outdated] = pr.threads;
        expect(current).toMatchObject({
            path: 'src/limits.ts',
            line: 12,
            originalLine: 12,
            startLine: 10,
            side: 'RIGHT',
            isResolved: false,
            isOutdated: false
        });
        expect(current.comments.map(comment => [comment.author?.login, comment.databaseId])).toEqual([
            ['lee', 1126],
            ['dana', 1126]
        ]);
        expect(current.comments[1].url).toBe('https://gitlab.com/acme/platform/api/-/merge_requests/42#note_1131');
        expect(decodeGitLabId(current.id)?.discussionId).toBe('6a9c1750b37d513a43987b574953fceb50b03ce7');
        // The thread is on an older commit, so it has no line in the current diff.
        expect(outdated).toMatchObject({ path: 'src/constants.ts', line: null, originalLine: 7, side: 'LEFT', isResolved: true, isOutdated: true });
        // The system note ("added 1 commit") stays out.
        expect(pr.issueComments.map(comment => comment.body)).toEqual(['Can we ship this before the release?']);
    });

    it('orders the commits from the oldest', () => {
        expect(pr.commits.map(commit => [commit.abbreviatedOid, commit.messageHeadline, commit.author])).toEqual([
            ['4e5f6071', 'Add a token bucket per API key', 'Dana Ruiz'],
            ['9f2c1e7a', 'Read the limit from the config', 'Dana Ruiz']
        ]);
    });
});

describe('merge state and review decision', () => {
    it('maps the detailed merge status', () => {
        expect(mergeStateOf({ detailed_merge_status: 'mergeable' })).toEqual({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
        expect(mergeStateOf({ detailed_merge_status: 'conflict' })).toEqual({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
        expect(mergeStateOf({ detailed_merge_status: 'need_rebase' })).toEqual({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' });
        expect(mergeStateOf({ detailed_merge_status: 'not_approved' })).toEqual({ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' });
        expect(mergeStateOf({ detailed_merge_status: 'checking' })).toEqual({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
        // A server older than GitLab 15.6 has only the merge status.
        expect(mergeStateOf({ merge_status: 'can_be_merged' })).toEqual({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
        expect(mergeStateOf({ merge_status: 'cannot_be_merged' }).mergeable).toBe('CONFLICTING');
    });

    it('gives the review decision from the approvals', () => {
        expect(reviewDecisionOf({ approved_by: [{ user: { id: 1, username: 'a' } }], approvals_left: 0 }, 1)).toBe('APPROVED');
        expect(reviewDecisionOf({ approved_by: [{ user: { id: 1, username: 'a' } }], approvals_left: 1 }, 1)).toBe('REVIEW_REQUIRED');
        expect(reviewDecisionOf({ approved_by: [], approvals_left: 0 }, 1)).toBe('REVIEW_REQUIRED');
        expect(reviewDecisionOf(undefined, 0)).toBeNull();
    });

    it('gives the merge methods of the squash option of the project', () => {
        expect(mergeMethodsOf({ squash_option: 'always' })).toEqual({ allowed: ['squash'], preferred: 'squash' });
        expect(mergeMethodsOf({ squash_option: 'never' })).toEqual({ allowed: ['merge'], preferred: 'merge' });
        expect(mergeMethodsOf({ squash_option: 'default_on' })).toEqual({ allowed: ['merge', 'squash'], preferred: 'squash' });
        expect(mergeMethodsOf(undefined)).toEqual({ allowed: ['merge', 'squash'], preferred: 'merge' });
    });
});

describe('mapDiffs', () => {
    it('maps the status, the paths, the patch, and the line counts', () => {
        expect(mapDiffs(diffs).map(file => [file.path, file.previousPath, file.status, file.additions, file.deletions, !!file.patch])).toEqual([
            ['src/limits.ts', undefined, 'modified', 4, 1, true],
            ['src/bucket.ts', undefined, 'added', 3, 0, true],
            ['src/rate.ts', 'src/old-limits.ts', 'renamed', 0, 0, false],
            ['src/constants.ts', undefined, 'removed', 0, 2, true]
        ]);
    });
});

describe('jobs and pipelines', () => {
    it('maps the jobs to checks with the stage in the name', () => {
        const checks = jobs.map(jobToCheck);
        expect(checks.map(check => [check.id, check.name, check.status, check.conclusion, check.runId, check.isActions])).toEqual([
            [7731004, 'test › unit', 'completed', 'failure', 99012, true],
            [7731005, 'test › lint', 'completed', 'neutral', 99012, true],
            [7731003, 'build › compile', 'completed', 'success', 99012, true],
            [7731006, 'test › e2e', 'in_progress', null, 99012, true],
            [7731007, 'deploy › deploy-review', 'completed', 'skipped', 99012, true]
        ]);
        expect(checks[0]).toMatchObject({
            startedAt: '2026-11-14T16:36:02.000Z',
            completedAt: '2026-11-14T16:38:40.000Z',
            url: 'https://gitlab.com/acme/platform/api/-/jobs/7731004'
        });
        expect(checks[3].completedAt).toBeNull();
    });

    it('keeps the newest try of a retried job', () => {
        const retried = { ...jobs[0], id: 7731100, status: 'success' };
        expect(latestJobs([...jobs, retried]).find(job => job.name === 'unit')?.id).toBe(7731100);
    });

    it('gives the progress of a job without steps', () => {
        expect(jobProgressOf(jobs[3])).toEqual({
            status: 'in_progress',
            conclusion: null,
            startedAt: '2026-11-14T16:36:05.000Z',
            completedAt: null,
            steps: []
        });
    });

    it('maps a pipeline to a run of the Pipelines view', () => {
        expect(pipelineToRun(pipelines[0])).toMatchObject({
            id: 99012,
            title: 'Pipeline #812 on refs/merge-requests/42/head',
            runNumber: 812,
            branch: null,
            event: 'merge_request_event',
            status: 'in_progress',
            conclusion: null,
            headSha: '9f2c1e7a4b5d6c8e0f1a2b3c4d5e6f708192a3b4'
        });
        expect(pipelineToRun(pipelines[2])).toMatchObject({ title: 'Nightly build', branch: 'main', status: 'completed', conclusion: 'success' });
    });

    it('gives the combined state of a pipeline', () => {
        expect(pipelines.map(pipelineState)).toEqual(['PENDING', 'FAILURE', 'SUCCESS']);
        expect(pipelineState(undefined)).toBeNull();
    });
});

describe('lists', () => {
    const bySha = pipelinesBySha(pipelines);

    it('maps the merge requests of the review queue', () => {
        const open = list.filter(item => item.state === 'opened').map(item => openMergeRequestOf(repo, item, bySha, VIEWER));
        expect(open.map(item => [item.number, item.isDraft, item.reviewRequested, item.viewerDidAuthor, item.checks.state, item.comments])).toEqual([
            [42, true, false, false, 'PENDING', 5],
            [40, false, false, true, 'FAILURE', 1]
        ]);
        expect(open[0].reviewers).toEqual(['lee', 'viewer']);
        expect(open[1].actions).toEqual(['ci-failing', 'conflicts']);
    });

    it('maps the rows of the pull request list', () => {
        expect(list.map(item => mergeRequestSummaryOf(item, bySha, VIEWER)).map(row => [row.number, row.state, row.checks])).toEqual([
            [42, 'OPEN', 'PENDING'],
            [40, 'OPEN', 'FAILURE'],
            [37, 'MERGED', null]
        ]);
    });

    it('gives the branch summaries and the merged branches', () => {
        const summaries = branchSummaries(list, bySha, VIEWER);
        expect(Object.keys(summaries)).toEqual(['feature/rate-limits', 'fix/health']);
        expect(summaries['feature/rate-limits']).toMatchObject({ number: 42, isDraft: true, checks: 'PENDING', viewerRole: 'involved' });
        expect(summaries['fix/health'].viewerRole).toBe('author');
        expect(mergedBranches(list)).toEqual({
            'chore/node': { number: 37, title: 'Bump the Node version', headSha: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00' }
        });
    });

    it('finds the project of a merge request of a global list', () => {
        expect(repoOfMergeRequest('gitlab.com', list[0])).toEqual(repo);
        expect(repoOfMergeRequest('gitlab.com', { ...list[0], references: undefined })).toBeUndefined();
    });

    it('shows a merge request of the viewer on the Dashboard only when it needs an action', () => {
        expect(myMergeRequestItemOf(repo, list[1])?.reasons).toEqual(['conflicts']);
        expect(myMergeRequestItemOf(repo, list[0])).toBeUndefined();
        expect(myMergeRequestItemOf(repo, { ...list[0], draft: false, detailed_merge_status: 'mergeable' })?.reasons).toEqual(['ready-to-merge']);
    });
});
