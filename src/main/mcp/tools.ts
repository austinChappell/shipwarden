import type { BranchStatus, CheckRun, NewPullRequest, PullRequest, PullRequestChange, ReviewThread } from '@shared/github';
import { WATCH_EVENTS, type AgentPullRequestChange, type McpToolName, type McpWatch, type McpWriteTool } from '@shared/mcp';
import type { Task, TaskComment, TaskLink, TaskSource, TaskStatus } from '@shared/tasks';
import type { WorktreeOverlap } from '@shared/worktree-overlap';
import { MAX_PAGE_ELEMENTS, type ElementTarget, type PageRead } from '@shared/agent-page';
import type { ToolContext, ToolDefinition, ToolHost, ToolResult } from './protocol';
import { watchEventsOf } from './watches';

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

/** The pull request calls of the tools. They go to the review provider of the worktree, so they work on all code hosts. */
export interface McpPullRequests {
    /** The branch of the worktree and its pull request. Null when the worktree has no remote of a review provider. */
    status(worktree: string): Promise<BranchStatus | null>;
    /** Creates a pull request from the branch of the worktree. Returns its number. */
    create(worktree: string, request: NewPullRequest): Promise<number>;
    change(worktree: string, number: number, change: PullRequestChange): Promise<void>;
    /** Adds a reply to the review thread of the comment. `commentId` is the REST ID of a comment in the thread. */
    reply(worktree: string, number: number, commentId: number, body: string): Promise<void>;
    checks(worktree: string, sha: string): Promise<CheckRun[]>;
    /** Saves the log of a GitHub Actions job in a file. Returns the path of the file. */
    saveJobLog(worktree: string, jobId: number): Promise<string>;
    /** Tells the page about a change, so it can patch its cached copies. */
    changed(change: AgentPullRequestChange): void;
}

/** The state of the browser tab after a browser tool. */
export interface McpPage {
    url: string;
    title: string;
    /** True when the page did not stop loading in time. */
    loading?: boolean;
    /** The error of a load that failed. */
    error?: string;
}

/** The browser tools on the browser tab of a worktree. */
export interface McpBrowser {
    open(worktree: string, url: string, signal: AbortSignal): Promise<McpPage>;
    read(worktree: string, selector?: string): Promise<PageRead>;
    /** `note` tells the agent when the image is not of the tab itself. */
    screenshot(worktree: string): Promise<{ png: Buffer; page: McpPage; note?: string }>;
    click(worktree: string, target: ElementTarget, signal: AbortSignal): Promise<{ element: string; page: McpPage }>;
    type(
        worktree: string,
        target: ElementTarget,
        text: string,
        options: { clear: boolean; submit: boolean },
        signal: AbortSignal
    ): Promise<{ element: string; page: McpPage }>;
}

/** The agent that calls a tool: its worktree, and its terminal session when ShipWarden knows it. */
export interface ToolCaller {
    worktree: string;
    sessionId?: string;
}

/** The arguments of start_worker. */
export interface WorkerInput {
    task: string;
    title?: string;
    repository?: string;
    branch?: string;
    base?: string;
    agent?: string;
    model?: string;
}

/** The arguments of report_result. */
export interface ReportInput {
    summary: string;
    failed: boolean;
    pullRequestUrl?: string;
}

