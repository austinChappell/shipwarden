import { useQueries, useQuery } from '@tanstack/react-query';
import { withGroup, type CompareGroup } from '@shared/agent-compare';
import type { AgentDefinition } from '@shared/settings';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden;

/** The query of all agent comparisons. The list is local data. A save patches the cache. */
export function compareGroupsQuery() {
    return { queryKey: keyRoots.compare, queryFn: () => api.compare.list(), staleTime: Number.POSITIVE_INFINITY };
}

/** Writes a comparison to the store, and puts the saved copy into the cache. The list does not load again. */
export async function saveCompareGroup(group: CompareGroup): Promise<CompareGroup> {
    const saved = await api.compare.save(group);
    queryClient.setQueryData<CompareGroup[]>(keyRoots.compare, list => withGroup(list ?? [], saved));
    return saved;
}

/** The query key of the branch diff of a worktree. */
export function branchDiffKey(worktree: string) {
    return [...keyRoots.branchDiff, worktree] as const;
}

/** Returns the agents of Settings › Agents with a command in the PATH of the login shell, and true while the checks run. */
export function useInstalledAgents(agents: readonly AgentDefinition[]): { installed: AgentDefinition[]; loading: boolean } {
    return useQueries({
        queries: agents.map(agent => ({
            queryKey: [...keyRoots.agentCheck, agent.command],
            queryFn: () => api.settings.checkCommand(agent.command),
            staleTime: 60_000
        })),
        combine: results => ({
            installed: agents.filter((_agent, index) => !!results[index]?.data?.path),
            loading: results.some(result => result.isPending)
        })
    });
}

/** The agent comparisons of all tasks, the newest change first. */
export function useCompareGroups(): CompareGroup[] {
    return useQuery(compareGroupsQuery()).data ?? [];
}
