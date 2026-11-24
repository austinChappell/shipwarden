import { basename } from 'path';
import { manualTarget, type Automation } from '@shared/automations';
import type { CliPageRequest, CliPageResult, CliRequest, CliResult } from '@shared/cli';
import type { CliWriteAction } from '@shared/mcp';
import type { TerminalSession } from '@shared/terminal';
import type { ApprovalRequest } from '../mcp/approvals';
import type { ToolHost, ToolResult } from '../mcp/protocol';
import { findWorktree, type McpWorktree } from '../mcp/tools';
import { waitForAgent, waitTimeoutMs } from './agent-wait';
import { CliError, type CliHandler } from './cli-server';

/** The parts of the app that the commands use. The tests give fakes. */
export interface CliService {
    version: string;
    pid: number;
    home: string;
    /** True when Settings › Agents gives agents the MCP tools. */
    mcpServer(): Promise<boolean>;
    /** All worktrees of the projects, with their tasks, pull requests, and agents. */
    worktrees(): Promise<McpWorktree[]>;
    /** The MCP tools. "task get" and "task status" call them. */
    tools: Pick<ToolHost, 'call'>;
    /** Asks the user the first time, as for the MCP write tools. Rejects when the user denies. */
    approve(request: ApprovalRequest, signal: AbortSignal): Promise<void>;
    sessions(): Promise<TerminalSession[]>;
    automations(): Promise<Automation[]>;
    /** Sends a request to the page. Rejects when no window is open. */
    page(request: CliPageRequest, signal: AbortSignal): Promise<CliPageResult>;
    now?(): number;
}

