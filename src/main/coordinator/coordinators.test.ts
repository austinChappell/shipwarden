import { describe, expect, it, vi } from 'vitest';
import { WORKER_WAIT_NOTICE_MS } from '@shared/coordinator';
import type { Plan } from '@shared/plans';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { DEFAULT_QUEUE_SETTINGS, type QueueState } from '@shared/task-queue';
import type { TerminalSession } from '@shared/terminal';
import { Coordinators, findAgent, findRepo, type CoordinatorSources } from './coordinators';

const START = 1_000_000_000;

/** Fake sources with a plan list in memory. Each test changes the parts that it needs. */
function setup(options: { settings?: Partial<AppSettings>; queue?: QueueState; usage?: CoordinatorSources['usage'] } = {}) {
    let plans: Plan[] = [];
    let sessions: TerminalSession[] = [];
    let now = START;
    let counter = 0;
    const sent: { sessionId: string; message: string }[] = [];
    const sources: CoordinatorSources = {
        plans: {
            list: async () => plans,
            change: async (id, change) => {
                const next = change(plans.find(plan => plan.id === id));
                if (!next) return undefined;
                plans = [next, ...plans.filter(plan => plan.id !== id)];
                return next;
            }
        },
        settings: async () => ({ ...DEFAULT_SETTINGS, ...options.settings }),
        projects: async () => [{ id: 'p1', name: 'App', repos: ['/repo', '/api'] }],
        usage: options.usage ?? (async () => []),
        queue: async () => options.queue ?? { items: [], settings: DEFAULT_QUEUE_SETTINGS },
        sessions: async () => sessions,
        repoOf: async worktree => (worktree.startsWith('/api') ? '/api' : '/repo'),
        start: vi.fn(async start => {
            counter += 1;
            const worktreePath = `/repo-${counter}`;
            sessions = [
                ...sessions,
                {
                    id: `s${counter}`,
                    title: 'Claude Code',
                    cwd: worktreePath,
                    worktreePath,
                    isAgent: true,
                    exited: false,
                    agentState: 'working',
                    agentStateAt: now
                }
            ];
            return { worktreePath, sessionId: `s${counter}`, branch: start.branch };
        }),
        send: vi.fn(async (target, message) => {
            sent.push({ sessionId: target.sessionId, message });
        }),
        pullRequest: vi.fn(async () => undefined),
        onPlanChanged: vi.fn(),
        now: () => now
    };
    const coordinators = new Coordinators(sources);
    const signal = new AbortController().signal;
    /** Starts a worker for a caller and returns its ID. */
    const startWorker = async (worktree: string, task = 'Add the login page.', sessionId = 'coord') => {
        const prepared = await coordinators.prepare({ worktree, sessionId }, { task });
        return (await coordinators.launch(prepared, signal)).worker_id as string;
    };
    return {
        coordinators,
        sources,
        sent,
        signal,
        startWorker,
        plans: () => plans,
        setSessions: (change: (list: TerminalSession[]) => TerminalSession[]) => {
            sessions = change(sessions);
        },
        advance: (ms: number) => {
            now += ms;
        },
        coordinatorSession: () => {
            sessions = [
                ...sessions,
                { id: 'coord', title: 'Claude Code', cwd: '/repo', worktreePath: '/repo', isAgent: true, exited: false, agentState: 'working' }
            ];
        }
    };
}

