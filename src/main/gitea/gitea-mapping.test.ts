import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
    branchSummaries,
    isActionsStatus,
    jobProgressOf,
    jobToCheck,
    latestVerdicts,
    mapCommits,
    mapDiffFiles,
    mapPullRequest,
    mergedBranches,
    mergeStateOf,
    myPullRequestItemOf,
    NumericIds,
    openPullRequestOf,
    pullRequestSummaryOf,
    repoOfIssue,
    reviewDecisionOf,
    reviewRequestItemOf,
    runStatesBySha,
    runToWorkflowRun,
    statusToCheck,
    tasksToRuns,
    workflowFileOf,
    type GtCombinedStatus,
    type GtCommit,
    type GtIssue,
    type GtIssueComment,
    type GtJob,
    type GtPullRequest,
    type GtRepo,
    type GtReview,
    type GtReviewComment,
    type GtRun,
    type GtTask
} from './gitea-mapping';
import commitsJson from './fixtures/commits.json';
import issueCommentsJson from './fixtures/issue-comments.json';
import issuesJson from './fixtures/issues-search.json';
import jobsJson from './fixtures/jobs.json';
import pullRequestJson from './fixtures/pull-request.json';
import pullRequestsJson from './fixtures/pull-requests.json';
import repoJson from './fixtures/repo.json';
import comments101 from './fixtures/review-comments-101.json';
import comments102 from './fixtures/review-comments-102.json';
import reviewsJson from './fixtures/reviews.json';
import runsJson from './fixtures/runs.json';
import statusJson from './fixtures/status.json';
import tasksJson from './fixtures/tasks.json';

const REPO = { host: 'git.example.com', owner: 'acme', repo: 'api' };
const PR = pullRequestJson as GtPullRequest;
const PRS = pullRequestsJson as GtPullRequest[];
const REVIEWS = reviewsJson as GtReview[];
const VIEWER = { id: 30, login: 'viewer' };
const RUNS = runsJson.workflow_runs as GtRun[];
const diff = readFileSync(new URL('./fixtures/pull-request.diff', import.meta.url), 'utf8');

function mapFixture() {
    return mapPullRequest({
        repo: REPO,
        pr: PR,
        repoInfo: repoJson as GtRepo,
        reviews: REVIEWS,
        reviewComments: [...comments101, ...comments102] as GtReviewComment[],
        issueComments: issueCommentsJson as GtIssueComment[],
        commits: commitsJson as GtCommit[],
        viewer: VIEWER
    });
}

describe('mapPullRequest', () => {
    it('maps the fields of a pull request', () => {
        const { pullRequest: pr } = mapFixture();
        expect(pr).toMatchObject({
            id: 'gitea:git.example.com/acme/api/7',
            number: 7,
            title: 'Add rate limits',
            url: 'https://git.example.com/acme/api/pulls/7',
            state: 'OPEN',
            isDraft: false,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            baseRefName: 'main',
            headRefName: 'rate-limits',
            headRefOid: '2222222222222222222222222222222222222222',
            isCrossRepository: false,
            additions: 12,
            deletions: 2,
            changedFiles: 2,
            viewerDidAuthor: false,
            viewerIsRequested: true,
            allowedMergeMethods: ['merge', 'squash', 'rebase'],
            defaultMergeMethod: 'squash',
            host: 'gitea',
            reviewEvents: ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'],
            reactionKinds: [],
            autoMerge: null,
            viewerCanEnableAutoMerge: false,
            viewerCanMerge: true
        });
        expect(pr.author).toEqual({ login: 'dana', name: 'Dana Lee', avatarUrl: 'https://git.example.com/avatars/21' });
        expect(pr.labels).toEqual([
            { name: 'api', color: 'e11d21', description: 'API work' },
            { name: 'perf', color: '0075ca', description: null }
        ]);
    });

    it('takes the newest verdict of each reviewer', () => {
        const { pullRequest: pr } = mapFixture();
        // Sam asked for changes first and then approved.
        expect(pr.reviewDecision).toBe('APPROVED');
        // Sam reviewed, so only the viewer is still requested.
        expect(pr.reviewRequests).toEqual([{ kind: 'user', login: 'viewer' }]);
        // The pending review, the review request, and the comment review without a body are not reviews.
        expect(pr.reviews.map(review => [review.author?.login, review.state])).toEqual([
            ['sam', 'CHANGES_REQUESTED'],
            ['sam', 'APPROVED']
        ]);
    });

    it('groups the line comments into threads by file, side, and line', () => {
        const { pullRequest: pr, places } = mapFixture();
        expect(pr.threads).toHaveLength(2);
        const [limits, readme] = pr.threads;
        expect(limits).toMatchObject({
            id: 'gitea:git.example.com/acme/api/7/201',
            path: 'src/limits.ts',
            line: 4,
            side: 'RIGHT',
            isResolved: false,
            isOutdated: false
        });
        expect(limits.comments.map(comment => [comment.databaseId, comment.author?.login, comment.body])).toEqual([
            [201, 'sam', 'Add a limit for each user.'],
            [201, 'dana', 'Done in the next commit.']
        ]);
        expect(limits.comments[0].reviewId).toBe('gitea:git.example.com/acme/api/7#review:101');
        expect(readme).toMatchObject({ path: 'README.md', line: 3, side: 'LEFT', isResolved: true });
        expect(places.get(201)).toEqual({ path: 'src/limits.ts', side: 'RIGHT', line: 4 });
    });

    it('keeps the comments of the conversation without empty ones, and the commits', () => {
        const { pullRequest: pr } = mapFixture();
        expect(pr.issueComments).toEqual([
            {
                id: 'gitea-issue-comment:301',
                author: { login: 'sam' },
                body: 'Thanks. I will look today.',
                createdAt: '2026-11-18T10:00:00Z',
                url: 'https://git.example.com/acme/api/pulls/7#issuecomment-301'
            }
        ]);
        expect(pr.commits.map(commit => [commit.abbreviatedOid, commit.messageHeadline, commit.author])).toEqual([
            ['aaaaaaaaaa', 'Add the token bucket', 'dana'],
            ['2222222222', 'Add tests', 'Dana Lee']
        ]);
        expect(pr.commitCount).toBe(2);
        // The order of the API does not change the order of the commits.
        expect(mapCommits(REPO, [...(commitsJson as GtCommit[])].reverse()).map(commit => commit.oid)).toEqual(pr.commits.map(commit => commit.oid));
    });
});

