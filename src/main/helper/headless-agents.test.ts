import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import type { QueueItem } from '@shared/task-queue';
import type { TaskLink } from '@shared/tasks';
import type { CreateTerminalOptions, TerminalSession } from '@shared/terminal';
import { HelperAgents, helperTaskBranch } from './headless-agents';

const hookPaths = { claude: '/data/claude-hooks.json', codex: '/data/codex-hook.sh', gemini: '/data/gemini-hooks.json', opencode: '/data/oc.js' };

function setup(screen = '', settings: AppSettings = DEFAULT_SETTINGS) {
    const sessions: TerminalSession[] = [];
    const created: CreateTerminalOptions[] = [];
    const writes: [string, string][] = [];
    const links: [string, TaskLink][] = [];
    const agents = new HelperAgents({
        terminals: {
            create: async options => {
                created.push(options);
                const session: TerminalSession = {
                    id: `s${created.length}`,
                    title: options.title,
                    cwd: options.cwd,
                    worktreePath: options.worktreePath,
                    isAgent: options.isAgent ?? false,
                    cols: options.cols,
                    rows: options.rows,
                    exited: false,
                    // The agent printed its start screen just now.
                    lastActiveAt: Date.now() + 1
                };
                sessions.push(session);
                return session;
            },
            list: async () => sessions,
            replay: async () => ({ data: '', seq: 0 }),
            write: (id, data) => writes.push([id, data])
        },
        worktrees: {
            create: async ({ repoPath, branch }) => ({ path: `/wt/${branch}`, branch, head: 'abc', isMain: false, isBare: false, repoPath }) as never,
            copyIgnored: async () => []
        },
        settings: async () => settings,
        hookPaths,
        env: () => ({ SHELL: '/bin/zsh' }),
        worktreesRoot: '/wt',
        home: '/home',
        username: 'austin',
        saveTaskLink: async (path, link) => {
            links.push([path, link]);
        },
        screenText: async () => screen,
        pollMs: 5,
        timeouts: { start: 200, quiet: 10, dialog: 30, submit: 1 }
    });
    return { agents, sessions, created, writes, links };
}

describe('helperTaskBranch', () => {
    it('uses the key and the title without a template, and the template else', () => {
        const task = { id: '1', key: 'ENG-7', title: 'Fix the login page' };
        expect(helperTaskBranch(task, undefined, 'austin')).toBe('eng-7-fix-the-login-page');
        expect(helperTaskBranch(task, '{username}/{taskKey}-{taskShortDescription}', 'austin')).toMatch(/^austin\/ENG-7-/);
    });
});

describe('HelperAgents', () => {
    it('starts a queue item: worktree, task link, and an agent with the task prompt and the hooks', async () => {
        const { agents, created, writes, links } = setup();
        const item = {
            id: 'q1',
            connectionId: 'c1',
            pluginId: 'local',
            task: { id: '7', key: 'ENG-7', title: 'Fix login', status: { id: 'o', name: 'Open', category: 'todo' } },
            repoPath: '/repo',
            status: 'queued',
            addedAt: 0,
            updatedAt: 0,
            attempts: 0
        } satisfies QueueItem;
        const { worktree, session } = await agents.startTask(item);
        expect(worktree.path).toBe('/wt/eng-7-fix-login');
        expect(links).toEqual([['/wt/eng-7-fix-login', expect.objectContaining({ connectionId: 'c1', taskId: '7', key: 'ENG-7' })]]);
        expect(created[0]).toMatchObject({ cwd: '/wt/eng-7-fix-login', isAgent: true, title: 'Claude Code', reportsAgentState: true });
        expect(created[0].command).toContain('--settings');
        expect(writes[0][0]).toBe(session.id);
        expect(writes[0][1]).toContain('ENG-7');
        expect(writes[1]).toEqual([session.id, '\r']);
    });

    it('sends a prompt to the running agent of the worktree', async () => {
        const { agents, sessions, created, writes } = setup();
        sessions.push({ id: 'old', title: 'Codex', cwd: '/wt/a', worktreePath: '/wt/a', isAgent: true, cols: 80, rows: 24, exited: false, lastActiveAt: 0 });
        const session = await agents.promptAgent('/wt/a', 'Fix CI', {});
        expect(session.id).toBe('old');
        expect(created).toHaveLength(0);
        expect(writes.map(write => write[1])).toEqual(['\x1b[200~Fix CI\x1b[201~', '\r']);
    });

    it('does not answer a dialog of the agent', async () => {
        const { agents, sessions, writes } = setup('Do you trust this folder?');
        sessions.push({ id: 'old', title: 'Claude Code', cwd: '/wt/a', worktreePath: '/wt/a', isAgent: true, cols: 80, rows: 24, exited: false });
        await expect(agents.promptAgent('/wt/a', 'Fix CI', {})).rejects.toThrow('The agent is asking a question.');
        expect(writes).toEqual([]);
    });

    it('fails for a closed session and for a mode change of a running agent', async () => {
        const { agents, sessions } = setup();
        await expect(agents.promptAgent('/wt/a', 'x', { sessionId: 'gone' })).rejects.toThrow('The agent tab closed.');
        sessions.push({ id: 'old', title: 'Claude Code', cwd: '/wt/a', worktreePath: '/wt/a', isAgent: true, cols: 80, rows: 24, exited: false });
        await expect(agents.promptAgent('/wt/a', 'x', { mode: 'plan' })).rejects.toThrow('cannot change its mode');
    });

    it('starts the setup script of the repository in a terminal of the new worktree', async () => {
        const settings: AppSettings = { ...DEFAULT_SETTINGS, repos: { '/repo': { worktrees: { setupScript: 'npm install' } } } as AppSettings['repos'] };
        const { agents, created } = setup('', settings);
        await agents.startInNewWorktree('/repo', 'nightly', 'Go');
        expect(created.map(item => item.title)).toEqual(['Setup', 'Claude Code']);
        expect(created[0].command).toContain('npm install');
    });
});
