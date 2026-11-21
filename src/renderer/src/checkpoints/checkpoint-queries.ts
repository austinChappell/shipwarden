import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Checkpoint } from '@shared/checkpoints';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden;

/** The query key of the checkpoints of a worktree. */
export function checkpointsKey(worktree: string) {
    return [...keyRoots.checkpoints, worktree] as const;
}

/**
 * The checkpoints of a worktree, the newest first. The data is local. A new checkpoint marks only the list of its
 * worktree as stale, because the page cannot know the new list.
 */
export function useCheckpoints(worktree: string) {
    useEffect(
        () =>
            api.checkpoints.onChanged(changed => {
                if (changed === worktree) void queryClient.invalidateQueries({ queryKey: checkpointsKey(worktree) });
            }),
        [worktree]
    );
    return useQuery<Checkpoint[]>({
        queryKey: checkpointsKey(worktree),
        queryFn: () => api.checkpoints.list(worktree),
        staleTime: Number.POSITIVE_INFINITY,
        refetchInterval: false
    });
}

/** Marks the checkpoint list of a worktree as stale, for example after a rewind added a "Before a rewind" checkpoint. */
export function checkpointsChanged(worktree: string): Promise<void> {
    return queryClient.invalidateQueries({ queryKey: checkpointsKey(worktree) });
}
