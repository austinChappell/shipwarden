import { useMutation, useQuery } from '@tanstack/react-query';
import { worktreePortOwners, type PortOwner } from '@shared/processes';
import { keyRoots, queryClient } from './query-client';

/** The time between two scans of the ports. A scan runs ps and lsof one time for all worktrees. */
const POLL_MS = 5000;

type PortsByPath = Record<string, PortOwner[]>;

const EMPTY: PortsByPath = {};

/**
 * The listening ports of each worktree, by worktree path. A worktree without ports has no entry.
 * One scan gets the ports of all worktrees. The scan stops when the window is hidden.
 */
export function useWorktreePorts(worktreePaths: string[]): PortsByPath {
    const paths = [...new Set(worktreePaths)].sort();
    const query = useQuery({
        queryKey: [...keyRoots.worktreePorts, paths],
        queryFn: async () => {
            const groups = await window.shipwarden.processes.list(paths);
            const result: PortsByPath = {};
            for (const group of groups) {
                const owners = worktreePortOwners(group);
                if (owners.length) result[group.worktreePath] = owners;
            }
            return result;
        },
        enabled: paths.length > 0,
        staleTime: POLL_MS,
        refetchInterval: POLL_MS,
        placeholderData: previous => previous
    });
    return query.data ?? EMPTY;
}

/**
 * Stops the process that has a port, and its child processes.
 * After the stop, the cache loses the ports of the process. The next scan finds the ports that are still open.
 */
export function useStopPortProcess() {
    return useMutation({
        mutationFn: ({ worktreePath, pid }: { worktreePath: string; pid: number }) => window.shipwarden.processes.stop(worktreePath, pid),
        onSuccess: (_result, { worktreePath, pid }) => {
            queryClient.setQueriesData<PortsByPath>({ queryKey: keyRoots.worktreePorts }, data => {
                if (!data?.[worktreePath]) return data;
                const rest = data[worktreePath].filter(owner => owner.pid !== pid);
                const next = { ...data };
                if (rest.length) next[worktreePath] = rest;
                else delete next[worktreePath];
                return next;
            });
        }
    });
}
