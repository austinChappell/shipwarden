import { describe, expect, it } from 'vitest';
import { decodeAzureId } from '@shared/azure-devops';
import {
    branchSummaries,
    buildsForCommit,
    buildToCheck,
    buildToRun,
    gitStatusToCheckRun,
    mapChanges,
    mapPullRequest,
    mergeMethodOf,
    mergeStrategyOf,
    rollupState,
    timelineToProgress,
    type AzBuild,
    type AzChangeEntry,
    type AzCommit,
    type AzGitStatus,
    type AzIteration,
    type AzPullRequest,
    type AzThread,
    type AzTimelineRecord
} from './azure-mapping';
import prJson from './fixtures/pull-request.json';
import threadsJson from './fixtures/threads.json';
import commitsJson from './fixtures/commits.json';
import iterationsJson from './fixtures/iterations.json';
import changesJson from './fixtures/iteration-changes.json';
import buildsJson from './fixtures/builds.json';
import timelineJson from './fixtures/timeline.json';
import statusesJson from './fixtures/statuses.json';

const repo = { organization: 'contoso', project: 'Web', repository: 'shop' };
const pr = prJson as unknown as AzPullRequest;
const threads = threadsJson.value as unknown as AzThread[];
const commits = commitsJson.value as AzCommit[];
const iterations = iterationsJson.value as AzIteration[];
const changes = changesJson.changeEntries as AzChangeEntry[];
const builds = buildsJson.value as unknown as AzBuild[];
const records = timelineJson.records as unknown as AzTimelineRecord[];
const statuses = statusesJson.value as unknown as AzGitStatus[];

