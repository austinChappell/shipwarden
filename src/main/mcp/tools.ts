import type { McpToolName, McpWriteTool } from '@shared/mcp';
import type { Task, TaskComment, TaskLink, TaskSource, TaskStatus } from '@shared/tasks';
import type { WorktreeOverlap } from '@shared/worktree-overlap';
import type { ToolContext, ToolDefinition, ToolHost, ToolResult } from './protocol';

/** A worktree in the result of list_worktrees. */
export interface McpWorktree {
    path: string;
    /** The branch. Undefined for a detached HEAD. */
    branch?: string;
    /** The display name: the name from the user, else the branch, else the folder name. */
    name: string;
    /** The main worktree of the repository. */
    repo: string;
    isMain: boolean;
    task?: { title: string; key?: string; url?: string };
    pullRequest?: { number: number; title?: string; url: string; isDraft: boolean; reviewDecision: string | null; checks: string | null };
    /** The agent tabs of the worktree that run now. */
    agents: { title: string; state?: string; message?: string }[];
}

/** The task of a worktree and the plugin of its connection. */
export interface LinkedTask {
    connectionId: string;
    link: TaskLink;
    capabilities: TaskSource['capabilities'];
}

/**
 * The parts of ShipWarden that the tools use. The main process gives the real services. The tests give a fake.
 * `caller` is always the worktree of the token.
 */
export interface McpToolService {
    /** The worktrees of the repository of the caller. With `all`, the worktrees of all projects. */
    worktrees(caller: string, all: boolean): Promise<McpWorktree[]>;
    /** The overlap of the caller with the other worktrees of its repository. Undefined when it has none. */
    overlap(caller: string): Promise<WorktreeOverlap | undefined>;
    /** Asks the agent of the repository of `target` a question in print mode, in the target worktree. */
    ask(target: string, prompt: string, options: { timeoutMs: number; signal: AbortSignal }): Promise<{ agent: string; answer: string }>;
    /** The task link of the caller, or undefined when the worktree has no task. */
    linkedTask(caller: string): Promise<LinkedTask | undefined>;
    /** Sends a protocol request to the plugin of a task connection. */
    taskRequest<T>(connectionId: string, method: string, params: unknown): Promise<T>;
    /** Tells the page that a task changed, so it can patch its cached copies. */
    taskChanged(connectionId: string, taskId: string, patch: Partial<Task>): void;
    /**
     * Waits for the approval of a write tool in a worktree. Resolves at once when the user approved the tool for the
     * worktree before. Rejects when the user denies it, or when no answer comes in time.
     */
    approve(caller: string, tool: McpWriteTool, summary: string, signal: AbortSignal): Promise<void>;
}

/** The time that ask_agent waits for an answer when the call does not say. */
export const DEFAULT_ASK_TIMEOUT_S = 300;
/** The longest time that ask_agent waits. */
export const MAX_ASK_TIMEOUT_S = 900;
/** The most comments that get_task returns. These are the newest comments. */
export const MAX_COMMENTS = 50;

