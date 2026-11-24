import { describe, expect, it } from 'vitest';
import type { Automation } from '@shared/automations';
import { CLI_PROTOCOL, type CliCommand, type CliPageRequest, type CliRequest } from '@shared/cli';
import type { TerminalSession } from '@shared/terminal';
import type { ApprovalRequest } from '../mcp/approvals';
import type { McpWorktree } from '../mcp/tools';
import { CliActions, findRepo, worktreeAt, type CliService } from './cli-actions';

const worktrees: McpWorktree[] = [
    { path: '/r/app', branch: 'main', name: 'main', repo: '/r/app', isMain: true, agents: [] },
    { path: '/w/app/login', branch: 'feature/login', name: 'feature/login', repo: '/r/app', isMain: false, agents: [{ title: 'Claude Code', state: 'idle' }] },
    { path: '/w/app/busy', branch: 'busy', name: 'busy', repo: '/r/app', isMain: false, agents: [{ title: 'Codex', state: 'working' }] },
    { path: '/r/api', branch: 'main', name: 'main', repo: '/r/api', isMain: true, agents: [] }
];

const automation = (change: Partial<Automation>): Automation => ({
    version: 1,
    id: 'fix-ci',
    name: 'Fix CI',
    trigger: { type: 'ci.failed' },
    actions: [{ type: 'sendToAgent', prompt: 'Fix it' }],
    limits: { approval: 'auto', maxRunsPerTarget: 3, maxRunning: 2 },
    status: 'on',
    binding: {},
    ...change
});

function setup(options: { deny?: boolean; sessions?: TerminalSession[]; automations?: Automation[] } = {}) {
    const approvals: ApprovalRequest[] = [];
    const pages: CliPageRequest[] = [];
    const tools: { name: string; args: Record<string, unknown>; worktree: string }[] = [];
    let time = 1000;
    const service: CliService = {
        version: '1.2.3',
        pid: 42,
        home: '/Users/me',
        mcpServer: async () => true,
        worktrees: async () => worktrees,
        tools: {
            call: async (name, args, context) => {
                tools.push({ name, args, worktree: context.worktree });
                if (name === 'get_task') {
                    const data = { task: { key: 'ENG-1', title: 'Login', status: 'Open' }, comments: [] };
                    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
                }
                if (args.status === 'Nope') return { content: [{ type: 'text', text: 'The task has no status "Nope".' }], isError: true };
                const data = { task: 'ENG-1', status: String(args.status) };
                return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
            }
        },
        approve: async request => {
            approvals.push(request);
            if (options.deny) throw new Error(`The user denied ${request.tool} for this worktree.`);
        },
        sessions: async () => options.sessions ?? [],
        automations: async () => options.automations ?? [],
        page: async request => {
            pages.push(request);
            return { message: 'Done.', worktreePath: 'worktreePath' in request ? request.worktreePath : undefined, sessionId: 's1', agent: 'Claude Code' };
        },
        now: () => {
            time += 1000;
            return time;
        }
    };
    const actions = new CliActions(service);
    const run = (command: CliCommand, args: CliRequest['args'] = {}, cwd = '/w/app/login/src') =>
        actions.handle({ protocol: CLI_PROTOCOL, token: 't', command, args, cwd }, new AbortController().signal);
    return { run, approvals, pages, tools };
}

describe('worktreeAt and findRepo', () => {
    it('finds the worktree of a folder, and the nested one first', () => {
        expect(worktreeAt(worktrees, '/w/app/login/src/a')?.path).toBe('/w/app/login');
        expect(worktreeAt(worktrees, '/w/app/login')?.path).toBe('/w/app/login');
        expect(worktreeAt(worktrees, '/w/app/loginx')).toBeUndefined();
        const nested = [...worktrees, { ...worktrees[0], path: '/r/app/.wt/x', isMain: false }];
        expect(worktreeAt(nested, '/r/app/.wt/x/y')?.path).toBe('/r/app/.wt/x');
    });
    it('finds a repository by its path or its folder name', () => {
        expect(findRepo(worktrees, 'api')).toBe('/r/api');
        expect(findRepo(worktrees, '/r/app/')).toBe('/r/app');
        expect(findRepo(worktrees, 'web')).toBeUndefined();
    });
});