describe('Coordinators', () => {
    it('starts a worker, makes the coordinator run, and lists the worker', async () => {
        const test = setup();
        const id = await test.startWorker('/repo');
        const [plan] = test.plans();
        expect(plan.coordinator).toEqual({ worktree: '/repo', depth: 0, sessionId: 'coord' });
        expect(plan.projectId).toBe('p1');
        expect(plan.steps[0]).toMatchObject({ id, title: 'Add the login page.', status: 'running', depth: 1, worktreePath: '/repo-1', sessionId: 's1' });
        expect(test.sources.start).toHaveBeenCalledWith(
            expect.objectContaining({ repoPath: '/repo', agentId: 'claude', branch: expect.stringMatching(/^worker\/add-the-login-page/) }),
            test.signal
        );
        expect(vi.mocked(test.sources.start).mock.calls[0][0].prompt).toContain('Add the login page.');
        expect(test.sources.onPlanChanged).toHaveBeenCalled();
        const list = await test.coordinators.list('/repo');
        expect(list.workers).toEqual([expect.objectContaining({ worker_id: id, status: 'working', agentState: 'working' })]);
        expect(await test.coordinators.list('/other')).toEqual({ workers: [] });
    });

    it('lets a worker start workers up to the depth limit', async () => {
        const test = setup({ settings: { workerMaxDepth: 2 } });
        await test.startWorker('/repo');
        await test.startWorker('/repo-1');
        const nested = test.plans().find(plan => plan.coordinator?.worktree === '/repo-1');
        expect(nested?.coordinator?.depth).toBe(1);
        expect(nested?.steps[0].depth).toBe(2);
        await expect(test.coordinators.prepare({ worktree: '/repo-2' }, { task: 'More' })).rejects.toThrow('A worker at depth 2 cannot start workers.');

        const flat = setup({ settings: { workerMaxDepth: 1 } });
        await flat.startWorker('/repo');
        await expect(flat.coordinators.prepare({ worktree: '/repo-1' }, { task: 'More' })).rejects.toThrow('the limit is 1');
    });

    it('refuses a start at the queue limit and over the usage budget', async () => {
        const test = setup({ queue: { items: [], settings: { ...DEFAULT_QUEUE_SETTINGS, maxRunning: 1 } } });
        await test.startWorker('/repo');
        await expect(test.coordinators.prepare({ worktree: '/repo' }, { task: 'Second' })).rejects.toThrow('the limit is 1');

        const usage = vi.fn(async () => [
            { provider: 'claude' as const, status: 'ok' as const, windows: [{ kind: 'session' as const, label: '5 hours', usedPercent: 95 }] }
        ]);
        const budget = setup({ settings: { usageBudget: { percent: 80, windows: 'all' } }, usage: usage as unknown as CoordinatorSources['usage'] });
        await expect(budget.coordinators.prepare({ worktree: '/repo' }, { task: 'Do it' })).rejects.toThrow('Waiting for usage to reset');
        const free = setup();
        await free.coordinators.prepare({ worktree: '/repo' }, { task: 'Do it' });
        expect(usage).toHaveBeenCalledTimes(1);
    });

    it('checks the repository, the agent, and the model', async () => {
        const test = setup();
        await expect(test.coordinators.prepare({ worktree: '/repo' }, { task: 'x', repository: 'nope' })).rejects.toThrow('"nope"');
        await expect(test.coordinators.prepare({ worktree: '/repo' }, { task: 'x', agent: 'nope' })).rejects.toThrow('No agent');
        const prepared = await test.coordinators.prepare({ worktree: '/repo' }, { task: 'x', repository: 'api', agent: 'Codex', model: 'gpt-5' });
        expect(prepared).toMatchObject({ repoPath: '/api', agent: { id: 'codex' }, model: 'gpt-5' });
        expect(prepared.summary).toContain('Start Codex in a new worktree of api');
    });

    it('sends the report to the coordinator one time', async () => {
        const test = setup();
        test.coordinatorSession();
        const id = await test.startWorker('/repo');
        const result = await test.coordinators.report('/repo-1', {
            summary: 'Added the page.',
            failed: false,
            pullRequestUrl: 'https://github.com/o/r/pull/9'
        });
        expect(result).toMatchObject({ reported: true, pullRequest: 'https://github.com/o/r/pull/9' });
        expect(test.sent).toHaveLength(1);
        expect(test.sent[0].sessionId).toBe('coord');
        expect(test.sent[0].message).toContain(`worker_id "${id}"`);
        expect(test.sent[0].message).toContain('Added the page.');
        const [plan] = test.plans();
        expect(plan.status).toBe('done');
        expect(plan.steps[0]).toMatchObject({ status: 'done', report: 'Added the page.', pr: { number: 9 } });
        await test.coordinators.tick();
        expect(test.sent).toHaveLength(1);
        await expect(test.coordinators.report('/elsewhere', { summary: 'x', failed: false })).rejects.toThrow('not a worker');
    });

    it('gives the report to a waiting wait_for_worker call and sends no message', async () => {
        const test = setup();
        test.coordinatorSession();
        const id = await test.startWorker('/repo');
        const waiting = test.coordinators.wait('/repo', undefined, 60_000, test.signal);
        await test.coordinators.report('/repo-1', { summary: 'Done.', failed: false });
        const result = await waiting;
        expect(result.worker).toMatchObject({ worker_id: id, status: 'done', report: 'Done.' });
        expect(result.openWorkers).toBe(0);
        expect(test.sent).toHaveLength(0);
        await test.coordinators.tick();
        expect(test.sent).toHaveLength(0);
        // A wait for a finished worker returns at once.
        expect((await test.coordinators.wait('/repo', id, 60_000, test.signal)).worker).toMatchObject({ status: 'done' });
    });

    it('ends a wait after the time', async () => {
        vi.useFakeTimers();
        try {
            const test = setup();
            await test.startWorker('/repo');
            const waiting = test.coordinators.wait('/repo', undefined, 10_000, test.signal);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await waiting).toMatchObject({ timedOut: true, workers: [expect.objectContaining({ status: 'working' })] });
            await expect(test.coordinators.wait('/repo', 'nope', 10, test.signal)).rejects.toThrow('no worker');
            await expect(test.coordinators.wait('/other', undefined, 10, test.signal)).rejects.toThrow('no workers');
        } finally {
            vi.useRealTimers();
        }
    });

    it('tells the coordinator when a worker stops, and uses the pull request of the branch', async () => {
        const test = setup();
        test.coordinatorSession();
        await test.startWorker('/repo');
        vi.mocked(test.sources.pullRequest).mockResolvedValue({ number: 4, url: 'https://github.com/o/r/pull/4', base: 'main' });
        test.setSessions(list => list.map(item => (item.id === 's1' ? { ...item, exited: true } : item)));
        await test.coordinators.tick();
        expect(test.plans()[0].steps[0]).toMatchObject({ status: 'done', pr: { number: 4 } });
        expect(test.sent[0].message).toContain('https://github.com/o/r/pull/4');
        await test.coordinators.tick();
        expect(test.sent).toHaveLength(1);
    });

    it('tells the coordinator when a worker waits for 10 minutes', async () => {
        const test = setup();
        test.coordinatorSession();
        await test.startWorker('/repo');
        test.setSessions(list => list.map(item => (item.id === 's1' ? { ...item, agentState: 'waiting', agentStateAt: START, agentMessage: 'Allow?' } : item)));
        test.advance(WORKER_WAIT_NOTICE_MS - 1000);
        await test.coordinators.tick();
        expect(test.sent).toHaveLength(0);
        test.advance(1000);
        await test.coordinators.tick();
        expect(test.sent).toHaveLength(1);
        expect(test.sent[0].message).toContain('needs attention');
        expect(test.plans()[0].steps[0].status).toBe('attention');
        await test.coordinators.tick();
        expect(test.sent).toHaveLength(1);
        // The coordinator knows about the wait, so a wait for this worker continues until the worker has news.
        vi.useFakeTimers();
        try {
            const waiting = test.coordinators.wait('/repo', test.plans()[0].steps[0].id, 10_000, test.signal);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await waiting).toMatchObject({ timedOut: true });
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a notice while the coordinator tab is closed or the window does not answer', async () => {
        const test = setup();
        await test.startWorker('/repo');
        await test.coordinators.report('/repo-1', { summary: 'Done.', failed: false });
        expect(test.sent).toHaveLength(0);
        test.coordinatorSession();
        vi.mocked(test.sources.send).mockRejectedValueOnce(new Error('The ShipWarden window is closed.'));
        await test.coordinators.tick();
        expect(test.plans()[0].steps[0].noticeKey).toBeUndefined();
        await test.coordinators.tick();
        expect(test.sent).toHaveLength(1);
        expect(test.plans()[0].steps[0].noticeKey).toMatch(/^end:/);
    });
});

describe('findRepo and findAgent', () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, repos: { '/code/web': { name: 'Website' } } };
    const projects = [{ id: 'p', name: 'P', repos: ['/code/web', '/code/api'] }];

    it('finds a repository by path, name, or folder', () => {
        expect(findRepo(settings, projects, '/code/api/')).toBe('/code/api');
        expect(findRepo(settings, projects, 'website')).toBe('/code/web');
        expect(findRepo(settings, projects, 'API')).toBe('/code/api');
        expect(findRepo(settings, projects, 'none')).toBeUndefined();
    });

    it('finds an agent by ID or name', () => {
        expect(findAgent(settings, 'codex')?.id).toBe('codex');
        expect(findAgent(settings, 'claude code')?.id).toBe('claude');
        expect(findAgent(settings, 'x')).toBeUndefined();
    });
});