/** An error that the agent sees as the text of a failed tool call. */
export class ToolError extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
    {
        name: 'list_worktrees',
        title: 'List worktrees',
        description:
            'Lists the git worktrees of the repository of this worktree. Each item has the path, the branch, the linked task, the pull request state, and the agents that run in it. Set "all" to true to list the worktrees of all ShipWarden projects.',
        inputSchema: {
            type: 'object',
            properties: { all: { type: 'boolean', description: 'True lists the worktrees of all projects. The default is false.' } },
            additionalProperties: false
        },
        annotations: READ_ONLY
    },
    {
        name: 'get_overlaps',
        title: 'Get overlapping files',
        description:
            'Lists the files that this worktree changes and that other worktrees of the same repository also change. Each peer has its path, its branch, and the shared files. Use it before a large change to find possible merge conflicts.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: READ_ONLY
    },
    {
        name: 'ask_agent',
        title: 'Ask the agent of another worktree',
        description:
            'Sends a question to an agent in a different worktree and waits for the answer. ShipWarden starts the agent of that repository in print mode in the other worktree. That agent can read the files of its worktree. It cannot change files. The first call in a worktree needs the approval of the user.',
        inputSchema: {
            type: 'object',
            properties: {
                worktree: { type: 'string', description: 'The other worktree: its path, its branch, or its name from list_worktrees.' },
                question: { type: 'string', description: 'The question. Give the context that the other agent needs.' },
                timeout_seconds: {
                    type: 'number',
                    description: `The time to wait for the answer, in seconds. The default is ${DEFAULT_ASK_TIMEOUT_S}. The maximum is ${MAX_ASK_TIMEOUT_S}.`
                }
            },
            required: ['worktree', 'question'],
            additionalProperties: false
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    {
        name: 'get_task',
        title: 'Get the task of this worktree',
        description: `Returns the task that is linked to this worktree in ShipWarden, with its status, description, and the newest ${MAX_COMMENTS} comments.`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { ...READ_ONLY, openWorldHint: true }
    },
    {
        name: 'set_task_status',
        title: 'Change the status of the task',
        description:
            'Moves the task of this worktree to a different status. Give the name or the ID of the status. A wrong name gives the list of the statuses of the task. The first call in a worktree needs the approval of the user.',
        inputSchema: {
            type: 'object',
            properties: { status: { type: 'string', description: 'The name or the ID of the new status, for example "In review".' } },
            required: ['status'],
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }
];

/** Returns a text result with the value as JSON, and the value as structured content. */
function jsonResult(value: Record<string, unknown>): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function requiredText(args: Record<string, unknown>, name: string): string {
    const value = args[name];
    if (typeof value !== 'string' || !value.trim()) throw new ToolError(`The argument "${name}" must be a text that is not empty.`);
    return value.trim();
}

/** Returns the timeout of ask_agent in milliseconds. A wrong value gives the default. The value stays in 10 to 900 seconds. */
export function askTimeoutMs(value: unknown): number {
    const seconds = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_ASK_TIMEOUT_S;
    return Math.round(Math.min(MAX_ASK_TIMEOUT_S, Math.max(10, seconds)) * 1000);
}

/** Finds a worktree by its path, its branch, or its name. The path wins, then the branch, then the name. */
export function findWorktree(list: readonly McpWorktree[], wanted: string): McpWorktree | undefined {
    const text = wanted.trim().replace(/\/+$/, '');
    return list.find(item => item.path === text) ?? list.find(item => item.branch === text) ?? list.find(item => item.name === text);
}

/** Returns the prompt for the other agent. */
export function askPromptFor(caller: McpWorktree | undefined, callerPath: string, target: McpWorktree, question: string): string {
    const from = caller ? `"${caller.name}" (${caller.path})` : callerPath;
    return [
        `An agent in the worktree ${from} asks you a question through ShipWarden.`,
        `You run in the worktree "${target.name}" (${target.path}). Read the code and the git state of this worktree if it helps you.`,
        'Do not change files. Write the answer in Markdown.',
        `Question: ${question}`
    ].join('\n\n');
}

/** Returns the task for the agent, without the parts that only the task view needs. */
function taskSummary(task: Task): Record<string, unknown> {
    return {
        id: task.id,
        ...(task.key ? { key: task.key } : {}),
        title: task.title,
        ...(task.url ? { url: task.url } : {}),
        status: task.status.name,
        ...(task.assignees?.length ? { assignees: task.assignees.map(person => person.name) } : {}),
        ...(task.labels?.length ? { labels: task.labels.map(label => label.name) } : {}),
        ...(task.priority ? { priority: task.priority.name } : {}),
        ...(task.description ? { description: task.description } : {}),
        ...(task.details?.parent ? { parent: task.details.parent.key ?? task.details.parent.title ?? task.details.parent.id } : {}),
        ...(task.details?.checklists?.length ? { checklists: task.details.checklists } : {})
    };
}

/** Finds a status by its ID, else by its name. The name ignores case and the spaces at the ends. */
export function matchStatus(statuses: readonly TaskStatus[], wanted: string): TaskStatus | undefined {
    const name = wanted.trim().toLowerCase();
    return statuses.find(status => status.id === wanted) ?? statuses.find(status => status.name.trim().toLowerCase() === name);
}

/** The tools of the ShipWarden MCP server. */
export class McpTools implements ToolHost {
    constructor(private readonly service: McpToolService) {}

    definitions(): ToolDefinition[] {
        return [...TOOL_DEFINITIONS];
    }

    async call(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult | undefined> {
        if (!TOOL_DEFINITIONS.some(tool => tool.name === name)) return undefined;
        try {
            return await this.run(name as McpToolName, args, context);
        } catch (error) {
            return errorResult(error instanceof Error ? error.message : String(error));
        }
    }

    private async run(name: McpToolName, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const { worktree } = context;
        switch (name) {
            case 'list_worktrees': {
                const list = await this.service.worktrees(worktree, args.all === true);
                return jsonResult({ current: worktree, worktrees: list });
            }
            case 'get_overlaps': {
                const overlap = await this.service.overlap(worktree);
                return jsonResult({ worktree, files: overlap?.files ?? [], peers: overlap?.peers ?? [] });
            }
            case 'ask_agent':
                return this.ask(args, context);
            case 'get_task':
                return this.getTask(worktree);
            case 'set_task_status':
                return this.setStatus(args, context);
        }
    }

    private async approve(tool: McpWriteTool, summary: string, context: ToolContext): Promise<void> {
        await this.service.approve(context.worktree, tool, summary, context.signal);
    }

    private async ask(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const wanted = requiredText(args, 'worktree');
        const question = requiredText(args, 'question');
        const list = await this.service.worktrees(context.worktree, true);
        const target = findWorktree(list, wanted);
        if (!target) throw new ToolError(`No worktree has the path, branch, or name "${wanted}". Call list_worktrees to get the worktrees.`);
        if (target.path === context.worktree) throw new ToolError('The worktree is this worktree. Ask the agent of a different worktree.');
        await this.approve('ask_agent', `Ask the agent of "${target.name}": ${question}`, context);
        const caller = list.find(item => item.path === context.worktree);
        const result = await this.service.ask(target.path, askPromptFor(caller, context.worktree, target, question), {
            timeoutMs: askTimeoutMs(args.timeout_seconds),
            signal: context.signal
        });
        return { content: [{ type: 'text', text: result.answer }], structuredContent: { worktree: target.path, agent: result.agent, answer: result.answer } };
    }

    private async linked(worktree: string): Promise<LinkedTask> {
        const linked = await this.service.linkedTask(worktree);
        if (!linked) throw new ToolError('This worktree has no task. Link a task to the worktree in ShipWarden first.');
        return linked;
    }

    private async getTask(worktree: string): Promise<ToolResult> {
        const { connectionId, link, capabilities } = await this.linked(worktree);
        const task = await this.service.taskRequest<Task>(connectionId, 'tasks/get', { id: link.taskId });
        const comments = capabilities.comments ? await this.service.taskRequest<TaskComment[]>(connectionId, 'comments/list', { taskId: link.taskId }) : [];
        return jsonResult({
            task: taskSummary(task),
            comments: (comments ?? []).slice(-MAX_COMMENTS).map(comment => ({
                ...(comment.author ? { author: comment.author.name } : {}),
                ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
                body: comment.body
            }))
        });
    }

    private async setStatus(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const wanted = requiredText(args, 'status');
        const { connectionId, link, capabilities } = await this.linked(context.worktree);
        if (!capabilities.update || !capabilities.statuses) throw new ToolError('The task manager of this task cannot change the status.');
        const statuses = await this.service.taskRequest<TaskStatus[]>(connectionId, 'tasks/statuses', { id: link.taskId });
        const status = matchStatus(statuses ?? [], wanted);
        if (!status) {
            const names = (statuses ?? []).map(item => `"${item.name}"`).join(', ');
            throw new ToolError(`The task has no status "${wanted}". The statuses are: ${names || 'none'}.`);
        }
        await this.approve('set_task_status', `Move "${link.title}" to "${status.name}"`, context);
        const updated = await this.service.taskRequest<Task | undefined>(connectionId, 'tasks/update', { id: link.taskId, status: status.id });
        const newStatus = updated?.status ?? status;
        this.service.taskChanged(connectionId, link.taskId, { status: newStatus });
        return jsonResult({ task: link.key ?? link.title, status: newStatus.name });
    }
}
