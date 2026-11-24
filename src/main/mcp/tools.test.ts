import { describe, expect, it, vi } from 'vitest';
import type { BranchStatus, CheckRun, PullRequest } from '@shared/github';
import type { McpWatch } from '@shared/mcp';
import type { Task, TaskStatus } from '@shared/tasks';
import {
    askTimeoutMs,
    elementTarget,
    findWorktree,
    McpTools,
    pullRequestChanges,
    type LinkedTask,
    type McpBrowser,
    type McpPullRequests,
    type McpToolService,
    type McpWorktree
} from './tools';

const todo: TaskStatus = { id: 's1', name: 'To do', category: 'todo' };
const review: TaskStatus = { id: 's2', name: 'In review', category: 'in_progress' };
const task: Task = { id: 't1', key: 'ENG-1', title: 'Fix the login', status: todo, description: 'The login fails.', assignees: [{ name: 'Ann' }] };

const worktrees: McpWorktree[] = [
    { path: '/repo', branch: 'main', name: 'main', repo: '/repo', isMain: true, agents: [] },
    { path: '/repo-a', branch: 'feature/a', name: 'Login fix', repo: '/repo', isMain: false, agents: [{ title: 'Claude Code', state: 'working' }] },
    { path: '/repo-b', branch: 'feature/b', name: 'feature/b', repo: '/repo', isMain: false, agents: [] }
];

const pr = {
    id: 'PR_1',
    number: 7,
    title: 'Fix the login',
    body: 'The old body.',
    url: 'https://github.com/o/r/pull/7',
    state: 'OPEN',
    isDraft: true,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'CHANGES_REQUESTED',
    baseRefName: 'main',
    headRefName: 'feature/a',
    headRefOid: 'abc1234567',
    reviews: [
        { id: 'r1', author: { login: 'bo' }, state: 'CHANGES_REQUESTED', body: 'Please fix.', submittedAt: '2026-11-02', url: 'u' },
        { id: 'r2', author: { login: 'bo' }, state: 'COMMENTED', body: '', submittedAt: '2026-11-02', url: 'u' }
    ],
    issueComments: [{ id: 'i1', author: { login: 'cy' }, body: 'Nice.', createdAt: '2026-11-03', url: 'u' }],
    threads: [
        {
            id: 'T1',
            path: 'src/a.ts',
            line: 4,
            originalLine: 4,
            side: 'RIGHT',
            isResolved: false,
            isOutdated: false,
            comments: [
                { id: 'C1', databaseId: 101, author: { login: 'bo' }, body: 'Use a const.', createdAt: '2026-11-02', url: 'https://github.com/o/r/pull/7#c101' }
            ]
        },
        {
            id: 'T2',
            path: 'src/b.ts',
            line: null,
            originalLine: 9,
            side: 'RIGHT',
            isResolved: true,
            isOutdated: true,
            comments: [{ id: 'C2', databaseId: 102, author: { login: 'bo' }, body: 'Old.', createdAt: '2026-11-01', url: 'u' }]
        }
    ]
} as unknown as PullRequest;

const status = (pullRequest: PullRequest | null = pr, extra: Partial<BranchStatus> = {}): BranchStatus => ({
    repo: { owner: 'o', name: 'r' },
    branch: 'feature/a',
    sha: 'abc1234567',
    pullRequest,
    ...extra
});

const check = (id: number, conclusion: CheckRun['conclusion'], isActions = true): CheckRun => ({
    id,
    name: `job ${id}`,
    status: conclusion ? 'completed' : 'in_progress',
    conclusion,
    startedAt: null,
    completedAt: null,
    url: `https://ci/${id}`,
    isActions
});

function fakePullRequests(overrides: Partial<McpPullRequests> = {}): McpPullRequests {
    return {
        status: vi.fn(async () => status()),
        create: vi.fn(async () => 8),
        change: vi.fn(async () => undefined),
        reply: vi.fn(async () => undefined),
        checks: vi.fn(async () => [check(1, 'success'), check(2, 'failure'), check(3, null), check(4, 'failure', false)]),
        saveJobLog: vi.fn(async (_worktree: string, jobId: number) => `/tmp/job-${jobId}.log`),
        changed: vi.fn(),
        ...overrides
    };
}

function fakeBrowser(): McpBrowser {
    const page = { url: 'http://localhost:3000/', title: 'App' };
    return {
        open: vi.fn(async () => page),
        read: vi.fn(async () => ({ ...page, text: 'Hello', truncated: false, elements: [] })),
        screenshot: vi.fn(async () => ({ png: Buffer.from('png'), page })),
        click: vi.fn(async () => ({ element: '<button> "Save"', page })),
        type: vi.fn(async () => ({ element: '<input> "Name"', page }))
    };
}

