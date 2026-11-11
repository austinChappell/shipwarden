import { branchMatches, manualTarget, needsRepo, taskRepo, type Automation, type AutomationEvent } from '@shared/automations';
import { manualScheduleEvent, manualTaskEvent, manualWorktreeEvent } from '@shared/automation-events';
import type { Task } from '@shared/tasks';
import { showContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { branchSummariesQuery } from '../github/use-branch-status';
import { queryClient } from '../query-client';
import { loadCollectionTasks, type EnginePlace } from './engine';

const api = window.shipwarden;

/** The menu shows at most this number of tasks for each collection. */
const MAX_TASKS = 40;

/** The event of a manual run, and the worktree of the event. */
export interface ManualRun {
    event: AutomationEvent;
    place?: EnginePlace;
}

/**
 * Asks the user for the target of a manual run in a menu under `anchor`: a worktree for a pull request or agent
 * trigger, a task for a "Task matches" trigger. A schedule needs no target. Returns undefined when the user closes the menu.
 * Throws an error with a message when there is nothing to select.
 */
export async function pickManualRun(
    automation: Automation,
    repos: readonly string[],
    repoLabel: (repo: string) => string,
    anchor: Element
): Promise<ManualRun | undefined> {
    switch (manualTarget(automation.trigger)) {
        case 'worktree':
            return pickWorktree(automation, repos, repoLabel, anchor);
        case 'task':
            return pickTask(automation, anchor);
        case 'none':
            return { event: manualScheduleEvent(automation.id, automation.binding.repos?.[0], Date.now(), automation.trigger.type) };
    }
}

async function pickWorktree(
    automation: Automation,
    repos: readonly string[],
    repoLabel: (repo: string) => string,
    anchor: Element
): Promise<ManualRun | undefined> {
    const bound = automation.binding.repos?.length ? automation.binding.repos : repos;
    const pattern = automation.conditions?.branchPattern;
    const lists = await Promise.all(
        bound.map(async repo => {
            const worktrees = await api.worktrees.list(repo).catch(() => []);
            return { repo, places: worktrees.filter(item => !item.isMain && branchMatches(pattern, item.branch)).map(worktree => ({ repo, worktree })) };
        })
    );
    const groups = lists.filter(group => group.places.length > 0);
    if (groups.length === 0) {
        throw new Error(pattern ? `No worktree has a branch that matches "${pattern}".` : 'No worktree to run the automation on. Make a worktree first.');
    }
    const places = new Map<string, EnginePlace>(groups.flatMap(group => group.places.map(place => [place.worktree.path, place] as const)));
    const item = (place: EnginePlace): ContextMenuItem => ({ id: place.worktree.path, label: place.worktree.branch ?? place.worktree.path });
    const items: ContextMenuItem[] =
        groups.length === 1 ? groups[0].places.map(item) : groups.map(group => ({ label: repoLabel(group.repo), submenu: group.places.map(item) }));
    const choice = await showContextMenu(items, anchor);
    const place = choice ? places.get(choice) : undefined;
    if (!place) return undefined;
    // The summaries of a repository load one time each minute. The cache usually has them.
    const summaries = await queryClient.fetchQuery(branchSummariesQuery(place.repo)).catch(() => undefined);
    const summary = place.worktree.branch ? summaries?.[place.worktree.branch] : undefined;
    const trigger = automation.trigger;
    if (trigger.type === 'manual' && trigger.entity === 'pullRequest' && !summary) {
        throw new Error(`${place.worktree.branch ?? place.worktree.path} has no open pull request.`);
    }
    return { event: manualWorktreeEvent(automation.id, trigger.type, place, summary, Date.now()), place };
}

async function pickTask(automation: Automation, anchor: Element): Promise<ManualRun | undefined> {
    const { connectionId, collections } = automation.binding;
    if (automation.trigger.type === 'manual') throw new Error('Open a task, and click the button of the automation in its details.');
    if (!connectionId || !collections?.length) throw new Error('The automation has no task collection. Select one in the editor.');
    const lists = await Promise.all(
        collections.map(async collection => {
            const { source, tasks } = await loadCollectionTasks(connectionId, collection.id);
            // A finished task needs no agent.
            const open = tasks.filter(task => task.status.category !== 'done' && task.status.category !== 'canceled').slice(0, MAX_TASKS);
            return { collection, pluginId: source.pluginId, tasks: open };
        })
    );
    const groups = lists.filter(group => group.tasks.length > 0);
    if (groups.length === 0) throw new Error('The collections of the automation have no open tasks.');
    const found = new Map<string, { task: Task; pluginId: string }>();
    const item = (group: (typeof groups)[number], task: Task): ContextMenuItem => {
        const id = `${group.collection.id}\0${task.id}`;
        found.set(id, { task, pluginId: group.pluginId });
        return { id, label: task.key ? `${task.key} ${task.title}` : task.title };
    };
    const items: ContextMenuItem[] =
        groups.length === 1
            ? groups[0].tasks.map(task => item(groups[0], task))
            : groups.map(group => ({ label: group.collection.name ?? group.collection.id, submenu: group.tasks.map(task => item(group, task)) }));
    const choice = await showContextMenu(items, anchor);
    const picked = choice ? found.get(choice) : undefined;
    if (!picked) return undefined;
    const repoPath = taskRepo(automation.binding, picked.task);
    if (needsRepo(automation) && !repoPath) throw new Error('The task has no repository. Select a repository in the editor.');
    return { event: manualTaskEvent(automation.id, picked.task, connectionId, picked.pluginId, repoPath, Date.now()) };
}