/** Returns the worktree that contains the folder. A nested worktree wins over its parent. */
export function worktreeAt(list: readonly McpWorktree[], folder: string): McpWorktree | undefined {
    const path = folder.replace(/\/+$/, '');
    return list.filter(item => path === item.path || path.startsWith(`${item.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
}

/** Finds a repository by its path or its folder name. */
export function findRepo(list: readonly McpWorktree[], wanted: string): string | undefined {
    const text = wanted.trim().replace(/\/+$/, '');
    const repos = [...new Set(list.map(item => item.repo))];
    return repos.find(repo => repo === text) ?? repos.find(repo => basename(repo) === text);
}

function text(args: CliRequest['args'], name: string): string | undefined {
    const value = args[name];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new CliError('badRequest', `The value of "${name}" must be a text.`);
    return value;
}

function requiredText(args: CliRequest['args'], name: string, hint: string): string {
    const value = text(args, name)?.trim();
    if (!value) throw new CliError('badRequest', hint);
    return value;
}

/** The data of a tool result. A failed tool gives a CliError with the text of the tool. */
function toolData(result: ToolResult | undefined): Record<string, unknown> {
    const message = result?.content.find(item => item.type === 'text')?.text ?? 'The tool gave no result.';
    if (!result || result.isError) throw new CliError('failed', message);
    return result.structuredContent ?? {};
}

/** One line for a worktree: the name, the branch, the agents, and the pull request. */
export function worktreeLine(worktree: McpWorktree, current?: string): string {
    const parts = [`${worktree.path === current ? '*' : ' '} ${worktree.name}`];
    if (worktree.branch && worktree.branch !== worktree.name) parts.push(`(${worktree.branch})`);
    if (worktree.isMain) parts.push('[main]');
    const states = worktree.agents.map(agent => `${agent.title}: ${agent.state ?? 'running'}`);
    if (states.length) parts.push(`agents: ${states.join(', ')}`);
    if (worktree.pullRequest) parts.push(`PR #${worktree.pullRequest.number}${worktree.pullRequest.checks ? ` (${worktree.pullRequest.checks})` : ''}`);
    return `${parts.join('  ')}\n    ${worktree.path}`;
}

/**
 * The commands of the `shipwarden` CLI. The read commands run here. The commands that act on agent tabs, the worktree
 * list, and the automations go to the page, after the approval. "task get" and "task status" use the MCP tools.
 */
export class CliActions implements CliHandler {
    constructor(private readonly service: CliService) {}

    async handle(request: CliRequest, signal: AbortSignal): Promise<CliResult> {
        const { args } = request;
        switch (request.command) {
            case 'status':
                return this.status(request);
            case 'worktree.list':
                return this.listWorktrees(request);
            case 'worktree.create':
                return this.createWorktree(request, signal);
            case 'worktree.remove':
                return this.removeWorktree(request, signal);
            case 'agent.start': {
                const target = await this.target(request);
                const agentId = text(args, 'agent');
                const prompt = text(args, 'prompt');
                await this.approve(target.path, 'cli_agent_start', `Start ${agentId ? `the agent "${agentId}"` : 'an agent'} in "${target.name}"`, signal);
                const sentAt = this.now();
                const result = await this.service.page({ action: 'agent.start', repoPath: target.repo, worktreePath: target.path, agentId, prompt }, signal);
                return this.waitIfAsked(request, result, sentAt, signal);
            }
            case 'agent.send':
                return this.send(request, signal);
            case 'agent.wait': {
                const target = await this.target(request);
                const result = await waitForAgent({
                    sessions: () => this.service.sessions(),
                    worktree: target.path,
                    timeoutMs: waitTimeoutMs(args.timeout),
                    signal,
                    now: () => this.now()
                });
                return { message: `${result.title} is ${result.state}.${result.message ? ` ${result.message}` : ''}`, ...result };
            }
            case 'task.get':
                return this.getTask(request, signal);
            case 'task.status': {
                const target = await this.target(request);
                const status = requiredText(args, 'status', 'Give the new status, for example: shipwarden task status "In review"');
                const data = toolData(await this.service.tools.call('set_task_status', { status }, { worktree: target.path, signal }));
                return { message: `Moved ${String(data.task)} to "${String(data.status)}".`, ...data };
            }
            case 'automation.list': {
                const automations = (await this.service.automations()).map(automation => ({
                    id: automation.id,
                    name: automation.name,
                    status: automation.status,
                    trigger: automation.trigger.type
                }));
                const lines = automations.map(item => `${item.id}  ${item.name}  [${item.status}, ${item.trigger}]`);
                return { message: lines.length ? lines.join('\n') : 'No automations. Make one in the Automations view.', automations };
            }
            case 'automation.run':
                return this.runAutomation(request, signal);
        }
    }

    private async approve(worktree: string, tool: CliWriteAction, summary: string, signal: AbortSignal): Promise<void> {
        try {
            await this.service.approve({ worktree, tool, summary }, signal);
        } catch (error) {
            throw new CliError('denied', error instanceof Error ? error.message : String(error));
        }
    }

    /** The worktree of the "worktree" value, else the worktree of the working folder. */
    private async target(request: CliRequest, list?: McpWorktree[]): Promise<McpWorktree> {
        const worktrees = list ?? (await this.service.worktrees());
        const wanted = text(request.args, 'worktree');
        if (wanted) {
            const found = findWorktree(worktrees, wanted);
            if (!found) throw new CliError('notFound', `No worktree has the path, branch, or name "${wanted}". Run "shipwarden worktree list --all".`);
            return found;
        }
        const here = worktreeAt(worktrees, request.cwd);
        if (!here) throw new CliError('badRequest', `The folder ${request.cwd} is not in a worktree of ShipWarden. Give the worktree with --worktree.`);
        return here;
    }

    private async status(request: CliRequest): Promise<CliResult> {
        const worktrees = await this.service.worktrees();
        const current = worktreeAt(worktrees, request.cwd);
        const agents = worktrees.flatMap(worktree => worktree.agents);
        const count = (state: string) => agents.filter(agent => agent.state === state).length;
        const lines = [
            `ShipWarden ${this.service.version} is running (PID ${this.service.pid}).`,
            current ? `Worktree: ${current.name} (${current.path})` : 'The working folder is not in a worktree of ShipWarden.',
            `${worktrees.length} worktrees, ${agents.length} agents: ${count('working')} working, ${count('waiting')} waiting.`
        ];
        return {
            message: lines.join('\n'),
            version: this.service.version,
            pid: this.service.pid,
            mcpServer: await this.service.mcpServer(),
            worktree: current?.path ?? null,
            worktrees
        };
    }

    private async listWorktrees(request: CliRequest): Promise<CliResult> {
        const all = await this.service.worktrees();
        const current = worktreeAt(all, request.cwd);
        const worktrees = request.args.all === true || !current ? all : all.filter(item => item.repo === current.repo);
        const message = worktrees.length
            ? worktrees.map(item => worktreeLine(item, current?.path)).join('\n')
            : 'No worktrees. Add a repository in ShipWarden.';
        return { message, current: current?.path ?? null, worktrees };
    }

    private async createWorktree(request: CliRequest, signal: AbortSignal): Promise<CliResult> {
        const { args } = request;
        const branch = requiredText(args, 'branch', 'Give the branch of the new worktree, for example: shipwarden worktree create feature/login');
        const list = await this.service.worktrees();
        const wantedRepo = text(args, 'repo');
        const repo = wantedRepo ? findRepo(list, wantedRepo) : worktreeAt(list, request.cwd)?.repo;
        if (!repo) {
            throw new CliError(
                wantedRepo ? 'notFound' : 'badRequest',
                wantedRepo
                    ? `No project of ShipWarden has the repository "${wantedRepo}".`
                    : `The folder ${request.cwd} is not in a worktree of ShipWarden. Give the repository with --repo.`
            );
        }
        if (list.some(item => item.repo === repo && item.branch === branch)) {
            throw new CliError('badRequest', `The branch "${branch}" has a worktree already.`);
        }
        await this.approve(repo, 'cli_worktree_create', `Create the worktree "${branch}" in ${basename(repo)}`, signal);
        const sentAt = this.now();
        const result = await this.service.page(
            { action: 'worktree.create', repoPath: repo, branch, baseRef: text(args, 'base'), agentId: text(args, 'agent'), prompt: text(args, 'prompt') },
            signal
        );
        return this.waitIfAsked(request, result, sentAt, signal);
    }

    private async removeWorktree(request: CliRequest, signal: AbortSignal): Promise<CliResult> {
        if (!text(request.args, 'worktree')) {
            throw new CliError('badRequest', 'Give the worktree to remove, for example: shipwarden worktree remove feature/login');
        }
        const target = await this.target(request);
        if (target.isMain) throw new CliError('badRequest', 'ShipWarden does not remove the main worktree of a repository.');
        if (target.agents.some(agent => agent.state === 'working')) {
            throw new CliError('badRequest', `An agent is working in "${target.name}". ShipWarden did not remove it.`);
        }
        const deleteBranch = request.args.deleteBranch === true;
        await this.approve(target.path, 'cli_worktree_remove', `Remove the worktree "${target.name}"${deleteBranch ? ' and its branch' : ''}`, signal);
        return { ...(await this.service.page({ action: 'worktree.remove', repoPath: target.repo, worktreePath: target.path, deleteBranch }, signal)) };
    }

    private async send(request: CliRequest, signal: AbortSignal): Promise<CliResult> {
        const { args } = request;
        const prompt = requiredText(args, 'prompt', 'Give the prompt, for example: shipwarden agent send "Run the tests"');
        const target = await this.target(request);
        await this.approve(
            target.path,
            'cli_agent_send',
            `Send to the agent in "${target.name}": ${prompt.length > 120 ? `${prompt.slice(0, 119)}…` : prompt}`,
            signal
        );
        const sentAt = this.now();
        const result = await this.service.page({ action: 'agent.send', repoPath: target.repo, worktreePath: target.path, prompt }, signal);
        return this.waitIfAsked(request, result, sentAt, signal);
    }

    private now(): number {
        return (this.service.now ?? Date.now)();
    }

    /**
     * With "wait", waits until the agent that got the prompt finishes its turn. The agent can stay idle for a few seconds
     * after the prompt, so the wait counts only the state changes after `sentAt`.
     */
    private async waitIfAsked(request: CliRequest, result: CliPageResult, sentAt: number, signal: AbortSignal): Promise<CliResult> {
        if (request.args.wait !== true || !result.sessionId) return { ...result };
        const waited = await waitForAgent({
            sessions: () => this.service.sessions(),
            worktree: result.worktreePath ?? '',
            sessionId: result.sessionId,
            after: sentAt,
            timeoutMs: waitTimeoutMs(request.args.timeout),
            signal,
            now: () => this.now()
        });
        return {
            ...result,
            message: `${result.message} ${waited.title} is ${waited.state}.${waited.message ? ` ${waited.message}` : ''}`,
            state: waited.state,
            ...(waited.message ? { agentMessage: waited.message } : {})
        };
    }

    private async getTask(request: CliRequest, signal: AbortSignal): Promise<CliResult> {
        const target = await this.target(request);
        const data = toolData(await this.service.tools.call('get_task', {}, { worktree: target.path, signal }));
        const task = (data.task ?? {}) as { key?: string; title?: string; status?: string; url?: string; description?: string };
        const lines = [`${task.key ? `${task.key}: ` : ''}${task.title ?? ''}`, `Status: ${task.status ?? 'unknown'}`];
        if (task.url) lines.push(task.url);
        if (task.description) lines.push('', task.description);
        return { message: lines.join('\n'), ...data };
    }

    private async runAutomation(request: CliRequest, signal: AbortSignal): Promise<CliResult> {
        const id = requiredText(
            request.args,
            'automation',
            'Give the automation, for example: shipwarden automation run nightly-review. Run "shipwarden automation list" to get the IDs.'
        );
        const automation = (await this.service.automations()).find(item => item.id === id || item.name === id);
        if (!automation) throw new CliError('notFound', `No automation has the ID or name "${id}". Run "shipwarden automation list".`);
        const list = await this.service.worktrees();
        let worktree: McpWorktree | undefined;
        switch (manualTarget(automation.trigger)) {
            case 'task':
                throw new CliError('badRequest', `"${automation.name}" runs on a task. Run it from the Tasks view of ShipWarden.`);
            case 'worktree':
                worktree = await this.target(request, list);
                break;
            case 'none':
                // A schedule runs on the repository of the automation, not on a worktree.
                break;
        }
        const key = worktree?.path ?? automation.binding.repos?.[0] ?? worktreeAt(list, request.cwd)?.path ?? this.service.home;
        await this.approve(key, 'cli_automation_run', `Run the automation "${automation.name}"${worktree ? ` on "${worktree.name}"` : ''}`, signal);
        const result = await this.service.page(
            { action: 'automation.run', automationId: automation.id, repoPath: worktree?.repo, worktreePath: worktree?.path },
            signal
        );
        return { ...result, automation: automation.id };
    }
}