/** A fake service layer. Each test changes the parts that it needs. */
function fakeService(overrides: Partial<McpToolService> = {}) {
    const linked: LinkedTask = {
        connectionId: 'clickup',
        link: { connectionId: 'clickup', pluginId: 'clickup', taskId: 't1', key: 'ENG-1', title: 'Fix the login' },
        capabilities: { update: true, statuses: true, comments: true }
    };
    const requests: [string, string, unknown][] = [];
    const service: McpToolService & { requests: typeof requests } = {
        requests,
        worktrees: vi.fn(async (_caller: string, all: boolean) => (all ? worktrees : worktrees.slice(0, 2))),
        overlap: vi.fn(async () => ({ path: '/repo-a', files: ['src/a.ts'], peers: [{ path: '/repo-b', branch: 'feature/b', files: ['src/a.ts'] }] })),
        ask: vi.fn(async () => ({ agent: 'Claude Code', answer: 'Use the new API.' })),
        linkedTask: vi.fn(async () => linked),
        taskRequest: (async (connectionId: string, method: string, params: unknown) => {
            requests.push([connectionId, method, params]);
            if (method === 'tasks/get') return task;
            if (method === 'comments/list') return [{ id: 'c1', author: { name: 'Bo' }, body: 'Please add a test.', createdAt: '2026-11-01' }];
            if (method === 'tasks/statuses') return [todo, review];
            if (method === 'tasks/update') return { ...task, status: review };
            throw new Error(`Unexpected ${method}`);
        }) as McpToolService['taskRequest'],
        taskChanged: vi.fn(),
        approve: vi.fn(async () => undefined),
        pullRequests: fakePullRequests(),
        browser: fakeBrowser(),
        watches: {
            add: vi.fn(async (watch: Omit<McpWatch, 'id' | 'createdAt'>) => ({ ...watch, id: 'w1', createdAt: 1 })),
            remove: vi.fn(async () => [])
        },
        ...overrides
    };
    return service;
}

/** `sessionId` null gives a context without a session. */
const context = (worktree = '/repo-a', sessionId: string | null = 's1') => ({
    worktree,
    ...(sessionId ? { sessionId } : {}),
    signal: new AbortController().signal
});
const textOf = (result: { content: ({ text: string } | { data: string })[] } | undefined) => {
    const item = result?.content[0];
    return item && 'text' in item ? item.text : '';
};

