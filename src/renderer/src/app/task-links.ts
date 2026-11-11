import { useQuery, type QueryClient } from '@tanstack/react-query';
import { linkMatchesTask, type Task, type TaskLink } from '@shared/tasks';
import { keyRoots } from '../query-client';
import { withoutKey } from './tabs';

/** The query key of the task links of all worktrees. */
export const taskLinksKey = [...keyRoots.tasks, 'links'];

/** The task links with the link of one worktree. Null removes the link. */
export function withTaskLink(links: Record<string, TaskLink>, worktreePath: string, link: TaskLink | null): Record<string, TaskLink> {
    return link ? { ...links, [worktreePath]: link } : withoutKey(links, worktreePath);
}

/** The link of a task, for one worktree. */
export function taskLinkOf(task: Pick<Task, 'id' | 'key' | 'title' | 'url'>, connectionId: string, pluginId: string): TaskLink {
    return { connectionId, pluginId, taskId: task.id, key: task.key, title: task.title, url: task.url };
}

/**
 * The worktrees other than `worktreePath` that have a link to the task of `link`. A task has one worktree, so a new
 * link removes these links.
 */
export function otherWorktreesOfTask(links: Record<string, TaskLink>, link: TaskLink, worktreePath: string): string[] {
    const connectionId = link.connectionId ?? link.pluginId;
    const task = { id: link.taskId, url: link.url };
    return Object.entries(links)
        .filter(([path, other]) => path !== worktreePath && linkMatchesTask(other, connectionId, task))
        .map(([path]) => path);
}

const NO_LINKS: Record<string, TaskLink> = {};

/**
 * The task of each worktree, by worktree path. Only this page changes the links, and `saveTaskLink` puts each change
 * in the cache. Thus the links load one time and do not become stale.
 */
export function useTaskLinks(): Record<string, TaskLink> {
    return (
        useQuery({
            queryKey: taskLinksKey,
            queryFn: () => window.shipwarden.tasks.links(),
            staleTime: Number.POSITIVE_INFINITY,
            refetchInterval: false
        }).data ?? NO_LINKS
    );
}

/**
 * Saves or removes (with null) the task link of a worktree, then puts the change in the cache. When the links did not
 * load yet, the load can give the old links, so the links load again.
 */
export async function saveTaskLink(client: QueryClient, worktreePath: string, link: TaskLink | null): Promise<void> {
    await window.shipwarden.tasks.setLink(worktreePath, link);
    if (client.getQueryData(taskLinksKey)) {
        client.setQueryData<Record<string, TaskLink>>(taskLinksKey, links => links && withTaskLink(links, worktreePath, link));
    } else {
        await client.invalidateQueries({ queryKey: taskLinksKey });
    }
}

/**
 * Links a worktree to a task. The link replaces the old task link of the worktree. The task loses its links to other
 * worktrees, so the task has one worktree.
 */
export async function linkWorktreeToTask(client: QueryClient, links: Record<string, TaskLink>, worktreePath: string, link: TaskLink): Promise<void> {
    for (const other of otherWorktreesOfTask(links, link, worktreePath)) {
        await saveTaskLink(client, other, null);
    }
    await saveTaskLink(client, worktreePath, link);
}
