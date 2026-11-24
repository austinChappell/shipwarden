import { agentStartCommand, type AgentMode } from '@shared/agent-modes';
import { bracketedPaste, repoFolderName, showsAgentDialog } from '@shared/agent-text';
import type { HookSettingsPaths } from '@shared/agents';
import { branchValues, renderBranchTemplate } from '@shared/branch-template';
import { agentForRepo, type AppSettings } from '@shared/settings';
import { branchNameForTask, taskLinkOf, taskPrompt, type Task, type TaskLink } from '@shared/tasks';
import type { QueueItem } from '@shared/task-queue';
import type { CreateTerminalOptions, TerminalReplay, TerminalSession } from '@shared/terminal';
import { resolveWorktreeSettings, setupCommand, type CopyIgnoredSettings } from '@shared/worktree-settings';
import type { CreateWorktreeOptions, Worktree } from '@shared/worktrees';
import type { HeadlessAgents } from '../automations/headless-engine';
import { terminalCommand } from '../ipc/args';

/** The time that an agent can take to start before the helper sends it a prompt. The page uses the same time. */
const AGENT_START_TIMEOUT_MS = 15_000;
/** An agent is ready for input when its output was quiet for this time. */
const AGENT_QUIET_MS = 1200;
/** The time that the helper waits for the user to answer a dialog of the agent, for example on the phone. */
const AGENT_DIALOG_TIMEOUT_MS = 120_000;
/** The time between the text and Enter. Claude Code takes text and Enter in one chunk as a paste. */
const SUBMIT_DELAY_MS = 200;
const SIZE = { cols: 120, rows: 32 };

/** The PTY host functions that the helper uses. `PtyHostClient` has this shape. */
export interface HelperTerminals {
    create(options: CreateTerminalOptions, env: NodeJS.ProcessEnv): Promise<TerminalSession>;
    list(): Promise<TerminalSession[]>;
    replay(id: string): Promise<TerminalReplay>;
    write(id: string, data: string): void;
}

/** The git functions that the helper uses. `GitWorktreeService` has this shape. */
export interface HelperWorktrees {
    create(options: CreateWorktreeOptions, parentFolder?: string): Promise<Worktree>;
    copyIgnored(repoPath: string, worktreePath: string, copy: CopyIgnoredSettings): Promise<string[]>;
}

export interface HelperAgentOptions {
    terminals: HelperTerminals;
    worktrees: HelperWorktrees;
    settings(): Promise<AppSettings>;
    /** The files that add the hooks to an agent command. The app writes them at its start. */
    hookPaths: HookSettingsPaths;
    /** The environment of a new session: the login shell PATH and the shell integration of the app. */
    env(): NodeJS.ProcessEnv;
    /** The default folder of new worktrees. */
    worktreesRoot: string;
    home: string;
    username: string;
    /** Links a new worktree to its task, in the task links file of the app. */
    saveTaskLink(worktreePath: string, link: TaskLink): Promise<void>;
    /** The text of the screen of a session. */
    screenText(sessionId: string): Promise<string | undefined>;
    log?: (message: string) => void;
    /** The time between two checks of the session list. Tests make it short. */
    pollMs?: number;
    timeouts?: { start?: number; quiet?: number; dialog?: number; submit?: number };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Makes the branch name of a task from the branch template of Settings › Worktrees. The helper does not ask an agent
 * for the {taskShortDescription} variable. That variable comes from the title, as in the page when the agent fails.
 */
export function helperTaskBranch(task: Pick<Task, 'id' | 'key' | 'title'>, template: string | undefined, username: string): string {
    if (!template?.trim()) return branchNameForTask(task);
    return renderBranchTemplate(template, branchValues(task, username)) || branchNameForTask(task);
}

/**
 * Starts worktrees and agents for the background helper. The agents run in the PTY host, so they continue to run when
 * the helper stops, and the app shows them when it opens.
 *
 * The agents of the helper get the agent hooks of the app. While the app is closed, the hooks cannot reach it, so
 * the helper sees the state of an agent from its output only. The agents do not get the ShipWarden MCP server.
 */
export class HelperAgents implements HeadlessAgents {
    private readonly options: HelperAgentOptions;

    constructor(options: HelperAgentOptions) {
        this.options = options;
    }

    sessions(): Promise<TerminalSession[]> {
        return this.options.terminals.list();
    }

    async startInNewWorktree(repoPath: string, branch: string, prompt: string, agentId?: string, mode?: AgentMode) {
        const worktree = await this.createWorktree(repoPath, branch);
        const session = await this.promptAgent(worktree.path, prompt, {
            repoPath,
            newSession: true,
            ...(agentId ? { agentId } : {}),
            ...(mode ? { mode } : {})
        });
        return { worktree, session };
    }

    /** Starts an item of the task queue: the worktree on the task branch, the task link, and the agent with the task prompt. */
    async startTask(item: QueueItem): Promise<{ worktree: Worktree; session: TerminalSession }> {
        const settings = await this.options.settings();
        const branch = helperTaskBranch(item.task, settings.worktrees.branchTemplate, this.options.username);
        const worktree = await this.createWorktree(item.repoPath, branch);
        await this.options.saveTaskLink(worktree.path, taskLinkOf(item.task, item.connectionId, item.pluginId));
        const session = await this.promptAgent(worktree.path, taskPrompt(item.task, worktree.branch ?? branch), {
            repoPath: item.repoPath,
            newSession: true,
            ...(item.agentId ? { agentId: item.agentId } : {})
        });
        return { worktree, session };
    }