describe('McpTools', () => {
    it('lists the tools with schemas and the read-only hints', () => {
        const tools = new McpTools(fakeService()).definitions();
        expect(tools.map(tool => tool.name)).toEqual([
            'list_worktrees',
            'get_overlaps',
            'ask_agent',
            'get_task',
            'set_task_status',
            'get_pull_request',
            'get_checks',
            'create_pull_request',
            'update_pull_request',
            'reply_to_comment',
            'watch_pull_request',
            'open_page',
            'read_page',
            'screenshot',
            'click',
            'type'
        ]);
        expect(tools.find(tool => tool.name === 'set_task_status')?.annotations.readOnlyHint).toBe(false);
        expect(tools.every(tool => tool.inputSchema.type === 'object')).toBe(true);
    });

    it('returns undefined for an unknown tool', async () => {
        expect(await new McpTools(fakeService()).call('delete_everything', {}, context())).toBeUndefined();
    });

    it('list_worktrees lists the repository of the caller, or all projects with "all"', async () => {
        const service = fakeService();
        const tools = new McpTools(service);
        const result = await tools.call('list_worktrees', {}, context());
        expect(result?.structuredContent).toEqual({ current: '/repo-a', worktrees: worktrees.slice(0, 2) });
        await tools.call('list_worktrees', { all: true }, context());
        expect(service.worktrees).toHaveBeenLastCalledWith('/repo-a', true);
        expect(service.approve).not.toHaveBeenCalled();
    });

    it('get_overlaps returns the shared files and the peers', async () => {
        const result = await new McpTools(fakeService()).call('get_overlaps', {}, context());
        expect(result?.structuredContent).toEqual({
            worktree: '/repo-a',
            files: ['src/a.ts'],
            peers: [{ path: '/repo-b', branch: 'feature/b', files: ['src/a.ts'] }]
        });
    });

    it('get_overlaps returns empty lists for a worktree without an overlap', async () => {
        const result = await new McpTools(fakeService({ overlap: async () => undefined })).call('get_overlaps', {}, context());
        expect(result?.structuredContent).toEqual({ worktree: '/repo-a', files: [], peers: [] });
    });

    it('ask_agent finds the worktree by branch, asks for approval, and returns the answer', async () => {
        const service = fakeService();
        const result = await new McpTools(service).call(
            'ask_agent',
            { worktree: 'feature/b', question: 'Which API do you use?', timeout_seconds: 60 },
            context()
        );
        expect(service.approve).toHaveBeenCalledWith('/repo-a', 'ask_agent', expect.stringContaining('Which API do you use?'), expect.anything());
        const [target, prompt, options] = vi.mocked(service.ask).mock.calls[0];
        expect(target).toBe('/repo-b');
        expect(prompt).toContain('"Login fix" (/repo-a)');
        expect(prompt).toContain('Question: Which API do you use?');
        expect(options.timeoutMs).toBe(60_000);
        expect(textOf(result)).toBe('Use the new API.');
        expect(result?.isError).toBeUndefined();
    });

    it('ask_agent refuses this worktree and an unknown worktree, without approval', async () => {
        const service = fakeService();
        const tools = new McpTools(service);
        const self = await tools.call('ask_agent', { worktree: '/repo-a', question: 'Hi?' }, context());
        expect(self?.isError).toBe(true);
        expect(textOf(self)).toContain('different worktree');
        const unknown = await tools.call('ask_agent', { worktree: 'nope', question: 'Hi?' }, context());
        expect(textOf(unknown)).toContain('list_worktrees');
        const empty = await tools.call('ask_agent', { worktree: 'feature/b', question: ' ' }, context());
        expect(textOf(empty)).toContain('"question"');
        expect(service.approve).not.toHaveBeenCalled();
        expect(service.ask).not.toHaveBeenCalled();
    });

    it('ask_agent gives a tool error and does not ask when the approval fails', async () => {
        const service = fakeService({ approve: async () => Promise.reject(new Error('The user did not approve ask_agent in 2 minutes.')) });
        const result = await new McpTools(service).call('ask_agent', { worktree: 'feature/b', question: 'Hi?' }, context());
        expect(result).toEqual({ content: [{ type: 'text', text: 'The user did not approve ask_agent in 2 minutes.' }], isError: true });
        expect(service.ask).not.toHaveBeenCalled();
    });

    it('get_task returns the task and the comments', async () => {
        const service = fakeService();
        const result = await new McpTools(service).call('get_task', {}, context());
        expect(result?.structuredContent).toEqual({
            task: { id: 't1', key: 'ENG-1', title: 'Fix the login', status: 'To do', assignees: ['Ann'], description: 'The login fails.' },
            comments: [{ author: 'Bo', createdAt: '2026-11-01', body: 'Please add a test.' }]
        });
        expect(service.approve).not.toHaveBeenCalled();
    });

    it('get_task skips the comments when the plugin has none, and fails without a task', async () => {
        const service = fakeService();
        vi.mocked(service.linkedTask).mockResolvedValueOnce({
            connectionId: 'local',
            link: { pluginId: 'local', taskId: 't1', title: 'Fix the login' },
            capabilities: {}
        });
        await new McpTools(service).call('get_task', {}, context());
        expect(service.requests.map(([, method]) => method)).toEqual(['tasks/get']);
        const none = await new McpTools(fakeService({ linkedTask: async () => undefined })).call('get_task', {}, context());
        expect(none?.isError).toBe(true);
        expect(textOf(none)).toContain('no task');
    });

    it('set_task_status matches the status name without case, asks for approval, updates the task, and patches the page', async () => {
        const service = fakeService();
        const result = await new McpTools(service).call('set_task_status', { status: 'in REVIEW' }, context());
        expect(service.approve).toHaveBeenCalledWith('/repo-a', 'set_task_status', 'Move "Fix the login" to "In review"', expect.anything());
        expect(service.requests).toContainEqual(['clickup', 'tasks/update', { id: 't1', status: 's2' }]);
        expect(service.taskChanged).toHaveBeenCalledWith('clickup', 't1', { status: review });
        expect(result?.structuredContent).toEqual({ task: 'ENG-1', status: 'In review' });
    });

    it('set_task_status lists the statuses for an unknown status and changes nothing', async () => {
        const service = fakeService();
        const result = await new McpTools(service).call('set_task_status', { status: 'Shipped' }, context());
        expect(textOf(result)).toBe('The task has no status "Shipped". The statuses are: "To do", "In review".');
        expect(service.approve).not.toHaveBeenCalled();
        expect(service.requests.some(([, method]) => method === 'tasks/update')).toBe(false);
    });

    it('set_task_status fails when the plugin cannot change the status', async () => {
        const service = fakeService();
        vi.mocked(service.linkedTask).mockResolvedValueOnce({
            connectionId: 'x',
            link: { pluginId: 'x', taskId: 't1', title: 'T' },
            capabilities: { update: true }
        });
        const result = await new McpTools(service).call('set_task_status', { status: 'In review' }, context());
        expect(textOf(result)).toContain('cannot change the status');
    });

    it('set_task_status does not update the task when the user denies it', async () => {
        const service = fakeService({ approve: async () => Promise.reject(new Error('The user denied set_task_status for this worktree.')) });
        const result = await new McpTools(service).call('set_task_status', { status: 'In review' }, context());
        expect(textOf(result)).toContain('denied');
        expect(service.requests.some(([, method]) => method === 'tasks/update')).toBe(false);
        expect(service.taskChanged).not.toHaveBeenCalled();
    });
});

