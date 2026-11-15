import { useCallback, useMemo } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { findOverlaps, type WorktreeFiles, type WorktreeOverlap } from '@shared/worktree-overlap';
import { SUMMARIES_POLL_MS } from '../github/use-branch-status';
import { keyRoots, queryClient } from '../query-client';
import { onGitChanged } from './git-store';

/**
 * The time between two loads of the changed files of a repository. It is the interval of the branch summaries, so the
 * overlap loads in the same cycle. Each load runs local git only. The main process keeps the files of the commits of a
 * branch in a cache, so git reads them again only after a new commit.
 */
export const OVERLAP_POLL_MS = SUMMARIES_POLL_MS;

/** The query key of the changed files of the worktrees of a repository. */
export function worktreeFilesKey(repo: string) {
    return [...keyRoots.worktreeFiles, repo] as const;
}

/** The query of the changed files of the worktrees of a repository. */
export function worktreeFilesQuery(repo: string) {
    return {
        queryKey: worktreeFilesKey(repo),
        queryFn: () => window.shipwarden.git.worktreeFiles(repo),
        staleTime: OVERLAP_POLL_MS,
        refetchInterval: OVERLAP_POLL_MS
    };
}

// A stage, a commit or a new fetch can change the files. The views that show the overlap load it again.
onGitChanged(() => void queryClient.invalidateQueries({ queryKey: keyRoots.worktreeFiles }));

/** The overlaps of each repository, by repository and then by worktree path. */
export type OverlapsByRepo = Record<string, Record<string, WorktreeOverlap>>;

/** Returns the overlaps of each repository from the query results. A repository without loaded data is not in the result. */
export function overlapsByRepo(repos: readonly string[], results: readonly Pick<UseQueryResult<WorktreeFiles[]>, 'data'>[]): OverlapsByRepo {
    const map: OverlapsByRepo = {};
    repos.forEach((repo, index) => {
        const data = results[index]?.data;
        if (data) map[repo] = findOverlaps(data);
    });
    return map;
}

/** Loads the changed files of the worktrees of each repository, and returns the overlaps. With `enabled` false, nothing loads. */
export function useOverlaps(repos: readonly string[], enabled = true): OverlapsByRepo {
    const key = repos.join('\0');
    const list = useMemo(() => (key ? key.split('\0') : []), [key]);
    const combine = useCallback((results: UseQueryResult<WorktreeFiles[]>[]) => overlapsByRepo(list, results), [list]);
    return useQueries({ queries: list.map(repo => ({ ...worktreeFilesQuery(repo), enabled })), combine });
}

/** Returns the overlap of one worktree, or undefined when it has none. */
export function useWorktreeOverlap(repo: string | undefined, worktree: string | undefined): WorktreeOverlap | undefined {
    const overlaps = useOverlaps(repo ? [repo] : []);
    return repo && worktree ? overlaps[repo]?.[worktree] : undefined;
}