    /**
     * Sends a prompt to an agent. The same rules as `promptAgent` of the page:
     * - With `sessionId`, the prompt goes to that session.
     * - Else it goes to the agent of the worktree. Without one, or with `newSession`, a new agent starts.
     * The helper cannot change the mode of a running agent.
     */
    async promptAgent(
        worktreePath: string,
        prompt: string,
        target: { sessionId?: string; agentId?: string; repoPath?: string; mode?: AgentMode; newSession?: boolean }
    ): Promise<TerminalSession> {
        const sessions = target.newSession ? [] : await this.options.terminals.list();
        let session = target.sessionId
            ? sessions.find(item => item.id === target.sessionId && !item.exited)
            : sessions.find(item => item.worktreePath === worktreePath && item.isAgent && !item.exited);
        if (target.sessionId && !session) throw new Error('The agent tab closed.');
        const fresh = !session;
        if (!session) {
            session = await this.startAgent(worktreePath, target.repoPath, target.agentId, target.mode);
        } else if (target.mode) {
            throw new Error('An agent runs in the worktree, and the background helper cannot change its mode. Open ShipWarden to run this automation.');
        }
        if (!prompt) return session;
        if (!(await this.waitForNoDialog(session.id))) {
            throw new Error(
                fresh
                    ? 'The new agent is asking a question, for example about folder trust. Answer it in the agent tab, then approve the run again.'
                    : 'The agent is asking a question. Answer it in the agent tab, then approve the run again.'
            );
        }
        const id = session.id;
        this.options.terminals.write(id, bracketedPaste(prompt));
        await delay(this.options.timeouts?.submit ?? SUBMIT_DELAY_MS);
        this.options.terminals.write(id, '\r');
        return session;
    }

    /** Makes the worktree with the worktree settings of the repository, copies the ignored files, and starts the setup script. */
    private async createWorktree(repoPath: string, branch: string): Promise<Worktree> {
        const settings = await this.options.settings();
        const config = resolveWorktreeSettings(
            settings.worktrees,
            settings.repos[repoPath]?.worktrees,
            repoPath,
            this.options.worktreesRoot,
            this.options.home
        );
        const worktree = await this.options.worktrees.create({ repoPath, branch }, config.parentFolder);
        if (config.copyIgnored.enabled) {
            await this.options.worktrees
                .copyIgnored(repoPath, worktree.path, config.copyIgnored)
                .catch(error => this.options.log?.(`The ignored files were not copied: ${error instanceof Error ? error.message : String(error)}`));
        }
        const script = settings.repos[repoPath]?.worktrees?.setupScript;
        if (script) {
            const command = setupCommand(script, {
                rootPath: repoPath,
                worktreePath: worktree.path,
                branch: worktree.branch,
                repoName: repoFolderName(repoPath)
            });
            await this.options.terminals
                .create({ cwd: worktree.path, worktreePath: worktree.path, title: 'Setup', command, ...SIZE }, this.options.env())
                .catch(error => this.options.log?.(`The setup script did not start: ${error instanceof Error ? error.message : String(error)}`));
        }
        return worktree;
    }

    private async startAgent(
        worktreePath: string,
        repoPath: string | undefined,
        agentId: string | undefined,
        mode: AgentMode | undefined
    ): Promise<TerminalSession> {
        const settings = await this.options.settings();
        const definition = agentId ? settings.agents.find(agent => agent.id === agentId) : agentForRepo(settings, repoPath);
        if (!definition) throw new Error(`The agent "${agentId}" is not in Settings › Agents.`);
        const { command, reportsAgentState } = terminalCommand({ command: agentStartCommand(definition, mode), isAgent: true }, this.options.hookPaths);
        const started = Date.now();
        const session = await this.options.terminals.create(
            { cwd: worktreePath, worktreePath, title: definition.name, command, isAgent: true, reportsAgentState, ...SIZE },
            this.options.env()
        );
        await this.waitForQuietOutput(session.id, started);
        return session;
    }

    /** Waits until the new session printed output and then was quiet for a short time. Then the agent is ready for input. */
    private async waitForQuietOutput(sessionId: string, since: number): Promise<void> {
        const quiet = this.options.timeouts?.quiet ?? AGENT_QUIET_MS;
        const deadline = Date.now() + (this.options.timeouts?.start ?? AGENT_START_TIMEOUT_MS);
        while (Date.now() < deadline) {
            const session = (await this.options.terminals.list()).find(item => item.id === sessionId);
            if (!session || session.exited) return;
            const last = session.lastActiveAt ?? 0;
            if (last > since && Date.now() - last >= quiet) return;
            await delay(this.options.pollMs ?? 300);
        }
    }

    /** Waits until the screen shows no dialog. Returns false when a dialog is still visible after the time limit. */
    private async waitForNoDialog(sessionId: string): Promise<boolean> {
        const deadline = Date.now() + (this.options.timeouts?.dialog ?? AGENT_DIALOG_TIMEOUT_MS);
        for (;;) {
            const screen = await this.options.screenText(sessionId);
            if (screen === undefined || !showsAgentDialog(screen)) return true;
            if (Date.now() >= deadline) return false;
            await delay(this.options.pollMs ?? 1000);
        }
    }
}