describe('findWorktree', () => {
    it('finds by path, then by branch, then by name', () => {
        expect(findWorktree(worktrees, '/repo-b/')?.path).toBe('/repo-b');
        expect(findWorktree(worktrees, 'feature/a')?.path).toBe('/repo-a');
        expect(findWorktree(worktrees, 'Login fix')?.path).toBe('/repo-a');
        expect(findWorktree(worktrees, 'other')).toBeUndefined();
    });
});

describe('askTimeoutMs', () => {
    it('uses the default, and keeps the value in 10 to 900 seconds', () => {
        expect(askTimeoutMs(undefined)).toBe(300_000);
        expect(askTimeoutMs(1)).toBe(10_000);
        expect(askTimeoutMs(5000)).toBe(900_000);
        expect(askTimeoutMs('60')).toBe(300_000);
    });
});

describe('pull request tools', () => {
    it('get_pull_request returns the pull request without the resolved threads, and the IDs for a reply', async () => {
        const service = fakeService();
        const result = await new McpTools(service).call('get_pull_request', {}, context());
        const summary = (result!.structuredContent as { pullRequest: Record<string, unknown> }).pullRequest;
        expect(summary).toMatchObject({ number: 7, state: 'OPEN', isDraft: true, base: 'main', reviewDecision: 'CHANGES_REQUESTED', resolvedThreads: 1 });
        expect(summary.reviews).toEqual([{ author: 'bo', state: 'CHANGES_REQUESTED', body: 'Please fix.', submittedAt: '2026-11-02' }]);
        expect(summary.threads).toEqual([{ path: 'src/a.ts', line: 4, comments: [{ id: 101, author: 'bo', body: 'Use a const.', createdAt: '2026-11-02' }] }]);
        const all = await new McpTools(service).call('get_pull_request', { include_resolved: true }, context());
        expect((all!.structuredContent as { pullRequest: { threads: unknown[] } }).pullRequest.threads).toHaveLength(2);
        expect(service.approve).not.toHaveBeenCalled();
    });

    it('get_pull_request returns null without a pull request, and an error without a code host', async () => {
        const none = fakeService({ pullRequests: fakePullRequests({ status: async () => status(null, { pushed: false }) }) });
        expect((await new McpTools(none).call('get_pull_request', {}, context()))?.structuredContent).toEqual({
            branch: 'feature/a',
            pullRequest: null,
            pushed: false
        });
        const noHost = fakeService({ pullRequests: fakePullRequests({ status: async () => null }) });
        expect(textOf(await new McpTools(noHost).call('get_pull_request', {}, context()))).toContain('Settings › Code review');
    });

    it('get_checks counts the checks and saves the logs of the failed Actions jobs only on request', async () => {
        const service = fakeService();
        const plain = await new McpTools(service).call('get_checks', {}, context());
        expect((plain!.structuredContent as { summary: unknown }).summary).toEqual({ total: 4, failed: 2, pending: 1, passed: 1 });
        expect(service.pullRequests.saveJobLog).not.toHaveBeenCalled();
        const withLogs = await new McpTools(service).call('get_checks', { include_logs: true }, context());
        const checks = (withLogs!.structuredContent as { checks: { id: number; log?: string }[] }).checks;
        expect(checks.filter(item => item.log)).toEqual([expect.objectContaining({ id: 2, log: '/tmp/job-2.log' })]);
        expect(service.pullRequests.checks).toHaveBeenCalledWith('/repo-a', 'abc1234567');
    });

    it('create_pull_request asks for approval, creates the pull request, and gives the page the new state', async () => {
        const created = { ...pr, number: 8, url: 'https://github.com/o/r/pull/8', isDraft: false } as PullRequest;
        const pullRequests = fakePullRequests();
        vi.mocked(pullRequests.status).mockResolvedValueOnce(status(null)).mockResolvedValueOnce(status(created));
        const service = fakeService({ pullRequests });
        const result = await new McpTools(service).call('create_pull_request', { title: 'Add login', body: 'Body', base: 'dev' }, context());
        expect(service.approve).toHaveBeenCalledWith(
            '/repo-a',
            'create_pull_request',
            'Create a pull request "Add login" from feature/a into dev',
            expect.anything()
        );
        expect(pullRequests.create).toHaveBeenCalledWith('/repo-a', { title: 'Add login', body: 'Body', draft: false, base: 'dev' });
        expect(pullRequests.changed).toHaveBeenCalledWith({ kind: 'created', worktree: '/repo-a', status: status(created) });
        expect(result?.structuredContent).toEqual({ number: 8, url: 'https://github.com/o/r/pull/8', isDraft: false, base: 'main' });
    });

    it('create_pull_request refuses a branch with an open pull request or without a push, without approval', async () => {
        const service = fakeService();
        expect(textOf(await new McpTools(service).call('create_pull_request', { title: 'X' }, context()))).toContain('#7 already');
        const unpushed = fakeService({ pullRequests: fakePullRequests({ status: async () => status(null, { pushed: false }) }) });
        expect(textOf(await new McpTools(unpushed).call('create_pull_request', { title: 'X' }, context()))).toContain('git push -u origin feature/a');
        expect(service.approve).not.toHaveBeenCalled();
        expect(unpushed.approve).not.toHaveBeenCalled();
    });

    it('update_pull_request applies only the changed values, in order, and patches the page for each change', async () => {
        const service = fakeService();
        const result = await new McpTools(service).call(
            'update_pull_request',
            { title: 'Fix the login', body: 'New body.', draft: false, base: 'dev' },
            context()
        );
        expect(service.approve).toHaveBeenCalledWith(
            '/repo-a',
            'update_pull_request',
            'Change #7: description, mark as ready for review, base dev',
            expect.anything()
        );
        expect(vi.mocked(service.pullRequests.change).mock.calls.map(call => call[2])).toEqual([
            { kind: 'details', body: 'New body.' },
            { kind: 'draft', pullRequestId: 'PR_1', draft: false },
            { kind: 'base', base: 'dev' }
        ]);
        const changed = vi.mocked(service.pullRequests.changed).mock.calls.map(([change]) => change);
        expect(changed).toHaveLength(3);
        // Each patch starts from the pull request after the change before it.
        expect(changed[2]).toMatchObject({ kind: 'changed', pr: { body: 'New body.', isDraft: false } });
        expect(result?.structuredContent).toMatchObject({ number: 7, changed: ['description', 'mark as ready for review', 'base dev'] });
    });

    it('update_pull_request with no change asks nothing, and a wrong state fails', async () => {
        const service = fakeService();
        const same = await new McpTools(service).call('update_pull_request', { title: 'Fix the login', draft: true }, context());
        expect(same?.structuredContent).toEqual({ number: 7, changed: [] });
        expect(service.approve).not.toHaveBeenCalled();
        expect(() => pullRequestChanges(pr, { state: 'merged' })).toThrow('"open" or "closed"');
        expect(pullRequestChanges(pr, { state: 'closed' })).toEqual([{ kind: 'details', state: 'closed' }]);
    });

    it('reply_to_comment replies in the thread of the comment and patches the page', async () => {
        const service = fakeService();
        const result = await new McpTools(service).call('reply_to_comment', { comment_id: 101, body: 'Done.' }, context());
        expect(service.approve).toHaveBeenCalledWith('/repo-a', 'reply_to_comment', 'Reply to bo on src/a.ts: Done.', expect.anything());
        expect(service.pullRequests.reply).toHaveBeenCalledWith('/repo-a', 7, 101, 'Done.');
        expect(service.pullRequests.changed).toHaveBeenCalledWith({ kind: 'reply', pr, threadId: 'T1', commentId: 101, body: 'Done.' });
        expect(result?.structuredContent).toEqual({ number: 7, path: 'src/a.ts', replied: true });
    });

    it('reply_to_comment refuses an unknown comment ID without approval', async () => {
        const service = fakeService();
        const result = await new McpTools(service).call('reply_to_comment', { comment_id: 999, body: 'Done.' }, context());
        expect(textOf(result)).toContain('get_pull_request');
        expect(service.approve).not.toHaveBeenCalled();
        expect(service.pullRequests.reply).not.toHaveBeenCalled();
    });
});

