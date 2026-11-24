import { describe, expect, it } from 'vitest';
import {
    applyObservation,
    applyReport,
    coordinatorPlanOf,
    depthError,
    depthOf,
    newCoordinatorPlan,
    newWorkerStep,
    observeWorker,
    openWorkerCount,
    pullRequestNumberOf,
    WORKER_START_GRACE_MS,
    WORKER_WAIT_NOTICE_MS,
    workerBranch,
    workerNotice,
    workerPrompt,
    workerSummary,
    workerTitle
} from './coordinator';
import { normalizePlan, type Plan } from './plans';
import type { TerminalSession } from './terminal';

const NOW = 1_000_000_000;

const step = (id: string, worktreePath: string, depth = 1) =>
    newWorkerStep({ id, title: `Worker ${id}`, task: 'Do it.', repo: '/repo', branch: `worker/${id}`, worktreePath, sessionId: `s-${id}`, depth, now: NOW });

function run(worktree: string, steps = [step('a', '/w/a')], depth = 0): Plan {
    return { ...newCoordinatorPlan({ projectId: 'p1', worktree, name: 'main', sessionId: 'coord', depth, now: NOW }), steps };
}

const session = (extra: Partial<TerminalSession> = {}): TerminalSession => ({
    id: 's-a',
    title: 'Claude Code',
    cwd: '/w/a',
    isAgent: true,
    exited: false,
    agentState: 'working',
    agentStateAt: NOW,
    ...extra
});

