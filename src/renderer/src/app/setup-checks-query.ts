import { useCallback, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { replaceCheckResult, type SetupCheckId, type SetupCheckResult } from '@shared/setup-checks';
import { keyRoots } from '../query-client';

/** The query key of the setup check results. */
export const setupChecksKey = [...keyRoots.setup, 'checks'];

/**
 * The checks that wait for a new result. A fix button that leaves the welcome page (for example "Open Settings › Code
 * review") adds its check here. The welcome page checks them again when it shows again.
 */
const pending = new Set<SetupCheckId>();

/** Marks a check to check again when the welcome page shows again. */
export function markCheckPending(id: SetupCheckId): void {
    pending.add(id);
}

/** Returns and clears the checks that wait for a new result. */
export function takePendingChecks(): SetupCheckId[] {
    const ids = [...pending];
    pending.clear();
    return ids;
}

/** Puts a new result of one check in the cache. It does nothing before the first load, so the first load still runs. */
export function patchSetupCheck(queryClient: QueryClient, result: SetupCheckResult): void {
    queryClient.setQueryData<SetupCheckResult[]>(setupChecksKey, list => (list ? replaceCheckResult(list, result) : list));
}

/**
 * The setup check results. They load one time, when the welcome page first shows. They do not load again on a timer
 * or on focus. `recheck` runs one check and updates only its entry. `recheckAll` runs all checks, for "Check again".
 */
export function useSetupChecks() {
    const queryClient = useQueryClient();
    const query = useQuery({
        queryKey: setupChecksKey,
        queryFn: () => window.shipwarden.setup.check(),
        staleTime: Number.POSITIVE_INFINITY,
        refetchInterval: false,
        refetchOnWindowFocus: false
    });
    /** The checks that run now because of `recheck`. */
    const [checking, setChecking] = useState<ReadonlySet<SetupCheckId>>(new Set());
    const recheck = useCallback(
        async (id: SetupCheckId) => {
            setChecking(current => new Set(current).add(id));
            try {
                const [result] = await window.shipwarden.setup.check(id);
                if (result) patchSetupCheck(queryClient, result);
            } finally {
                setChecking(current => {
                    const next = new Set(current);
                    next.delete(id);
                    return next;
                });
            }
        },
        [queryClient]
    );
    return {
        checks: query.data,
        error: query.error,
        loading: query.isFetching,
        checking,
        recheck,
        recheckAll: () => void query.refetch()
    };
}