describe('watch_pull_request', () => {
    it('adds a watch of the session with all events by default, and without approval', async () => {
        const service = fakeService();
        const result = await new McpTools(service).call('watch_pull_request', {}, context());
        expect(service.watches.add).toHaveBeenCalledWith({
            worktree: '/repo-a',
            sessionId: 's1',
            number: 7,
            events: ['ci.failed', 'pr.conflict', 'pr.comment']
        });
        expect(result?.structuredContent).toMatchObject({ watching: true, number: 7 });
        expect(service.approve).not.toHaveBeenCalled();
    });

    it('keeps only the known events', async () => {
        const service = fakeService();
        await new McpTools(service).call('watch_pull_request', { events: ['pr.comment', 'nope'] }, context());
        expect(service.watches.add).toHaveBeenCalledWith(expect.objectContaining({ events: ['pr.comment'] }));
    });

    it('stops the watch of the session and the worktree', async () => {
        const service = fakeService();
        await new McpTools(service).call('watch_pull_request', { stop: true }, context());
        const match = vi.mocked(service.watches.remove).mock.calls[0][0];
        const watch = { id: 'w', worktree: '/repo-a', sessionId: 's1', events: [], number: 7, createdAt: 1 } satisfies McpWatch;
        expect(match(watch)).toBe(true);
        expect(match({ ...watch, sessionId: 's2' })).toBe(false);
        expect(service.watches.add).not.toHaveBeenCalled();
    });

    it('needs the session of the agent and an open pull request', async () => {
        expect(textOf(await new McpTools(fakeService()).call('watch_pull_request', {}, context('/repo-a', null)))).toContain('Start the agent from ShipWarden');
        const merged = fakeService({ pullRequests: fakePullRequests({ status: async () => status({ ...pr, state: 'MERGED' } as PullRequest) }) });
        expect(textOf(await new McpTools(merged).call('watch_pull_request', {}, context()))).toContain('#7 is merged');
    });
});

