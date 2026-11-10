import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { BranchStatus, BranchSummary } from '@shared/github';
import { keyRoots } from '../query-client';
import { optionalErrorText } from '../util';

/**
 * The time between two loads of the branch summaries. The summaries give the CI state of the pull requests, and the
 * "CI finished" notifications come from them. Thus they load more frequently than other data.
 */
export const SUMMARIES_POLL_MS = 60_000;

/** The query key of the pull request and CI state of one worktree branch. */
export function branchStatusKey(root: string | undefined) {
    return [...keyRoots.branchStatus, root] as const;
}

/** The query key of the open pull requests of a repository by head branch. */
export function branchSummariesKey(repo: string) {
    return [...keyRoots.branchSummaries, repo] as const;
}

/** The query of the open pull requests of a repository by head branch, with their CI state. One request covers all branches. */
export function branchSummariesQuery(repo: string) {
    return {
        queryKey: branchSummariesKey(repo),
        queryFn: () => window.shipwarden.github.branchSummaries(repo),
        staleTime: SUMMARIES_POLL_MS,
        refetchInterval: SUMMARIES_POLL_MS
    };
}

/** Returns the loaded branch summaries by repository. A repository without loaded summaries is not in the result. */
export function summariesByRepo(
    repos: readonly string[],
    results: readonly Pick<UseQueryResult<Record<string, BranchSummary>>, 'data'>[]
): Record<string, Record<string, BranchSummary>> {
    const map: Record<string, Record<string, BranchSummary>> = {};
    repos.forEach((repo, index) => {
        const data = results[index]?.data;
        if (data) map[repo] = data;
    });
    return map;
}

export interface BranchStatusState {
    status: BranchStatus | null | undefined;
    loading: boolean;
    error?: string;
    refresh(): Promise<void>;
}

/**
 * Loads the GitHub state of a worktree: the branch, its pull request and the commit for checks.
 * It loads only while `active` is true. The cached state shows at once when the worktree opens again.
 * `status` is undefined before the first load and null when the worktree has no GitHub remote.
 */
export function useBranchStatus(root: string | undefined, active: boolean): BranchStatusState {
    const query = useQuery({
        queryKey: branchStatusKey(root),
        queryFn: () => window.shipwarden.github.status(root!),
        enabled: !!root && active
    });

    const refresh = async () => {
        if (root) {
            await query.refetch();
        }
    };

    return { status: query.data, loading: query.isFetching, error: optionalErrorText(query.error), refresh };
}
