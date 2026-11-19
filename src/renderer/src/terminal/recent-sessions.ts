import { useQuery } from '@tanstack/react-query';
import type { RecentSession } from '@shared/recent-sessions';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden;

/**
 * The query of the recent Claude Code sessions. The main process reads the transcripts on this Mac, so a load sends no
 * request to a service. The list loads again each minute and when the Agents view opens after that time.
 */
export function recentSessionsQuery() {
    return { queryKey: keyRoots.recentSessions, queryFn: () => api.recentSessions.list(), staleTime: 60_000, refetchInterval: 60_000 };
}

/** The recent sessions, the newest first. The list includes the pinned sessions and the running sessions. */
export function useRecentSessions(): RecentSession[] {
    return useQuery(recentSessionsQuery()).data ?? [];
}

/** Moves a resumed session to the top of the cache, so that the list is in order without a new load. */
export function markRecentSessionResumed(sessionId: string, cwd: string, branch: string | undefined): void {
    queryClient.setQueryData<RecentSession[]>(keyRoots.recentSessions, list => {
        const session = list?.find(item => item.sessionId === sessionId);
        if (!list || !session) return list;
        return [{ ...session, cwd, branch, updatedAt: Date.now() }, ...list.filter(item => item !== session)];
    });
}