describe('CliActions', () => {
    it('shows the status with the current worktree', async () => {
        const { run } = setup();
        const result = await run('status');
        expect(result).toMatchObject({ version: '1.2.3', pid: 42, mcpServer: true, worktree: '/w/app/login' });
        expect(result.message).toContain('4 worktrees, 2 agents: 1 working, 0 waiting.');
    });

    it('lists the worktrees of the current repository, or all with --all', async () => {
        const { run } = setup();
        expect(((await run('worktree.list')).worktrees as McpWorktree[]).map(item => item.path)).toEqual(['/r/app', '/w/app/login', '/w/app/busy']);
        expect((await run('worktree.list', { all: true })).worktrees).toHaveLength(4);
        expect((await run('worktree.list', {}, '/tmp')).worktrees).toHaveLength(4);
    });

    it('asks for approval and sends worktree create to the page', async () => {
        const { run, approvals, pages } = setup();
        await run('worktree.create', { branch: 'fix/a', base: 'main', prompt: 'Fix it' });
        expect(approvals).toEqual([{ worktree: '/r/app', tool: 'cli_worktree_create', summary: 'Create the worktree "fix/a" in app' }]);
        expect(pages).toEqual([{ action: 'worktree.create', repoPath: '/r/app', branch: 'fix/a', baseRef: 'main', agentId: undefined, prompt: 'Fix it' }]);
    });

    it('needs a repository for worktree create outside a worktree', async () => {
        const { run, pages } = setup();
        await expect(run('worktree.create', { branch: 'fix/a' }, '/tmp')).rejects.toMatchObject({ code: 'badRequest' });
        await run('worktree.create', { branch: 'fix/a', repo: 'api' }, '/tmp');
        expect(pages[0]).toMatchObject({ repoPath: '/r/api' });
        await expect(run('worktree.create', { branch: 'feature/login' })).rejects.toThrow('has a worktree already');
    });

    it('does not send the command when the user denies it', async () => {
        const { run, pages } = setup({ deny: true });
        await expect(run('agent.start')).rejects.toMatchObject({ code: 'denied' });
        expect(pages).toEqual([]);
    });

    it('removes only a named worktree that is not main and has no working agent', async () => {
        const { run, pages, approvals } = setup();
        await expect(run('worktree.remove')).rejects.toMatchObject({ code: 'badRequest' });
        await expect(run('worktree.remove', { worktree: 'main' }, '/r/app')).rejects.toThrow('main worktree');
        await expect(run('worktree.remove', { worktree: 'busy' })).rejects.toThrow('An agent is working');
        await run('worktree.remove', { worktree: 'feature/login', deleteBranch: true });
        expect(approvals[0]).toMatchObject({ worktree: '/w/app/login', tool: 'cli_worktree_remove' });
        expect(pages).toEqual([{ action: 'worktree.remove', repoPath: '/r/app', worktreePath: '/w/app/login', deleteBranch: true }]);
    });

    it('sends a prompt to the agent of the --worktree value', async () => {
        const { run, pages, approvals } = setup();
        const result = await run('agent.send', { prompt: 'Run the tests', worktree: 'busy' }, '/tmp');
        expect(result.message).toBe('Done.');
        expect(approvals[0]).toMatchObject({ worktree: '/w/app/busy', tool: 'cli_agent_send' });
        expect(pages).toEqual([{ action: 'agent.send', repoPath: '/r/app', worktreePath: '/w/app/busy', prompt: 'Run the tests' }]);
        await expect(run('agent.send', { prompt: 'x', worktree: 'nothing' })).rejects.toMatchObject({ code: 'notFound' });
    });

    it('waits for the turn after a prompt with --wait', async () => {
        const session: TerminalSession = {
            id: 's1',
            title: 'Claude Code',
            cwd: '/w',
            worktreePath: '/w/app/login',
            isAgent: true,
            exited: false,
            agentState: 'done',
            agentStateAt: 10_000
        };
        const { run } = setup({ sessions: [session] });
        const result = await run('agent.send', { prompt: 'Hi', wait: true });
        expect(result).toMatchObject({ state: 'done', sessionId: 's1' });
        expect(result.message).toBe('Done. Claude Code is done.');
    });

    it('uses the MCP tools for the task commands', async () => {
        const { run, tools } = setup();
        expect((await run('task.get')).message).toContain('ENG-1: Login');
        expect((await run('task.status', { status: 'In review' })).message).toBe('Moved ENG-1 to "In review".');
        expect(tools.map(item => [item.name, item.worktree])).toEqual([
            ['get_task', '/w/app/login'],
            ['set_task_status', '/w/app/login']
        ]);
        await expect(run('task.status', { status: 'Nope' })).rejects.toThrow('no status "Nope"');
    });

    it('runs an automation on the worktree, and refuses a task automation', async () => {
        const automations = [
            automation({}),
            automation({
                id: 'nightly',
                name: 'Nightly',
                trigger: { type: 'schedule', days: [1], time: '03:00' },
                binding: { repos: ['/r/api'] }
            }),
            automation({ id: 'triage', trigger: { type: 'task.new' } as Automation['trigger'] })
        ];
        const { run, pages, approvals } = setup({ automations });
        await run('automation.run', { automation: 'fix-ci' });
        expect(pages[0]).toEqual({ action: 'automation.run', automationId: 'fix-ci', repoPath: '/r/app', worktreePath: '/w/app/login' });
        await run('automation.run', { automation: 'Nightly' }, '/tmp');
        expect(approvals[1]).toMatchObject({ worktree: '/r/api', tool: 'cli_automation_run' });
        expect(pages[1]).toEqual({ action: 'automation.run', automationId: 'nightly', repoPath: undefined, worktreePath: undefined });
        await expect(run('automation.run', { automation: 'triage' })).rejects.toThrow('runs on a task');
        await expect(run('automation.run', { automation: 'none' })).rejects.toMatchObject({ code: 'notFound' });
    });

    it('lists the automations', async () => {
        const { run } = setup({ automations: [automation({})] });
        expect(await run('automation.list')).toEqual({
            message: 'fix-ci  Fix CI  [on, ci.failed]',
            automations: [{ id: 'fix-ci', name: 'Fix CI', status: 'on', trigger: 'ci.failed' }]
        });
    });
});
