import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { TaskLink } from '@shared/tasks';
import { keyRoots } from '../query-client';
import { withoutKey } from './tabs';

/** The query key of the task links of all worktrees. */
export const taskLinksKey = [...keyRoots.tasks, 'links'];

/** The task links with the link of one worktree. Null removes the link. */
export function withTaskLink(links: Record<string, TaskLink>, worktreePath: string, link: TaskLink | null): Record<string, TaskLink> {
    return link ? { ...links, [worktreePath]: link } : withoutKey(links, worktreePath);
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
