import { useQuery } from '@tanstack/react-query';
import { latestChecks, type CheckRun, type RepoTarget } from '@shared/github';
import { checksQuery, isFailedConclusion } from './ci-queries';

/** The checks of one commit, by result. */
export interface CheckCounts {
    total: number;
    passed: number;
    failed: number;
    running: number;
    /** The newest run of each check that failed. */
    failedChecks: CheckRun[];
}

/** The time between two loads of the checks while a check runs. */
const POLL_RUNNING_MS = 15_000;

export function countChecks(checks: readonly CheckRun[]): CheckCounts {
    const latest = latestChecks(checks);
    const failedChecks = latest.filter(check => check.status === 'completed' && isFailedConclusion(check.conclusion));
    const failed = failedChecks.length;
    const running = latest.filter(check => check.status !== 'completed').length;
    return { total: latest.length, passed: latest.length - failed - running, failed, running, failedChecks };
}

/**
 * Loads the checks of a commit and counts them. The Checks panel uses the same cached checks.
 * Undefined while the checks load or when they do not load.
 */
export function useCheckCounts(target: RepoTarget, sha: string | undefined): CheckCounts | undefined {
    const query = useQuery({ ...checksQuery(target, sha, POLL_RUNNING_MS), select: countChecks });
    // An error does not show here. The Checks tab shows it.
    return sha ? query.data : undefined;
}
