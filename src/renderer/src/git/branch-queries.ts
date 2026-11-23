import { useQuery } from '@tanstack/react-query';
import type { BranchDetails } from '@shared/branches';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden;

/** The query key of the branch list of a repository. */
export function branchDetailsKey(repo: string) {
    return [...keyRoots.repoBranches, repo] as const;
}

/**
 * The local and remote branches of a repository. The first load does not fetch the remotes, so it is fast. A refresh
 * fetches the remotes with `fetchBranches`.
 */
export function useBranchDetails(repo: string) {
    return useQuery<BranchDetails>({
        queryKey: branchDetailsKey(repo),
        queryFn: () => api.worktrees.branchDetails(repo),
        staleTime: Number.POSITIVE_INFINITY,
        refetchInterval: false
    });
}

/** Fetches all remotes of the repository, and writes the new branch list into the cache. */
export async function fetchBranches(repo: string): Promise<BranchDetails> {
    const details = await api.worktrees.branchDetails(repo, true);
    queryClient.setQueryData(branchDetailsKey(repo), details);
    return details;
}

/** Writes a changed branch list into the cache. Nothing loads again. */
export function updateBranchDetails(repo: string, update: (details: BranchDetails) => BranchDetails): void {
    queryClient.setQueryData<BranchDetails>(branchDetailsKey(repo), details => (details ? update(details) : details));
}

/** Writes a new branch list into the cache. */
export function setBranchDetails(repo: string, details: BranchDetails): void {
    queryClient.setQueryData(branchDetailsKey(repo), details);
}
