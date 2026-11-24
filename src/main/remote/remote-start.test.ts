import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import type { TerminalSession } from '@shared/terminal';
import type { ProviderUsage } from '@shared/usage';
import { HttpError } from './remote-server';
import { RemoteStarter, type PhoneStart, type RemoteStarterSources } from './remote-start';

const NOW = Date.UTC(2026, 10, 23, 12, 0);

const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    agents: [
        { id: 'claude', name: 'Claude Code', command: 'claude', model: 'sonnet' },
        { id: 'gemini', name: 'Gemini CLI', command: 'gemini' }
    ],
    defaultAgentId: 'claude'
};

const overBudget: ProviderUsage[] = [
    {
        provider: 'claude',
        status: 'ok',
        windows: [{ kind: 'session', label: '5h', usedPercent: 90, resetsAt: new Date(NOW + 3600_000).toISOString() }]
    }
];

function setup(change: Partial<RemoteStarterSources> = {}, appSettings: AppSettings = settings) {
    const starts: PhoneStart[] = [];
    const usage = vi.fn(async () => overBudget);
    const session: TerminalSession = { id: 's1', title: 'Claude Code', cwd: '/wt/fix', worktreePath: '/wt/fix', isAgent: true, exited: false };
    const starter = new RemoteStarter({
        settings: async () => appSettings,
        projects: async () => [
            { id: 'p1', name: 'Work', repos: ['/repo', '/other'] },
            { id: 'p2', name: 'Side', repos: ['/repo'] }
        ],
        usage,
        tasks: async () => ({ tasks: [{ connectionId: 'c1', id: '7', title: 'Fix login' }] }),
        start: async start => {
            starts.push(start);
            return { worktreePath: '/wt/fix', sessionId: 's1' };
        },
        sessions: async () => [session],
        worktrees: async () => [{ path: '/wt/fix', branch: 'fix-login', head: 'abc', isMain: false, isBare: false } as never],
        taskLinks: async () => ({ '/wt/fix': { connectionId: 'c1', pluginId: 'p', taskId: '7', title: 'Fix login', key: 'ENG-7' } }),
        now: () => NOW,
        ...change
    });
    return { starter, starts, usage };
}

async function status(work: Promise<unknown>): Promise<number | undefined> {
    try {
        await work;
        return undefined;
    } catch (error) {
        return error instanceof HttpError ? error.status : -1;
    }
}

describe('RemoteStarter', () => {
    it('lists each repository one time, the agents, and the tasks, without usage when there is no budget', async () => {
        const { starter, usage } = setup();
        const options = await starter.options();
        expect(options.repos).toEqual([
            { path: '/repo', name: 'repo', projectName: 'Work', agentId: 'claude' },
            { path: '/other', name: 'other', projectName: 'Work', agentId: 'claude' }
        ]);
        expect(options.agents).toEqual([
            { id: 'claude', name: 'Claude Code', model: 'sonnet', canSetModel: true },
            { id: 'gemini', name: 'Gemini CLI', canSetModel: false }
        ]);
        expect(options.tasks).toHaveLength(1);
        expect(usage).not.toHaveBeenCalled();
    });

    it('shows the budget wait of each agent, and a task error as a note', async () => {
        const { starter } = setup(
            {
                tasks: async () => {
                    throw new Error('The ShipWarden window is closed.');
                }
            },
            { ...settings, usageBudget: { percent: 80, windows: 'all' } }
        );
        const options = await starter.options();
        expect(options.agents[0].budgetWait).toMatch(/^Waiting for usage to reset\. Claude \(5h\) is at 90%/);
        expect(options.agents[1].budgetWait).toBeUndefined();
        expect(options.tasks).toEqual([]);
        expect(options.tasksNote).toContain('window is closed');
    });

    it('starts a prompt with the agent of the repository and a branch from the prompt, and returns the new agent and worktree', async () => {
        const { starter, starts } = setup();
        const result = await starter.start({ repoPath: '/repo', prompt: 'Fix the login page', model: 'opus' });
        expect(starts).toEqual([{ repoPath: '/repo', agentId: 'claude', model: 'opus', prompt: 'Fix the login page', promptBranch: 'fix-the-login-page' }]);
        expect(result.repoPath).toBe('/repo');
        expect(result.worktree).toEqual({ path: '/wt/fix', branch: 'fix-login', name: 'fix-login', isMain: false, task: { title: 'Fix login', key: 'ENG-7' } });
        expect(result.agent).toMatchObject({ id: 's1', title: 'Claude Code', worktreePath: '/wt/fix', exited: false });
    });

    it('starts a task with the branch of the phone', async () => {
        const { starter, starts } = setup();
        await starter.start({ repoPath: '/repo', task: { connectionId: 'c1', id: '7' }, agentId: 'gemini', branch: 'eng-7' });
        expect(starts).toEqual([{ repoPath: '/repo', agentId: 'gemini', branch: 'eng-7', task: { connectionId: 'c1', id: '7' } }]);
    });

    it('refuses a bad request, an unknown repository or agent, and a model that ShipWarden cannot set', async () => {
        const { starter, starts } = setup();
        expect(await status(starter.start({ repoPath: '/repo' }))).toBe(400);
        expect(await status(starter.start({ repoPath: '/elsewhere', prompt: 'x' }))).toBe(404);
        expect(await status(starter.start({ repoPath: '/repo', prompt: 'x', agentId: 'missing' }))).toBe(400);
        expect(await status(starter.start({ repoPath: '/repo', prompt: 'x', agentId: 'gemini', model: 'pro' }))).toBe(400);
        expect(starts).toEqual([]);
    });

    it('does not start an agent over the usage budget', async () => {
        const { starter, starts } = setup({}, { ...settings, usageBudget: { percent: 80, windows: 'all' } });
        await expect(starter.start({ repoPath: '/repo', prompt: 'x' })).rejects.toThrow('Waiting for usage to reset');
        expect(await status(starter.start({ repoPath: '/repo', prompt: 'x' }))).toBe(409);
        expect(starts).toEqual([]);
        // The budget counts only the provider of the agent.
        await starter.start({ repoPath: '/repo', prompt: 'x', agentId: 'gemini' });
        expect(starts).toHaveLength(1);
    });

    it('answers with a starting agent when the session list does not have the new session yet', async () => {
        const { starter } = setup({ sessions: async () => [], worktrees: async () => [] });
        const result = await starter.start({ repoPath: '/repo', prompt: 'x' });
        expect(result.agent).toEqual({ id: 's1', title: 'Claude Code', worktreePath: '/wt/fix', cwd: '/wt/fix', state: 'starting', exited: false });
        expect(result.worktree).toEqual({ path: '/wt/fix', name: 'fix', isMain: false });
    });
});