describe('mapPullRequest', () => {
    const mapped = mapPullRequest({
        repo,
        pr,
        threads,
        commits,
        iteration: iterations[iterations.length - 1],
        changedFiles: 4,
        viewerId: 'd6245f20-2af8-44f4-9451-8107cb2767db'
    });

    it('maps the main fields', () => {
        expect(mapped).toMatchObject({
            number: 22,
            title: 'Add the cart page',
            body: 'This adds the cart page.\n\nIt closes #31.',
            url: 'https://dev.azure.com/contoso/Web/_git/shop/pullrequest/22',
            state: 'OPEN',
            isDraft: false,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            author: { login: 'norman@contoso.com' },
            baseRefName: 'main',
            headRefName: 'feat/cart',
            headRefOid: 'b60280bc6e62e2f880f1b63c1e24987664d3bda3',
            // The base of the diff is the common commit of the newest iteration, not the newest target commit.
            baseRefOid: 'e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e',
            changedFiles: 4,
            viewerDidAuthor: true,
            defaultMergeMethod: 'squash',
            host: 'azure',
            hasAssignees: false
        });
        expect(decodeAzureId(mapped.id)).toEqual({ repo, pullRequestId: 22, threadId: undefined });
    });

    it('maps the votes to reviews, review requests and a decision', () => {
        expect(mapped.reviewDecision).toBe('CHANGES_REQUESTED');
        expect(mapped.reviews.map(review => [review.author?.login, review.state])).toEqual([
            ['ana@contoso.com', 'APPROVED'],
            ['chen@contoso.com', 'WAITING_FOR_AUTHOR']
        ]);
        expect(mapped.reviewRequests).toEqual([
            { kind: 'team', login: 'vstfs:///Classification/TeamProject/a7573007\\Web Team', name: '[Web]\\Web Team' }
        ]);
        expect(mapped.reviewEvents).toContain('APPROVE_WITH_SUGGESTIONS');
        expect(mapped.reviewEvents).toContain('REJECT');
    });

    it('keeps only the active labels and shows auto-complete', () => {
        expect(mapped.labels.map(label => label.name)).toEqual(['frontend']);
        expect(mapped.autoMerge).toEqual({ method: 'squash', enabledBy: 'norman@contoso.com' });
        expect(mapped.viewerCanEnableAutoMerge).toBe(false);
        expect(mapped.viewerCanDisableAutoMerge).toBe(true);
    });

    it('maps the threads on files', () => {
        expect(mapped.threads).toHaveLength(2);
        const [first, second] = mapped.threads;
        expect(first).toMatchObject({ path: 'src/cart/Cart.tsx', line: 42, side: 'RIGHT', isResolved: false, isOutdated: false });
        expect(first.comments.map(comment => comment.body)).toEqual(['Use the shared price formatter here.', 'Done.']);
        // A reply goes to the thread, so each comment carries the thread ID.
        expect(first.comments.every(comment => comment.databaseId === 101)).toBe(true);
        expect(decodeAzureId(first.id)?.threadId).toBe(101);
        expect(second).toMatchObject({ path: 'src/cart/old.ts', line: 7, side: 'LEFT', isResolved: true });
    });

    it('makes the threads without a file the conversation, without system comments', () => {
        expect(mapped.issueComments.map(comment => comment.body)).toEqual(['Please add a test for the empty cart.']);
        expect(mapped.issueComments[0].url).toBe('https://dev.azure.com/contoso/Web/_git/shop/pullrequest/22?discussionId=103');
    });

    it('lists the commits from the oldest to the newest', () => {
        expect(mapped.commitCount).toBe(2);
        expect(mapped.commits.map(commit => commit.messageHeadline)).toEqual(['Add the cart page', 'Use the price formatter']);
        expect(mapped.commits[1]).toMatchObject({
            abbreviatedOid: 'b60280b',
            author: 'Norman Paulk',
            committedDate: '2026-11-02T11:26:00Z',
            url: 'https://dev.azure.com/contoso/Web/_git/shop/commit/b60280bc6e62e2f880f1b63c1e24987664d3bda3'
        });
    });

    it('maps the other states', () => {
        expect(mapPullRequest({ repo, pr: { ...pr, status: 'completed' }, threads: [], commits: [] }).state).toBe('MERGED');
        expect(mapPullRequest({ repo, pr: { ...pr, status: 'abandoned' }, threads: [], commits: [] }).state).toBe('CLOSED');
        const conflict = mapPullRequest({ repo, pr: { ...pr, mergeStatus: 'conflicts', autoCompleteSetBy: undefined }, threads: [], commits: [] });
        expect(conflict).toMatchObject({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', autoMerge: null, viewerCanEnableAutoMerge: true, viewerDidAuthor: false });
        expect(mapPullRequest({ repo, pr: { ...pr, mergeStatus: 'rejectedByPolicy' }, threads: [], commits: [] }).mergeStateStatus).toBe('BLOCKED');
    });
});

describe('merge methods', () => {
    it('converts in both directions', () => {
        expect(mergeMethodOf('noFastForward')).toBe('merge');
        expect(mergeMethodOf('squash')).toBe('squash');
        expect(mergeMethodOf('rebaseMerge')).toBe('rebase');
        expect(mergeMethodOf(undefined)).toBe('merge');
        expect(mergeStrategyOf('merge')).toBe('noFastForward');
        expect(mergeStrategyOf('squash')).toBe('squash');
        expect(mergeStrategyOf('rebase')).toBe('rebase');
    });
});

describe('mapChanges', () => {
    it('maps the change types and leaves out folders', () => {
        expect(mapChanges(changes)).toEqual([
            { path: 'src/cart/Cart.tsx', status: 'modified', additions: 0, deletions: 0 },
            { path: 'src/cart/price.ts', status: 'added', additions: 0, deletions: 0 },
            { path: 'src/cart/old.ts', status: 'removed', additions: 0, deletions: 0 },
            { path: 'src/cart/CartItem.tsx', previousPath: 'src/cart/Item.tsx', status: 'renamed', additions: 0, deletions: 0 }
        ]);
    });
});

describe('builds', () => {
    it('finds the newest build of each pipeline for the pull request head', () => {
        const found = buildsForCommit(builds, 'b60280bc6e62e2f880f1b63c1e24987664d3bda3');
        expect(found.map(build => build.id).sort()).toEqual([904, 905]);
        expect(buildsForCommit(builds, 'f47bbc106853afe3c1b07a81754bce5f4b8dbf62').map(build => build.id)).toEqual([899]);
    });

    it('maps a build to a check', () => {
        expect(buildToCheck(repo, builds[0])).toEqual({
            id: 905,
            name: 'shop-ci',
            status: 'in_progress',
            conclusion: null,
            startedAt: '2026-11-02T11:28:00Z',
            completedAt: null,
            url: 'https://dev.azure.com/contoso/Web/_build/results?buildId=905',
            runId: 905,
            isActions: true
        });
        expect(buildToCheck(repo, builds[1])).toMatchObject({ status: 'completed', conclusion: 'success', url: 'https://dev.azure.com/contoso/Web/_build/results?buildId=904' });
        expect(buildToCheck(repo, builds[2]).conclusion).toBe('failure');
        expect(buildToCheck(repo, builds[3]).conclusion).toBe('neutral');
    });

    it('maps a build to a pipeline run', () => {
        expect(buildToRun(repo, builds[0])).toMatchObject({
            id: 905,
            title: 'Add the cart page',
            workflowId: 7,
            workflowName: 'shop-ci',
            branch: 'feat/cart',
            event: 'pullRequest',
            status: 'in_progress',
            conclusion: null,
            actor: 'Norman Paulk',
            headSha: 'b60280bc6e62e2f880f1b63c1e24987664d3bda3'
        });
        expect(buildToRun(repo, builds[3])).toMatchObject({ title: 'Merge the login fix', branch: 'main', status: 'completed', headSha: 'f47bbc106853afe3c1b07a81754bce5f4b8dbf62' });
    });

    it('maps the timeline to steps, in the order of the jobs and the tasks', () => {
        const progress = timelineToProgress(builds[0], records);
        expect(progress.status).toBe('in_progress');
        expect(progress.conclusion).toBeNull();
        expect(progress.steps.map(step => [step.number, step.name, step.status, step.conclusion])).toEqual([
            [1, 'Compile › Checkout shop@feat/cart', 'completed', 'success'],
            [2, 'Compile › npm ci', 'completed', 'success'],
            [3, 'Test › npm test', 'queued', null]
        ]);
    });

    it('maps the statuses of other services', () => {
        expect(statuses.map(gitStatusToCheckRun)).toEqual([
            {
                id: 1, name: 'sonarqube/quality-gate', status: 'completed', conclusion: 'success',
                startedAt: '2026-11-02T11:30:00Z', completedAt: '2026-11-02T11:31:00Z',
                url: 'https://sonar.contoso.com/dashboard?id=shop', isActions: false, isStatus: true
            },
            {
                id: 2, name: 'deploy-preview', status: 'pending', conclusion: null,
                startedAt: '2026-11-02T11:32:00Z', completedAt: null, url: null, isActions: false, isStatus: true
            }
        ]);
    });

    it('combines the CI state', () => {
        expect(rollupState([])).toBeNull();
        expect(rollupState([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }])).toBe('PENDING');
        expect(rollupState([{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null }])).toBe('FAILURE');
        expect(rollupState([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'neutral' }])).toBe('SUCCESS');
    });
});

describe('branchSummaries', () => {
    it('gives the active pull requests by branch with the state of the newest builds of the head', () => {
        const summaries = branchSummaries(repo, [pr, { ...pr, pullRequestId: 23, status: 'completed', sourceRefName: 'refs/heads/old' }], builds);
        expect(Object.keys(summaries)).toEqual(['feat/cart']);
        expect(summaries['feat/cart']).toEqual({
            number: 22,
            title: 'Add the cart page',
            url: 'https://dev.azure.com/contoso/Web/_git/shop/pullrequest/22',
            headSha: 'b60280bc6e62e2f880f1b63c1e24987664d3bda3',
            isDraft: false,
            reviewDecision: 'CHANGES_REQUESTED',
            // Build 900 failed, but it tested an older commit. Build 905 runs, and build 904 passed.
            checks: 'PENDING'
        });
    });
});
