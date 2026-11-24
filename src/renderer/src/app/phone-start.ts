import type { AgentMode } from '@shared/agent-modes';
import type { CliPageRequest, CliPageResult } from '@shared/cli';
import { openTaskChoices } from '@shared/remote';
import { taskPrompt, type Task } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import type { CreatedWorktree, Worktree } from '@shared/worktrees';
import { loadCollectionTasks } from '../automations/engine';
import { taskManagerKeys } from '../components/task-managers-cache';
import { keyRoots, queryClient } from '../query-client';
import { errorText } from '../util';
import { taskLinksKey } from './task-links';

const api = window.shipwarden;

/** The functions of the app that a start from the phone uses. They are the start code of "Start in worktree". */
export interface PhoneStartActions {
    promptAgent(worktree: Pick<Worktree, 'path'>, prompt: string, target?: { sessionId?: string }): Promise<TerminalSession>;
    startTaskQuietly(
        task: Task,
        connectionId: string,
        pluginId: string,
        repoPath: string,
        prompt: (branch: string) => string,
        agentId?: string,
        mode?: AgentMode,
        model?: string,
        branchName?: string
    ): Promise<{ worktree: CreatedWorktree; session: TerminalSession }>;
    startInNewWorktree(
        repoPath: string,
        branch: string,
        prompt: string,
        agentId?: string,
        mode?: AgentMode,
        model?: string
    ): Promise<{ worktree: CreatedWorktree; session: TerminalSession }>;
}

const connectionsQuery = { queryKey: taskManagerKeys.allConnections, queryFn: () => api.tasks.connections() };

/**
 * The tasks for the start screen of the phone. The list comes from the cache of the Tasks view. It loads only when the
 * cache has no fresh copy, so an open of the start screen usually sends no request to the task manager.
 */
export async function phoneTasks(): Promise<CliPageResult> {
    const connections = (await queryClient.fetchQuery(connectionsQuery)).filter(item => item.enabled && item.configured);
    if (connections.length === 0) {
        return { message: '', tasks: [], tasksNote: 'Connect a task manager in ShipWarden › Settings › Task managers on the Mac.' };
    }
    const selected = await api.tasks.selectedConnection();
    const connection = connections.find(item => item.id === selected) ?? connections[0];
    const collection = await api.tasks.selectedCollection(connection.id);
    if (!collection) {
        return { message: '', tasks: [], tasksNote: `Select a list of ${connection.name} in the Tasks view on the Mac.` };
    }
    const [{ tasks }, links] = await Promise.all([
        loadCollectionTasks(connection.id, collection),
        queryClient.fetchQuery({ queryKey: taskLinksKey, queryFn: () => api.tasks.links(), staleTime: Number.POSITIVE_INFINITY })
    ]);
    const choices = openTaskChoices(connection.id, tasks, links);
    return { message: '', tasks: choices, ...(choices.length === 0 ? { tasksNote: `The selected list of ${connection.name} has no open tasks.` } : {}) };
}

/** The task from a cached list of the connection, else from the task manager. */
async function findTask(connectionId: string, taskId: string): Promise<Task> {
    for (const [, list] of queryClient.getQueriesData<Task[]>({ queryKey: [...keyRoots.tasks, 'list', connectionId] })) {
        const task = list?.find(item => item.id === taskId);
        if (task) return task;
    }
    return (await api.tasks.request(connectionId, 'tasks/get', { id: taskId })) as Task;
}

/**
 * Starts an agent for the phone with the start code of "Start in worktree". The answer comes when the agent session
 * runs. The prompt goes to the agent after that, so the phone can show the agent at once. When the new agent asks a
 * question (for example about folder trust), the user can answer it on the phone, and then the prompt goes in.
 * `latest` gives the functions of the newest render, because the prompt needs the session list with the new session.
 */
export async function phoneStart(request: Extract<CliPageRequest, { action: 'phone.start' }>, latest: () => PhoneStartActions): Promise<CliPageResult> {
    let started: { worktree: CreatedWorktree; session: TerminalSession };
    let prompt = request.prompt ?? '';
    if (request.task) {
        const { connectionId, id } = request.task;
        const connection = (await queryClient.fetchQuery(connectionsQuery)).find(item => item.id === connectionId);
        if (!connection) throw new Error('The task manager of the task is not in Settings › Task managers anymore.');
        const task = await findTask(connectionId, id);
        started = await latest().startTaskQuietly(
            task,
            connectionId,
            connection.pluginId,
            request.repoPath,
            branch => {
                prompt = taskPrompt(task, branch);
                return '';
            },
            request.agentId,
            undefined,
            request.model,
            request.branch
        );
    } else {
        const branch = request.branch ?? request.promptBranch;
        if (!branch) throw new Error('The start has no branch.');
        started = await latest().startInNewWorktree(request.repoPath, branch, '', request.agentId, undefined, request.model);
    }
    const { worktree, session } = started;
    if (prompt) {
        void latest()
            .promptAgent(worktree, prompt, { sessionId: session.id })
            .catch(error => console.warn(`[phone] The prompt did not reach ${session.title}: ${errorText(error)}`));
    }
    return {
        message: `Started ${session.title} in ${worktree.path}.`,
        worktreePath: worktree.path,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        sessionId: session.id,
        agent: session.title
    };
}