describe('browser tools', () => {
    it('open_page, click, and type ask for approval first', async () => {
        const service = fakeService();
        const tools = new McpTools(service);
        await tools.call('open_page', { url: 'http://localhost:3000' }, context());
        await tools.call('click', { element: 'Save' }, context());
        await tools.call('type', { ref: 3, text: 'Ann', submit: true }, context());
        expect(vi.mocked(service.approve).mock.calls.map(call => [call[1], call[2]])).toEqual([
            ['open_page', 'Open http://localhost:3000'],
            ['click', 'Click the element "Save"'],
            ['type', 'Type "Ann" into the element with ref 3']
        ]);
        expect(service.browser.type).toHaveBeenCalledWith('/repo-a', { ref: 3 }, 'Ann', { clear: true, submit: true }, expect.anything());
    });

    it('read_page and screenshot need no approval, and the screenshot is an image', async () => {
        const service = fakeService();
        const tools = new McpTools(service);
        expect((await tools.call('read_page', { selector: 'main' }, context()))?.structuredContent).toMatchObject({ text: 'Hello' });
        expect(service.browser.read).toHaveBeenCalledWith('/repo-a', 'main');
        const shot = await tools.call('screenshot', {}, context());
        expect(shot?.content[0]).toEqual({ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' });
        expect(shot?.content[1]).toEqual({ type: 'text', text: 'App (http://localhost:3000/)' });
        expect(service.approve).not.toHaveBeenCalled();
    });

    it('a click needs exactly one target', async () => {
        expect(() => elementTarget({})).toThrow('exactly one');
        expect(() => elementTarget({ ref: 1, element: 'Save' })).toThrow('exactly one');
        expect(() => elementTarget({ ref: 'x' })).toThrow('"ref"');
        expect(elementTarget({ selector: ' #save ' })).toEqual({ selector: '#save' });
        const service = fakeService();
        const result = await new McpTools(service).call('click', {}, context());
        expect(result?.isError).toBe(true);
        expect(service.approve).not.toHaveBeenCalled();
    });
});