/** The coordinator runs: the workers that agents start, and their results. */
export interface McpWorkers {
    /** Checks a start: the depth limit, the repository, the agent, the usage budget, and the queue limit. */
    prepare(caller: ToolCaller, input: WorkerInput): Promise<{ summary: string }>;
    /** Starts a checked worker. `prepared` is the value of `prepare`. */
    launch(prepared: { summary: string }, signal: AbortSignal): Promise<Record<string, unknown>>;
    list(caller: string): Promise<Record<string, unknown>>;
    wait(caller: string, workerId: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<Record<string, unknown>>;
    report(caller: string, input: ReportInput): Promise<Record<string, unknown>>;
}

/** The watches of watch_pull_request. */
export interface McpWatchStore {
    add(watch: Omit<McpWatch, 'id' | 'createdAt'>): Promise<McpWatch>;
    remove(match: (watch: McpWatch) => boolean): Promise<McpWatch[]>;
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
    pullRequests: McpPullRequests;
    browser: McpBrowser;
    watches: McpWatchStore;
    workers: McpWorkers;
}

/** The time that ask_agent waits for an answer when the call does not say. */
export const DEFAULT_ASK_TIMEOUT_S = 300;
/** The longest time that ask_agent waits. */
export const MAX_ASK_TIMEOUT_S = 900;
/** The most comments that get_task returns. These are the newest comments. */
export const MAX_COMMENTS = 50;

/** The time that wait_for_worker waits when the call does not say. */
export const DEFAULT_WORKER_WAIT_S = 300;
/** The longest time that wait_for_worker waits. */
export const MAX_WORKER_WAIT_S = 900;

/** The most failed jobs that get_checks saves a log for. */
export const MAX_CHECK_LOGS = 5;
/** The most characters of a text in an approval summary. */
const MAX_SUMMARY_TEXT = 200;

/** An error that the agent sees as the text of a failed tool call. */
export class ToolError extends Error {}

/** The properties that select an element of the page, for click and type. */
const ELEMENT_PROPERTIES = {
    ref: { type: 'number', description: 'The "ref" of the element from read_page.' },
    selector: { type: 'string', description: 'A CSS selector of the element.' },
    element: { type: 'string', description: 'The visible text, the label, or the placeholder of the element.' }
};

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
    },
    {
        name: 'get_pull_request',
        title: 'Get the pull request of this worktree',
        description:
            'Returns the open or newest pull request of the branch of this worktree: its state, the merge state, the review decision, the description, the reviews, the comments, and the review threads. Each comment in a thread has an "id" for reply_to_comment. Resolved threads are not in the result unless "include_resolved" is true.',
        inputSchema: {
            type: 'object',
            properties: { include_resolved: { type: 'boolean', description: 'True also returns the resolved threads. The default is false.' } },
            additionalProperties: false
        },
        annotations: { ...READ_ONLY, openWorldHint: true }
    },
    {
        name: 'get_checks',
        title: 'Get the checks of the pull request',
        description: `Returns the CI checks of the head commit of this worktree: the pull request head, or the local HEAD when the branch has no pull request. Set "include_logs" to true to save the logs of up to ${MAX_CHECK_LOGS} failed GitHub Actions jobs in files. The result then gives the path of each log file.`,
        inputSchema: {
            type: 'object',
            properties: { include_logs: { type: 'boolean', description: 'True saves the logs of the failed GitHub Actions jobs. The default is false.' } },
            additionalProperties: false
        },
        annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true }
    },
    {
        name: 'create_pull_request',
        title: 'Create a pull request',
        description:
            'Creates a pull request from the branch of this worktree. Push the branch first. The first call in a worktree needs the approval of the user.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'The title of the pull request.' },
                body: { type: 'string', description: 'The description in Markdown. The default is empty.' },
                base: { type: 'string', description: 'The branch to merge into. The default is the default branch of the repository.' },
                draft: { type: 'boolean', description: 'True makes a draft pull request. The default is false.' }
            },
            required: ['title'],
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    {
        name: 'update_pull_request',
        title: 'Change the pull request',
        description:
            'Changes the open pull request of this worktree: the title, the description, the draft state, the base branch, or the state (open or closed). Give only the values to change. The first call in a worktree needs the approval of the user.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'The new title.' },
                body: { type: 'string', description: 'The new description in Markdown. It replaces the full description.' },
                draft: { type: 'boolean', description: 'True makes the pull request a draft. False marks it as ready for review.' },
                base: { type: 'string', description: 'The new branch to merge into.' },
                state: { type: 'string', enum: ['open', 'closed'], description: '"closed" closes the pull request. "open" opens a closed pull request again.' }
            },
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
        name: 'reply_to_comment',
        title: 'Reply to a review comment',
        description:
            'Adds a reply to the review thread of a comment on a line of code in the pull request of this worktree. Get the comment IDs from get_pull_request. The first call in a worktree needs the approval of the user.',
        inputSchema: {
            type: 'object',
            properties: {
                comment_id: { type: 'number', description: 'The "id" of a comment in the thread, from get_pull_request.' },
                body: { type: 'string', description: 'The reply in Markdown.' }
            },
            required: ['comment_id', 'body'],
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    {
        name: 'watch_pull_request',
        title: 'Watch the pull request',
        description:
            'Tells ShipWarden to send a message to this agent session when an event occurs on the open pull request of this worktree: a check fails ("ci.failed"), a merge conflict occurs ("pr.conflict"), or a person adds a comment or a review ("pr.comment"). The message comes as a new prompt. The watch ends when the pull request is merged or closed, when this agent tab closes, or when you call the tool with "stop" set to true. ShipWarden must be open to send the messages.',
        inputSchema: {
            type: 'object',
            properties: {
                events: {
                    type: 'array',
                    items: { type: 'string', enum: [...WATCH_EVENTS] },
                    description: 'The events to watch. The default is all events.'
                },
                stop: { type: 'boolean', description: 'True ends the watch.' }
            },
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
        name: 'open_page',
        title: 'Open a page in the browser',
        description:
            'Opens an http or https address in the browser tab of this worktree in ShipWarden. Without a tab, ShipWarden opens a new tab. The user sees the same tab. Waits until the page loads. The first call in a worktree needs the approval of the user.',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'The address, for example "http://localhost:3000".' } },
            required: ['url'],
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    {
        name: 'read_page',
        title: 'Read the page in the browser',
        description: `Returns the address, the title, and the visible text of the page in the browser tab of this worktree, with up to ${MAX_PAGE_ELEMENTS} links, buttons, and fields. Each element has a "ref" for click and type. A ref stays valid until the page changes.`,
        inputSchema: {
            type: 'object',
            properties: { selector: { type: 'string', description: 'A CSS selector. Only the text and the elements in the first match come back.' } },
            additionalProperties: false
        },
        annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true }
    },
    {
        name: 'screenshot',
        title: 'Take a screenshot of the page',
        description: 'Returns a PNG image of the visible part of the page in the browser tab of this worktree.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true }
    },
    {
        name: 'click',
        title: 'Click an element in the browser',
        description:
            'Clicks an element of the page in the browser tab of this worktree. Give one of "ref" (from read_page), "selector", or "element" (the visible text of a link or a button). The first call in a worktree needs the approval of the user.',
        inputSchema: {
            type: 'object',
            properties: ELEMENT_PROPERTIES,
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    {
        name: 'type',
        title: 'Type in the browser',
        description:
            'Types text into a field of the page in the browser tab of this worktree. Give the field with one of "ref" (from read_page), "selector", or "element" (its label or placeholder). For a select, the text is the value or the label of the option. The first call in a worktree needs the approval of the user.',
        inputSchema: {
            type: 'object',
            properties: {
                ...ELEMENT_PROPERTIES,
                text: { type: 'string', description: 'The text to type.' },
                clear: { type: 'boolean', description: 'True replaces the current value. False adds the text at the end. The default is true.' },
                submit: { type: 'boolean', description: 'True submits the form of the field after the text, or presses Enter. The default is false.' }
            },
            required: ['text'],
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    {
        name: 'start_worker',
        title: 'Start a worker agent',
        description:
            'Starts a worker agent for a part of a large task. ShipWarden makes a new git worktree and branch for the worker and gives it the task. The worker opens a pull request and sends its result with report_result. ShipWarden then sends you a message. It also sends a message when the worker stops or waits for 10 minutes. Give each worker a task that it can do alone, with all the context that it needs. The usage budget, the queue limit, and the worker depth limit of ShipWarden apply. The first call in a worktree needs the approval of the user.',
        inputSchema: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'The full task of the worker in Markdown. The worker sees only this text and the code.' },
                title: { type: 'string', description: 'A short title for the lists in ShipWarden. The default is the first line of the task.' },
                repository: {
                    type: 'string',
                    description: 'The path or the name of the repository of the worker. The default is the repository of this worktree.'
                },
                branch: { type: 'string', description: 'The name of the new branch. The default is "worker/<title>-<id>".' },
                base: { type: 'string', description: 'The branch or commit that the new branch starts from. The default is the newest default branch.' },
                agent: { type: 'string', description: 'The ID or the name of an agent in ShipWarden. The default is the agent of the repository.' },
                model: { type: 'string', description: 'The model of the worker, for example "sonnet". The default is the model of the agent.' }
            },
            required: ['task'],
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    {
        name: 'list_workers',
        title: 'List the workers',
        description:
            'Lists the workers that this agent started with start_worker. Each worker has its worker_id, its title, its status (starting, working, needs_attention, done, or failed), its branch, its worktree, its pull request, and its report.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { ...READ_ONLY, idempotentHint: false }
    },
    {
        name: 'wait_for_worker',
        title: 'Wait for a worker',
        description: `Waits until a worker of this agent finishes, stops, or needs attention, and returns it. Without "worker_id", it returns the next worker that has news. A worker that this call returns does not also send a message. The default wait is ${DEFAULT_WORKER_WAIT_S} seconds. The maximum is ${MAX_WORKER_WAIT_S}.`,
        inputSchema: {
            type: 'object',
            properties: {
                worker_id: { type: 'string', description: 'The worker_id from start_worker or list_workers. The default is any worker.' },
                timeout_seconds: { type: 'number', description: `The time to wait, in seconds. The default is ${DEFAULT_WORKER_WAIT_S}.` }
            },
            additionalProperties: false
        },
        annotations: { ...READ_ONLY, idempotentHint: false }
    },
    {
        name: 'report_result',
        title: 'Report the result of a worker',
        description:
            'Sends the result of this worker to the coordinator agent that started it. Call it one time when the task is complete, after the push and the pull request. Set "status" to "failed" when you cannot do the task. Only a worker that start_worker started can call this tool.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'The result in Markdown: what you changed, what you did not do, and the open questions.' },
                status: { type: 'string', enum: ['done', 'failed'], description: 'The default is "done".' },
                pull_request_url: { type: 'string', description: 'The address of the pull request. The default is the pull request of the branch.' }
            },
            required: ['summary'],
            additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }
];

/** Returns a text result with the value as JSON, and the value as structured content. */
function jsonResult(value: Record<string, unknown>): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function optionalText(args: Record<string, unknown>, name: string): string | undefined {
    const value = args[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new ToolError(`The argument "${name}" must be a text.`);
    return value.trim() || undefined;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
    const value = args[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new ToolError(`The argument "${name}" must be true or false.`);
    return value;
}

/** The conclusions of a failed check. */
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'error']);

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns the pull request after a change, for the base of the next change. Only the fields of update_pull_request change. */
function appliedChange(pr: PullRequest, change: PullRequestChange): PullRequest {
    switch (change.kind) {
        case 'details':
            return {
                ...pr,
                ...(change.title !== undefined ? { title: change.title } : {}),
                ...(change.body !== undefined ? { body: change.body } : {}),
                ...(change.state ? { state: change.state === 'closed' ? 'CLOSED' : 'OPEN' } : {})
            };
        case 'draft':
            return { ...pr, isDraft: change.draft };
        case 'base':
            return { ...pr, baseRefName: change.base };
        default:
            return pr;
    }
}

/** Returns the text cut to the length of an approval summary. */
function clip(text: string, max = MAX_SUMMARY_TEXT): string {
    const value = text.replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Returns the element of click or type. Exactly one of "ref", "selector", and "element" must be in the arguments. */
export function elementTarget(args: Record<string, unknown>): ElementTarget {
    const given = ['ref', 'selector', 'element'].filter(name => args[name] !== undefined);
    if (given.length !== 1) throw new ToolError('Give exactly one of "ref", "selector", and "element".');
    if (args.ref !== undefined) {
        if (typeof args.ref !== 'number' || !Number.isInteger(args.ref)) throw new ToolError('The argument "ref" must be a number from read_page.');
        return { ref: args.ref };
    }
    if (args.selector !== undefined) return { selector: requiredText(args, 'selector') };
    return { text: requiredText(args, 'element') };
}

function targetText(target: ElementTarget): string {
    if (target.ref !== undefined) return `the element with ref ${target.ref}`;
    if (target.selector) return `"${clip(target.selector)}"`;
    return `the element "${clip(target.text ?? '')}"`;
}

/** Returns the pull request for the agent, without the parts that only the views need. */
export function pullRequestSummary(pr: PullRequest, includeResolved: boolean): Record<string, unknown> {
    const login = (user: { login: string } | null) => user?.login ?? 'unknown';
    const threads = pr.threads.filter(thread => includeResolved || !thread.isResolved);
    return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        isDraft: pr.isDraft,
        base: pr.baseRefName,
        head: pr.headRefName,
        headSha: pr.headRefOid,
        mergeable: pr.mergeable,
        mergeState: pr.mergeStateStatus,
        reviewDecision: pr.reviewDecision,
        body: pr.body,
        reviews: pr.reviews
            .filter(review => review.body || review.state !== 'COMMENTED')
            .map(review => ({
                author: login(review.author),
                state: review.state,
                ...(review.body ? { body: review.body } : {}),
                ...(review.submittedAt ? { submittedAt: review.submittedAt } : {})
            })),
        comments: pr.issueComments.map(comment => ({ author: login(comment.author), body: comment.body, createdAt: comment.createdAt })),
        threads: threads.map(thread => ({
            path: thread.path,
            line: thread.line ?? thread.originalLine,
            ...(thread.isResolved ? { resolved: true } : {}),
            ...(thread.isOutdated ? { outdated: true } : {}),
            comments: thread.comments.map(comment => ({
                id: comment.databaseId,
                author: login(comment.author),
                body: comment.body,
                createdAt: comment.createdAt
            }))
        })),
        ...(threads.length < pr.threads.length ? { resolvedThreads: pr.threads.length - threads.length } : {})
    };
}

/** Returns the thread that contains the comment with the REST ID. */
export function threadOf(pr: PullRequest, commentId: number): ReviewThread | undefined {
    return pr.threads.find(thread => thread.comments.some(comment => comment.databaseId === commentId));
}

/** Returns the changes of update_pull_request, in the order that they apply. */
export function pullRequestChanges(pr: PullRequest, args: Record<string, unknown>): PullRequestChange[] {
    const title = optionalText(args, 'title');
    const body = typeof args.body === 'string' ? args.body : undefined;
    if (args.body !== undefined && body === undefined) throw new ToolError('The argument "body" must be a text.');
    const draft = optionalBoolean(args, 'draft');
    const base = optionalText(args, 'base');
    const state = args.state as 'open' | 'closed' | undefined;
    if (state !== undefined && state !== 'open' && state !== 'closed') throw new ToolError('The argument "state" must be "open" or "closed".');
    const changes: PullRequestChange[] = [];
    const details = {
        ...(title !== undefined && title !== pr.title ? { title } : {}),
        ...(body !== undefined && body !== pr.body ? { body } : {}),
        ...(state !== undefined && state !== (pr.state === 'OPEN' ? 'open' : 'closed') ? { state } : {})
    };
    if (Object.keys(details).length > 0) changes.push({ kind: 'details', ...details });
    if (draft !== undefined && draft !== pr.isDraft) changes.push({ kind: 'draft', pullRequestId: pr.id, draft });
    if (base !== undefined && base !== pr.baseRefName) changes.push({ kind: 'base', base });
    return changes;
}

/** Returns the text of a change for the approval summary and the result. */
function changeText(change: PullRequestChange): string {
    switch (change.kind) {
        case 'details':
            return [
                ...(change.title !== undefined ? [`title "${clip(change.title)}"`] : []),
                ...(change.body !== undefined ? ['description'] : []),
                ...(change.state ? [change.state === 'closed' ? 'close' : 'open again'] : [])
            ].join(', ');
        case 'draft':
            return change.draft ? 'make a draft' : 'mark as ready for review';
        case 'base':
            return `base ${change.base}`;
        default:
            return change.kind;
    }
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

/** Returns the wait of wait_for_worker in milliseconds. A wrong value gives the default. The value stays in 10 to 900 seconds. */
export function workerWaitMs(value: unknown): number {
    const seconds = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_WORKER_WAIT_S;
    return Math.round(Math.min(MAX_WORKER_WAIT_S, Math.max(10, seconds)) * 1000);
}

/** Returns the checked arguments of start_worker. */
export function workerInput(args: Record<string, unknown>): WorkerInput {
    const input: WorkerInput = { task: requiredText(args, 'task') };
    for (const name of ['title', 'repository', 'branch', 'base', 'agent', 'model'] as const) {
        const value = optionalText(args, name);
        if (value) input[name] = value;
    }
    return input;
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
            case 'get_pull_request':
                return this.getPullRequest(args, worktree);
            case 'get_checks':
                return this.getChecks(args, worktree);
            case 'create_pull_request':
                return this.createPullRequest(args, context);
            case 'update_pull_request':
                return this.updatePullRequest(args, context);
            case 'reply_to_comment':
                return this.reply(args, context);
            case 'watch_pull_request':
                return this.watch(args, context);
            case 'open_page': {
                const url = requiredText(args, 'url');
                await this.approve('open_page', `Open ${url}`, context);
                return jsonResult({ ...(await this.service.browser.open(worktree, url, context.signal)) });
            }
            case 'read_page': {
                const selector = optionalText(args, 'selector');
                return jsonResult({ ...(await this.service.browser.read(worktree, selector)) });
            }
            case 'screenshot': {
                const { png, page, note } = await this.service.browser.screenshot(worktree);
                const text = [`${page.title || 'Untitled'} (${page.url})`, ...(note ? [note] : [])].join('\n\n');
                return {
                    content: [
                        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
                        { type: 'text', text }
                    ]
                };
            }
            case 'click': {
                const target = elementTarget(args);
                await this.approve('click', `Click ${targetText(target)}`, context);
                const { element, page } = await this.service.browser.click(worktree, target, context.signal);
                return jsonResult({ clicked: element, page });
            }
            case 'start_worker': {
                const prepared = await this.service.workers.prepare(
                    { worktree, ...(context.sessionId ? { sessionId: context.sessionId } : {}) },
                    workerInput(args)
                );
                await this.approve('start_worker', prepared.summary, context);
                return jsonResult(await this.service.workers.launch(prepared, context.signal));
            }
            case 'list_workers':
                return jsonResult(await this.service.workers.list(worktree));
            case 'wait_for_worker': {
                const workerId = optionalText(args, 'worker_id');
                return jsonResult(await this.service.workers.wait(worktree, workerId, workerWaitMs(args.timeout_seconds), context.signal));
            }
            case 'report_result': {
                const summary = requiredText(args, 'summary');
                const status = args.status ?? 'done';
                if (status !== 'done' && status !== 'failed') throw new ToolError('The argument "status" must be "done" or "failed".');
                const pullRequestUrl = optionalText(args, 'pull_request_url');
                return jsonResult(
                    await this.service.workers.report(worktree, { summary, failed: status === 'failed', ...(pullRequestUrl ? { pullRequestUrl } : {}) })
                );
            }
            case 'type': {
                const target = elementTarget(args);
                const text = typeof args.text === 'string' ? args.text : '';
                if (typeof args.text !== 'string') throw new ToolError('The argument "text" must be a text.');
                await this.approve('type', `Type "${clip(text)}" into ${targetText(target)}`, context);
                const options = { clear: args.clear !== false, submit: args.submit === true };
                const { element, page } = await this.service.browser.type(worktree, target, text, options, context.signal);
                return jsonResult({ typedInto: element, page });
            }
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

    /** Returns the state of the worktree branch. Fails when the worktree has no remote of a review provider. */
    private async branchStatus(worktree: string): Promise<BranchStatus> {
        const status = await this.service.pullRequests.status(worktree);
        if (!status)
            throw new ToolError('The "origin" remote of this worktree is not on a code host of ShipWarden. Add the code host in Settings › Code review.');
        return status;
    }

    /** Returns the open pull request of the worktree branch. */
    private async openPullRequest(worktree: string): Promise<PullRequest> {
        const status = await this.branchStatus(worktree);
        const pr = status.pullRequest;
        if (pr?.state !== 'OPEN') {
            const state = pr ? ` Pull request #${pr.number} is ${pr.state.toLowerCase()}.` : '';
            throw new ToolError(`The branch "${status.branch}" has no open pull request.${state} Call create_pull_request to make one.`);
        }
        return pr as PullRequest;
    }

    private async getPullRequest(args: Record<string, unknown>, worktree: string): Promise<ToolResult> {
        const status = await this.branchStatus(worktree);
        if (!status.pullRequest) {
            return jsonResult({ branch: status.branch, pullRequest: null, ...(status.pushed === false ? { pushed: false } : {}) });
        }
        return jsonResult({ branch: status.branch, pullRequest: pullRequestSummary(status.pullRequest, args.include_resolved === true) });
    }

    private async getChecks(args: Record<string, unknown>, worktree: string): Promise<ToolResult> {
        const status = await this.branchStatus(worktree);
        const checks = await this.service.pullRequests.checks(worktree, status.sha);
        const failed = (check: CheckRun) => check.status === 'completed' && FAILED_CONCLUSIONS.has(check.conclusion ?? '');
        const logs = new Map<number, string>();
        if (args.include_logs === true) {
            for (const check of checks.filter(item => failed(item) && item.isActions).slice(0, MAX_CHECK_LOGS)) {
                logs.set(check.id, await this.service.pullRequests.saveJobLog(worktree, check.id).catch(error => `The log did not load: ${errorText(error)}`));
            }
        }
        const count = (match: (check: CheckRun) => boolean) => checks.filter(match).length;
        return jsonResult({
            sha: status.sha,
            ...(status.pullRequest ? { pullRequest: status.pullRequest.number } : {}),
            summary: {
                total: checks.length,
                failed: count(failed),
                pending: count(check => check.status !== 'completed'),
                passed: count(check => check.status === 'completed' && !failed(check))
            },
            checks: checks.map(check => ({
                id: check.id,
                name: check.name,
                status: check.status,
                conclusion: check.conclusion,
                ...(check.url ? { url: check.url } : {}),
                ...(logs.has(check.id) ? { log: logs.get(check.id) } : {})
            }))
        });
    }

    private async createPullRequest(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const title = requiredText(args, 'title');
        const body = typeof args.body === 'string' ? args.body : '';
        const base = optionalText(args, 'base');
        const draft = args.draft === true;
        const status = await this.branchStatus(context.worktree);
        if (status.pullRequest?.state === 'OPEN') {
            throw new ToolError(
                `The branch "${status.branch}" has the open pull request #${status.pullRequest.number} already. Call update_pull_request to change it.`
            );
        }
        if (status.pushed === false) throw new ToolError(`The remote has no copy of the branch. Push it first: git push -u origin ${status.branch}`);
        await this.approve(
            'create_pull_request',
            `${draft ? 'Create a draft pull request' : 'Create a pull request'} "${clip(title)}" from ${status.branch}${base ? ` into ${base}` : ''}`,
            context
        );
        const number = await this.service.pullRequests.create(context.worktree, { title, body, draft, ...(base ? { base } : {}) });
        // One request gives the address for the agent and the new state for the page.
        const after = await this.service.pullRequests.status(context.worktree).catch(() => null);
        if (after) this.service.pullRequests.changed({ kind: 'created', worktree: context.worktree, status: after });
        const pr = after?.pullRequest?.number === number ? after.pullRequest : undefined;
        return jsonResult({ number, ...(pr ? { url: pr.url, isDraft: pr.isDraft, base: pr.baseRefName } : {}) });
    }

    private async updatePullRequest(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const status = await this.branchStatus(context.worktree);
        const pr = status.pullRequest;
        // A closed pull request can open again, so this tool does not need an open pull request.
        if (!pr || pr.state === 'MERGED') throw new ToolError(`The branch "${status.branch}" has no open pull request. Call create_pull_request to make one.`);
        const changes = pullRequestChanges(pr, args);
        if (changes.length === 0) return jsonResult({ number: pr.number, changed: [] });
        await this.approve('update_pull_request', `Change #${pr.number}: ${changes.map(changeText).join(', ')}`, context);
        let current = pr;
        for (const change of changes) {
            await this.service.pullRequests.change(context.worktree, pr.number, change);
            this.service.pullRequests.changed({ kind: 'changed', pr: current, change });
            current = appliedChange(current, change);
        }
        return jsonResult({ number: pr.number, url: pr.url, changed: changes.map(changeText) });
    }

    private async reply(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const commentId = args.comment_id;
        if (typeof commentId !== 'number' || !Number.isInteger(commentId))
            throw new ToolError('The argument "comment_id" must be the number "id" of a comment.');
        const body = requiredText(args, 'body');
        const pr = await this.openPullRequest(context.worktree);
        const thread = threadOf(pr, commentId);
        if (!thread) {
            throw new ToolError(
                `No review comment of pull request #${pr.number} has the ID ${commentId}. Call get_pull_request to get the IDs. Only comments on lines of code can get a reply.`
            );
        }
        const first = thread.comments[0];
        await this.approve('reply_to_comment', `Reply to ${first?.author?.login ?? 'a comment'} on ${thread.path}: ${clip(body)}`, context);
        await this.service.pullRequests.reply(context.worktree, pr.number, commentId, body);
        this.service.pullRequests.changed({ kind: 'reply', pr, threadId: thread.id, commentId, body });
        return jsonResult({ number: pr.number, path: thread.path, replied: true });
    }

    private async watch(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        const { worktree, sessionId } = context;
        if (!sessionId)
            throw new ToolError('ShipWarden does not know the agent tab of this session. Start the agent from ShipWarden, then call the tool again.');
        const mine = (watch: McpWatch) => watch.sessionId === sessionId && watch.worktree === worktree;
        if (args.stop === true) {
            const removed = await this.service.watches.remove(mine);
            return jsonResult({ watching: false, stopped: removed.length > 0 });
        }
        if (args.events !== undefined && !Array.isArray(args.events)) throw new ToolError('The argument "events" must be a list.');
        const events = watchEventsOf(args.events);
        const pr = await this.openPullRequest(worktree);
        await this.service.watches.add({ worktree, sessionId, number: pr.number, events });
        return jsonResult({
            watching: true,
            number: pr.number,
            events,
            note: 'ShipWarden sends a message to this session for each event. The watch ends when the pull request is merged or closed, or when this agent tab closes. Call watch_pull_request with "stop" set to true to end it.'
        });
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