describe('coordinator runs', () => {
    it('finds the run of a coordinator and the depth of a worker', () => {
        const top = run('/repo');
        const nested = run('/w/a', [step('b', '/w/b', 2)], 1);
        const plans = [top, nested];
        expect(coordinatorPlanOf(plans, '/repo')?.id).toBe(top.id);
        expect(depthOf(plans, '/repo')).toBe(0);
        expect(depthOf(plans, '/w/a')).toBe(1);
        expect(depthOf(plans, '/w/b')).toBe(2);
        expect(openWorkerCount(plans)).toBe(2);
        expect(openWorkerCount([{ ...top, steps: [{ ...top.steps[0], status: 'done' }] }])).toBe(0);
    });

    it('refuses a worker past the depth limit', () => {
        expect(depthError(0, 1)).toBeUndefined();
        expect(depthError(1, 2)).toBeUndefined();
        expect(depthError(1, 1)).toContain('Only the agent that the user started can start workers.');
        expect(depthError(2, 2)).toContain('A worker at depth 2 cannot start workers.');
    });

    it('keeps the coordinator fields through the plan file', () => {
        const plan = run('/repo', [{ ...step('a', '/w/a', 2), report: 'Done.', noticeKey: 'end:1', waitAt: 5 }]);
        const saved = normalizePlan(JSON.parse(JSON.stringify(plan)));
        expect(saved?.coordinator).toEqual({ worktree: '/repo', depth: 0, sessionId: 'coord' });
        expect(saved?.steps[0]).toMatchObject({ depth: 2, report: 'Done.', noticeKey: 'end:1', waitAt: 5 });
        expect(normalizePlan({ ...plan, coordinator: { worktree: 'relative' } })?.coordinator).toBeUndefined();
    });

    it('makes a title, a branch, and a prompt', () => {
        expect(workerTitle('\n## Add the login page\nMore text.')).toBe('Add the login page');
        expect(workerBranch('Add the login/page!', 'lx2-k3x9ab')).toBe('worker/add-the-login-page-x9ab');
        expect(workerBranch('', 'abcd')).toBe('worker/task-abcd');
        const prompt = workerPrompt({ task: 'Fix it.', coordinator: 'main', depth: 2, maxDepth: 2 });
        expect(prompt).toContain('Fix it.');
        expect(prompt).toContain('report_result');
        expect(prompt).toContain('You cannot start workers.');
        expect(workerPrompt({ task: 'x', coordinator: 'main', depth: 1, maxDepth: 2 })).toContain('start_worker');
    });

    it('finds a stopped worker after the start time', () => {
        const worker = step('a', '/w/a');
        expect(observeWorker(worker, undefined, NOW + 1000)).toBeUndefined();
        expect(observeWorker(worker, undefined, NOW + WORKER_START_GRACE_MS)).toEqual({ kind: 'stopped' });
        expect(observeWorker(worker, session({ exited: true }), NOW)).toEqual({ kind: 'stopped' });
        expect(observeWorker({ ...worker, status: 'done' }, undefined, NOW + WORKER_START_GRACE_MS)).toBeUndefined();
    });

    it('finds a worker that waits for 10 minutes, one time for each wait', () => {
        const worker = step('a', '/w/a');
        const waiting = session({ agentState: 'waiting', agentStateAt: NOW, agentMessage: 'Allow the edit?' });
        expect(observeWorker(worker, waiting, NOW + WORKER_WAIT_NOTICE_MS - 1)).toBeUndefined();
        const observation = observeWorker(worker, waiting, NOW + WORKER_WAIT_NOTICE_MS);
        expect(observation).toEqual({ kind: 'waiting', since: NOW, state: 'waiting', message: 'Allow the edit?' });
        const after = applyObservation(worker, observation!, NOW + WORKER_WAIT_NOTICE_MS);
        expect(after).toMatchObject({ status: 'attention', waitAt: NOW });
        expect(after.detail).toContain('Allow the edit?');
        expect(observeWorker(after, waiting, NOW + 2 * WORKER_WAIT_NOTICE_MS)).toBeUndefined();
        expect(observeWorker(after, session({ agentState: 'working' }), NOW + 2 * WORKER_WAIT_NOTICE_MS)).toEqual({ kind: 'working' });
    });

    it('marks a stopped worker as done when its branch has a pull request', () => {
        const pr = { number: 9, url: 'https://github.com/o/r/pull/9', base: 'main' };
        expect(applyObservation(step('a', '/w/a'), { kind: 'stopped' }, NOW, pr)).toMatchObject({ status: 'done', pr, finishedAt: NOW });
        expect(applyObservation(step('a', '/w/a'), { kind: 'stopped' }, NOW)).toMatchObject({ status: 'failed', finishedAt: NOW });
    });

    it('gives each notice one time', () => {
        const worker = step('a', '/w/a');
        expect(workerNotice(worker)).toBeUndefined();
        const done = applyReport(worker, { summary: 'Added the page.', failed: false }, NOW + 5, { number: 9, url: 'https://x/pull/9', base: 'main' });
        const notice = workerNotice(done);
        expect(notice?.key).toBe(`end:${NOW + 5}`);
        expect(notice?.message).toContain('finished');
        expect(notice?.message).toContain('Added the page.');
        expect(notice?.message).toContain('https://x/pull/9');
        expect(workerNotice({ ...done, noticeKey: notice?.key })).toBeUndefined();
        expect(workerNotice(applyReport(worker, { summary: 'No access.', failed: true }, NOW))?.message).toContain('did not finish');
    });

    it('summarizes a worker for the agent', () => {
        const summary = workerSummary({ ...step('a', '/w/a'), report: 'Done.' }, session({ agentState: 'done' }));
        expect(summary).toMatchObject({ worker_id: 'a', status: 'working', agentState: 'done', report: 'Done.', depth: 1, worktree: '/w/a' });
    });

    it('reads the number of a pull request address', () => {
        expect(pullRequestNumberOf('https://github.com/o/r/pull/12')).toBe(12);
        expect(pullRequestNumberOf('https://gitlab.com/o/r/-/merge_requests/3')).toBe(3);
        expect(pullRequestNumberOf('https://bitbucket.org/o/r/pull-requests/4/overview')).toBe(4);
        expect(pullRequestNumberOf('https://dev.azure.com/o/p/_git/r/pullrequest/5')).toBe(5);
        expect(pullRequestNumberOf('https://example.com/nothing')).toBeUndefined();
    });
});
