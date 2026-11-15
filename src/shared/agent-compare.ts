import { cleanBranchName, kebabCase } from './branch-template';
import { pluralize } from './format';

/**
 * Agent comparisons: one task runs with 2 to 4 agents at the same time. Each agent works in its own worktree on its
 * own branch. The user compares the results and keeps one worktree.
 *
 * The functions of this module use no Electron API and no browser API. The main process and the page both use them.
 */

/** The fewest agents of a comparison. */
export const MIN_COMPARE_AGENTS = 2;
/** The most agents of a comparison. Each agent uses its own worktree and its own plan usage. */
export const MAX_COMPARE_AGENTS = 4;
/** The most comparisons that the file keeps. The comparisons with the oldest change go first. */
export const MAX_COMPARE_GROUPS = 200;

/** One agent of a comparison and its worktree. */
export interface CompareRun {
    /** The ID of the agent in Settings › Agents. */
    agentId: string;
    /** The name of the agent when the run started, for example "Codex". */
    agentName: string;
    branch: string;
    worktreePath: string;
}

/** The task of a comparison. The fields are a copy from the time when the comparison started. */
export interface CompareTask {
    connectionId: string;
    pluginId: string;
    taskId: string;
    key?: string;
    title: string;
}

export interface CompareGroup {
    id: string;
    /** The main worktree of the repository of all runs. */
    repoPath: string;
    task: CompareTask;
    runs: CompareRun[];
    /** The worktree of the run that the user keeps. Undefined until the user selects one. */
    keptPath?: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * The state of one run in the compare list.
 * - active: the worktree exists, and the user did not select a run yet.
 * - kept: the user keeps this run.
 * - other: the user keeps another run, and this worktree still exists.
 * - removed: the worktree does not exist.
 */
export type CompareRunState = 'active' | 'kept' | 'other' | 'removed';

/** Returns a new ID for a comparison. */
export function newCompareId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Returns a new comparison. */
export function newCompareGroup(repoPath: string, task: CompareTask, runs: CompareRun[], now: number): CompareGroup {
    return { id: newCompareId(), repoPath, task, runs, createdAt: now, updatedAt: now };
}

/** Returns an error text when the number of agents is not valid, else undefined. */
export function agentCountError(count: number): string | undefined {
    if (count < MIN_COMPARE_AGENTS) return `Select at least ${MIN_COMPARE_AGENTS} agents.`;
    if (count > MAX_COMPARE_AGENTS) return `Select at most ${MAX_COMPARE_AGENTS} agents.`;
    return undefined;
}

/**
 * Returns the branch of each agent: the task branch with the agent at the end, for example "ENG-12-fix-login-codex".
 * The end part comes from the agent ID, else from the agent name. Two agents with the same end part get a number.
 */
export function compareBranches(base: string, agents: readonly { id: string; name: string }[]): string[] {
    const used = new Set<string>();
    return agents.map(agent => {
        const suffix = kebabCase(agent.id) || kebabCase(agent.name) || 'agent';
        let branch = cleanBranchName(`${base}-${suffix}`);
        for (let number = 2; used.has(branch); number++) {
            branch = cleanBranchName(`${base}-${suffix}-${number}`);
        }
        used.add(branch);
        return branch;
    });
}

/** Returns the state of a run. `existing` has the paths of the worktrees that exist now. */
export function compareRunState(group: Pick<CompareGroup, 'keptPath'>, run: Pick<CompareRun, 'worktreePath'>, existing: ReadonlySet<string>): CompareRunState {
    if (group.keptPath === run.worktreePath) return 'kept';
    if (!existing.has(run.worktreePath)) return 'removed';
    return group.keptPath ? 'other' : 'active';
}

/** Returns the comparison with the run of `worktreePath` as the kept run. Throws when the comparison has no such run. */
export function withKeptRun(group: CompareGroup, worktreePath: string, now: number): CompareGroup {
    if (!group.runs.some(run => run.worktreePath === worktreePath)) throw new Error('The comparison has no run in this worktree.');
    return { ...group, keptPath: worktreePath, updatedAt: now };
}

/** Returns the runs that the user can remove after a keep: the other runs with a worktree that exists. */
export function runsToRemove(group: CompareGroup, existing: ReadonlySet<string>): CompareRun[] {
    if (!group.keptPath) return [];
    return group.runs.filter(run => compareRunState(group, run, existing) === 'other');
}

/** Returns the text of the dialog that asks before ShipWarden removes the worktrees of the other runs. */
export function removeRunsDialog(runs: readonly CompareRun[], hasTeardown: boolean): { title: string; message: string; confirmLabel: string } {
    const list = runs.map(run => `${run.agentName} (${run.branch})`).join(', ');
    const teardown = hasTeardown ? ' The teardown script of the repository runs first for each worktree.' : '';
    return {
        title: `Remove the ${runs.length === 1 ? 'worktree' : pluralize(runs.length, 'worktree')} of the other ${runs.length === 1 ? 'agent' : 'agents'}?`,
        message: `ShipWarden removes the worktrees of ${list}. Git keeps the branches. Uncommitted changes stop the removal of a worktree. The terminals and the processes of these worktrees stop.${teardown}`,
        confirmLabel: runs.length === 1 ? 'Remove worktree' : 'Remove worktrees'
    };
}

/** Returns the comparisons of a task, the newest first. */
export function groupsOfTask(groups: readonly CompareGroup[], connectionId: string, taskId: string): CompareGroup[] {
    return groups.filter(group => group.task.connectionId === connectionId && group.task.taskId === taskId).sort((a, b) => b.createdAt - a.createdAt);
}

/** Returns the list with the comparison. A comparison with the same ID is replaced. The newest change comes first. */
export function withGroup(groups: readonly CompareGroup[], group: CompareGroup): CompareGroup[] {
    return [group, ...groups.filter(item => item.id !== group.id)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_COMPARE_GROUPS);
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max: number): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function time(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function runOf(value: unknown): CompareRun | undefined {
    const raw = record(value);
    const agentId = text(raw.agentId, 200);
    const branch = text(raw.branch, 500);
    const worktreePath = text(raw.worktreePath, 4096);
    if (!agentId || !branch || !worktreePath) return undefined;
    return { agentId, agentName: text(raw.agentName, 200) ?? agentId, branch, worktreePath };
}

function taskOf(value: unknown): CompareTask | undefined {
    const raw = record(value);
    const connectionId = text(raw.connectionId, 200);
    const pluginId = text(raw.pluginId, 200);
    const taskId = text(raw.taskId, 500);
    if (!connectionId || !pluginId || !taskId) return undefined;
    const key = text(raw.key, 200);
    return { connectionId, pluginId, taskId, ...(key ? { key } : {}), title: text(raw.title, 500) ?? taskId };
}

/** Returns a valid comparison, or undefined when the value has no ID, no repository, no task, or no runs. */
export function normalizeCompareGroup(value: unknown): CompareGroup | undefined {
    const raw = record(value);
    const id = text(raw.id, 100);
    const repoPath = text(raw.repoPath, 4096);
    const task = taskOf(raw.task);
    const runs = (Array.isArray(raw.runs) ? raw.runs : [])
        .map(runOf)
        .filter((run): run is CompareRun => !!run)
        .filter((run, index, list) => list.findIndex(item => item.worktreePath === run.worktreePath) === index)
        .slice(0, MAX_COMPARE_AGENTS);
    if (!id || !repoPath || !task || runs.length === 0) return undefined;
    const now = Date.now();
    const group: CompareGroup = { id, repoPath, task, runs, createdAt: time(raw.createdAt) ?? now, updatedAt: time(raw.updatedAt) ?? now };
    const keptPath = text(raw.keptPath, 4096);
    if (keptPath && runs.some(run => run.worktreePath === keptPath)) group.keptPath = keptPath;
    return group;
}
