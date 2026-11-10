import type { CheckRun, PullRequest } from '@shared/github';
import type { CheckCounts } from './use-check-counts';

/** Returns the failed checks for the CI banner. Only an open pull request shows them. */
export function bannerChecks(pr: PullRequest | null, checks: CheckCounts | undefined): CheckRun[] {
    return pr?.state === 'OPEN' ? checks?.failedChecks ?? [] : [];
}

/** The title of the CI banner, for example "2 checks failed.". */
export function failedChecksTitle(count: number): string {
    return count === 1 ? '1 check failed.' : `${count} checks failed.`;
}

/** The names of the failed checks, in one line. */
export function failedCheckNames(checks: CheckRun[]): string {
    return checks.map(check => check.name).join(', ');
}
