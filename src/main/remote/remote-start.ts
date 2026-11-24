import { canSetModel, commandSetsModel } from '@shared/agent-models';
import { agentProgramOf } from '@shared/agent-programs';
import type { Project } from '@shared/projects';
import {
    parseStartRequest,
    promptBranchName,
    type RemoteAgentChoice,
    type RemoteRepoChoice,
    type RemoteStartOptions,
    type RemoteStartRequest,
    type RemoteStartResult,
    type RemoteTaskChoice
} from '@shared/remote';
import { agentForRepo, repoDisplayName, type AgentDefinition, type AppSettings } from '@shared/settings';
import type { TaskLink } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import { agentBudgetBlock, budgetWaitText, type ProviderUsage } from '@shared/usage';
import type { Worktree } from '@shared/worktrees';
import { HttpError } from './remote-server';
import { agentOf, remoteWorktreeOf } from './remote-snapshot';

/** A checked start request. It has the agent and the branch. */
export interface PhoneStart {
    repoPath: string;
    agentId: string;
    model?: string;
    /** The branch from the phone. Without it, the task start uses the branch template, and a prompt start uses `promptBranch`. */
    branch?: string;
    /** The branch of a prompt start without a branch from the phone. */
    promptBranch?: string;
    task?: { connectionId: string; id: string };
    prompt?: string;
}

/** The new worktree and the new agent session. The prompt can still be on its way to the agent. */
export interface PhoneStarted {
    worktreePath: string;
    sessionId: string;
}

/** The parts of ShipWarden that a start from the phone uses. The app and the background helper give their own. */
export interface RemoteStarterSources {
    settings(): Promise<AppSettings>;
    projects(): Promise<Project[]>;
    /** The plan usage for the usage budget. The starter calls it only when Settings › Agents has a budget. */
    usage(): Promise<readonly ProviderUsage[]>;
    /** The tasks for the start screen, or a note when no tasks are available. */
    tasks(): Promise<{ tasks: RemoteTaskChoice[]; note?: string }>;
    /** Makes the worktree and starts the agent. Throws an `HttpError` with a message for the phone. */
    start(start: PhoneStart): Promise<PhoneStarted>;
    sessions(): Promise<TerminalSession[]>;
    worktrees(repoPath: string): Promise<Worktree[]>;
    taskLinks(): Promise<Record<string, TaskLink>>;
    now?(): number;
}

/** True when the phone can select a model for the agent. */
function hasModelChoice(agent: AgentDefinition): boolean {
    return canSetModel(agentProgramOf(agent.command)) && !commandSetsModel(agent.command);
}

/**
 * Starts agents for the phone: the checks (the repository, the agent, and the usage budget) and the answer. The app
 * and the background helper use it with their own start function.
 */
export class RemoteStarter {
    constructor(private readonly sources: RemoteStarterSources) {}

    private now(): number {
        return this.sources.now?.() ?? Date.now();
    }

    /** The usage, or an empty list when Settings › Agents has no budget. Then no usage request goes out. */
    private async usage(settings: AppSettings): Promise<readonly ProviderUsage[]> {
        return settings.usageBudget.percent === null ? [] : this.sources.usage();
    }

    /** The reason when the usage budget stops the agent now. */
    private budgetWait(settings: AppSettings, usage: readonly ProviderUsage[], agent: AgentDefinition, now: number): string | undefined {
        const block = agentBudgetBlock(usage, settings.usageBudget, [agent.command], now);
        return block && budgetWaitText(block, now);
    }

    async options(): Promise<RemoteStartOptions> {
        const [settings, projects, tasks] = await Promise.all([
            this.sources.settings(),
            this.sources.projects(),
            this.sources.tasks().catch(error => ({ tasks: [], note: `The tasks did not load: ${error instanceof Error ? error.message : String(error)}` }))
        ]);
        const usage = await this.usage(settings).catch(() => []);
        const now = this.now();
        const seen = new Set<string>();
        const repos: RemoteRepoChoice[] = [];
        for (const project of projects) {
            for (const path of project.repos) {
                if (seen.has(path)) continue;
                seen.add(path);
                repos.push({ path, name: repoDisplayName(settings, path), projectName: project.name, agentId: agentForRepo(settings, path).id });
            }
        }
        const agents: RemoteAgentChoice[] = settings.agents.map(agent => {
            const wait = this.budgetWait(settings, usage, agent, now);
            return {
                id: agent.id,
                name: agent.name,
                ...(agent.model ? { model: agent.model } : {}),
                canSetModel: hasModelChoice(agent),
                ...(wait ? { budgetWait: wait } : {})
            };
        });
        return { repos, agents, tasks: tasks.tasks, ...(tasks.note ? { tasksNote: tasks.note } : {}) };
    }

    async start(body: unknown): Promise<RemoteStartResult> {
        let request: RemoteStartRequest;
        try {
            request = parseStartRequest(body);
        } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        const [settings, projects] = await Promise.all([this.sources.settings(), this.sources.projects()]);
        if (!projects.some(project => project.repos.includes(request.repoPath))) {
            throw new HttpError(404, 'The repository is not in a ShipWarden project.');
        }
        const agent = request.agentId ? settings.agents.find(item => item.id === request.agentId) : agentForRepo(settings, request.repoPath);
        if (!agent) throw new HttpError(400, 'The agent is not in Settings › Agents on the Mac.');
        if (request.model && !hasModelChoice(agent)) {
            throw new HttpError(400, `ShipWarden cannot set the model of ${agent.name}.`);
        }
        const now = this.now();
        const wait = this.budgetWait(settings, await this.usage(settings), agent, now);
        if (wait) throw new HttpError(409, wait);

        const started = await this.sources.start({
            repoPath: request.repoPath,
            agentId: agent.id,
            ...(request.model ? { model: request.model } : {}),
            ...(request.branch ? { branch: request.branch } : {}),
            ...(request.prompt ? { prompt: request.prompt, ...(request.branch ? {} : { promptBranch: promptBranchName(request.prompt, now) }) } : {}),
            ...(request.task ? { task: request.task } : {})
        });

        const [worktrees, sessions, links] = await Promise.all([
            this.sources.worktrees(request.repoPath).catch(() => [] as Worktree[]),
            this.sources.sessions().catch(() => [] as TerminalSession[]),
            this.sources.taskLinks().catch(() => ({}) as Record<string, TaskLink>)
        ]);
        const worktree = worktrees.find(item => item.path === started.worktreePath);
        const session = sessions.find(item => item.id === started.sessionId);
        return {
            repoPath: request.repoPath,
            worktree: worktree
                ? remoteWorktreeOf(worktree, settings, links[worktree.path])
                : { path: started.worktreePath, name: started.worktreePath.split('/').pop() ?? started.worktreePath, isMain: false },
            agent: session
                ? agentOf(session, undefined, this.now())
                : { id: started.sessionId, title: agent.name, worktreePath: started.worktreePath, cwd: started.worktreePath, state: 'starting', exited: false }
        };
    }
}