describe('merge state and review decision', () => {
    it('reads the merge state', () => {
        expect(mergeStateOf(PRS[1])).toEqual({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
        expect(mergeStateOf(PRS[2])).toEqual({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
        expect(mergeStateOf(PRS[0])).toEqual({ mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' });
        expect(mergeStateOf({ ...PRS[0], draft: false })).toEqual({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    });

    it('ignores dismissed reviews and comments', () => {
        expect(reviewDecisionOf([], 1)).toBe('REVIEW_REQUIRED');
        expect(reviewDecisionOf([], 0)).toBeNull();
        const dismissed = REVIEWS.map(review => (review.id === 103 ? { ...review, dismissed: true } : review));
        expect(reviewDecisionOf(dismissed, 0)).toBe('CHANGES_REQUESTED');
        expect([...latestVerdicts(REVIEWS)]).toEqual([['sam', 'APPROVED']]);
    });
});

describe('mapDiffFiles', () => {
    it('reads the files, the status, and the line counts from the diff', () => {
        const files = mapDiffFiles(diff);
        expect(files.map(file => [file.path, file.status, file.previousPath, file.additions, file.deletions, !!file.patch])).toEqual([
            ['README.md', 'modified', undefined, 0, 1, true],
            ['src/limits.ts', 'added', undefined, 2, 0, true],
            ['new/name.ts', 'renamed', 'old/name.ts', 0, 0, false],
            ['logo.png', 'removed', undefined, 0, 0, false]
        ]);
        expect(files[1].patch).toBe('@@ -0,0 +1,2 @@\n+export const LIMIT = 100;\n+export const WINDOW = 60;');
    });
});

describe('Actions', () => {
    it('maps the runs of the newer API', () => {
        const ids = new NumericIds();
        const runs = RUNS.map(run => runToWorkflowRun(run, ids));
        expect(runs[0]).toEqual({
            id: 52,
            title: 'Add tests',
            workflowId: 1,
            workflowName: 'ci.yml',
            runNumber: 14,
            branch: 'rate-limits',
            event: 'push',
            status: 'completed',
            conclusion: 'failure',
            actor: 'dana',
            createdAt: '2026-11-20T10:59:50Z',
            updatedAt: '2026-11-20T11:01:00Z',
            startedAt: '2026-11-20T11:00:00Z',
            url: 'https://git.example.com/acme/api/actions/runs/14',
            headSha: '2222222222222222222222222222222222222222'
        });
        expect(runs[1].workflowId).toBe(1);
        expect(runs[2]).toMatchObject({ workflowId: 2, workflowName: 'nightly.yaml', status: 'in_progress', conclusion: null });
        expect(workflowFileOf('.gitea/workflows/ci.yml@refs/heads/main')).toBe('ci.yml');
    });

    it('maps the jobs and the steps', () => {
        const [lint] = jobsJson.jobs as GtJob[];
        expect(jobToCheck(lint)).toEqual({
            id: 78,
            name: 'lint',
            status: 'completed',
            conclusion: 'failure',
            startedAt: '2026-11-20T11:00:00Z',
            completedAt: '2026-11-20T11:00:10Z',
            url: 'https://git.example.com/acme/api/actions/runs/14/jobs/1',
            runId: 52,
            isActions: true
        });
        expect(jobProgressOf(lint).steps.map(step => [step.number, step.name, step.conclusion])).toEqual([
            [0, 'Set up job', 'success'],
            [1, 'npm run lint', 'failure']
        ]);
    });

    it('groups the tasks of the older API into runs', () => {
        const runs = tasksToRuns(tasksJson.workflow_runs as GtTask[], new NumericIds());
        expect(runs.map(run => [run.id, run.workflowName, run.status, run.conclusion, run.url])).toEqual([
            [14, 'ci.yml', 'completed', 'failure', 'https://git.example.com/acme/api/actions/runs/14'],
            [12, 'nightly.yaml', 'in_progress', null, 'https://git.example.com/acme/api/actions/runs/12']
        ]);
    });

    it('combines the newest run of each workflow into one state for each commit', () => {
        const states = runStatesBySha(RUNS);
        // Run 52 (failed) replaces run 51 (success) of the same workflow.
        expect(states.get('2222222222222222222222222222222222222222')).toBe('FAILURE');
        expect(states.get('1111111111111111111111111111111111111111')).toBe('PENDING');
    });

    it('maps commit statuses and finds the statuses of Actions', () => {
        const statuses = (statusJson as GtCombinedStatus).statuses ?? [];
        expect(statuses.map(isActionsStatus)).toEqual([true, true, false]);
        expect(statusToCheck(statuses[2])).toMatchObject({
            id: 403,
            name: 'external/build',
            status: 'pending',
            conclusion: null,
            url: 'https://ci.example.com/build/88',
            isActions: false,
            isStatus: true
        });
    });
});

describe('lists', () => {
    const states = runStatesBySha(RUNS);

    it('maps the open pull requests for the review queue', () => {
        const [first, second] = PRS.slice(0, 2).map(pr => openPullRequestOf(REPO, pr, states, VIEWER));
        expect(first).toMatchObject({
            number: 7,
            // The list item has no "draft" field, so the "WIP:" title decides.
            isDraft: true,
            reviewRequested: false,
            checks: { state: 'FAILURE', failing: 1, pending: 0, total: 1 },
            reviewers: ['viewer'],
            reviewStatus: 'waiting',
            actions: []
        });
        expect(second).toMatchObject({ number: 8, viewerDidAuthor: true, actions: ['conflicts'], checks: { state: null }, assignees: ['sam'] });
    });

    it('maps the rows of the pull request list', () => {
        expect(pullRequestSummaryOf(PRS[2], states, VIEWER)).toMatchObject({ number: 5, state: 'MERGED', checks: null, viewerDidAuthor: true });
    });

    it('maps the branches, the merged branches, and the Dashboard items', () => {
        expect(branchSummaries(PRS, states, VIEWER)).toEqual({
            'rate-limits': {
                number: 7,
                title: 'WIP: Add rate limits',
                url: 'https://git.example.com/acme/api/pulls/7',
                headSha: '2222222222222222222222222222222222222222',
                isDraft: true,
                reviewDecision: null,
                checks: 'FAILURE',
                viewerRole: 'involved'
            },
            'login-fix': {
                number: 8,
                title: 'Fix the login page',
                url: 'https://git.example.com/acme/api/pulls/8',
                headSha: '3333333333333333333333333333333333333333',
                isDraft: false,
                reviewDecision: null,
                checks: null,
                viewerRole: 'author'
            }
        });
        expect(mergedBranches(PRS)).toEqual({ health: { number: 5, title: 'Add the health check', headSha: '4444444444444444444444444444444444444444' } });
        const issue = (issuesJson as GtIssue[])[0];
        const repo = repoOfIssue('git.example.com', issue)!;
        expect(reviewRequestItemOf(repo, issue)).toEqual({
            repo: { owner: 'git.example.com/acme', name: 'api', host: 'gitea' },
            number: 7,
            title: 'WIP: Add rate limits',
            url: 'https://git.example.com/acme/api/pulls/7',
            author: 'dana',
            updatedAt: '2026-11-20T12:00:00Z',
            createdAt: '2026-11-18T09:00:00Z'
        });
        expect(myPullRequestItemOf(REPO, PRS[1])?.reasons).toEqual(['conflicts']);
        expect(myPullRequestItemOf(REPO, PRS[0])).toBeUndefined();
    });
});
