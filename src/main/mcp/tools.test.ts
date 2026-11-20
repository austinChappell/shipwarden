import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskStatus } from '@shared/tasks';
import { askTimeoutMs, findWorktree, McpTools, type LinkedTask, type McpToolService, type McpWorktree } from './tools';

const todo: TaskStatus = { id: 's1', name: 'To do', category: 'todo' };
const review: TaskStatus = { id: 's2', name: 'In review', category: 'in_progress' };
const task: Task = { id: 't1', key: 'ENG-1', title: 'Fix the login', status: todo, description: 'The login fails.', assignees: [{ name: 'Ann' }] };

const worktrees: McpWorktree[] = [
    { path: '/repo', branch: 'main', name: 'main', repo: '/repo', isMain: true, agents: [] },
    { path: '/repo-a', branch: 'feature/a', name: 'Login fix', repo: '/repo', isMain: false, agents: [{ title: 'Claude Code', state: 'working' }] },
    { path: '/repo-b', branch: 'feature/b', name: 'feature/b', repo: '/repo', isMain: false, agents: [] }
];

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
        ...overrides
    };
    return service;
}

const context = (worktree = '/repo-a') => ({ worktree, signal: new AbortController().signal });
const textOf = (result: { content: { text: string }[] } | undefined) => result?.content[0].text ?? '';

describe('McpTools', () => {
    it('lists the five tools with schemas and the read-only hints', () => {
        const tools = new McpTools(fakeService()).definitions();
        expect(tools.map(tool => tool.name)).toEqual(['list_worktrees', 'get_overlaps', 'ask_agent', 'get_task', 'set_task_status']);
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
