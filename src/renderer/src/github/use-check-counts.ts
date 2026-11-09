import { useEffect, useState } from 'react';
import { latestChecks, type CheckRun, type RepoTarget } from '@shared/github';

/** The checks of one commit, by result. */
export interface CheckCounts {
    total: number;
    passed: number;
    failed: number;
    running: number;
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'error']);
const POLL_RUNNING_MS = 15_000;

export function countChecks(checks: readonly CheckRun[]): CheckCounts {
    const latest = latestChecks(checks);
    const failed = latest.filter(check => check.status === 'completed' && FAILED.has(check.conclusion ?? '')).length;
    const running = latest.filter(check => check.status !== 'completed').length;
    return { total: latest.length, passed: latest.length - failed - running, failed, running };
}

/**
 * Loads the checks of a commit and counts them. The hook loads them again when `refresh` changes,
 * and it polls while checks run. Undefined while the checks load or when they do not load.
 */
export function useCheckCounts(target: RepoTarget, sha: string | undefined, refresh: unknown): CheckCounts | undefined {
    const [counts, setCounts] = useState<{ sha: string; counts: CheckCounts }>();

    useEffect(() => {
        if (!sha) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const load = async () => {
            try {
                const result = countChecks(await window.shipwarden.github.checks(target, sha));
                if (stopped) return;
                setCounts({ sha, counts: result });
                if (result.running > 0) timer = setTimeout(load, POLL_RUNNING_MS);
            } catch {
                // The summary shows no counts. The Checks tab shows the error.
            }
        };
        void load();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [target, sha, refresh]);

    return counts && counts.sha === sha ? counts.counts : undefined;
}
