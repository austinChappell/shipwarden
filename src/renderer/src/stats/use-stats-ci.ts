import { useEffect } from 'react';
import type { BranchSummary } from '@shared/github';
import { statsCiChange } from '@shared/stats';
import type { Worktree } from '@shared/worktrees';

const api = window.shipwarden;

/** The last CI line that the page sent for each worktree. The main process also ignores a line that it has already. */
const sent = new Map<string, string>();

/**
 * Sends the CI state of the pull request of each worktree to the agent stats log. It uses the pull request data that the
 * page loaded already, so it sends no request to a service.
 */
export function useStatsCi(worktreesByRepo: Record<string, Worktree[]>, summaries: Record<string, Record<string, BranchSummary>>): void {
    useEffect(() => {
        for (const [repo, worktrees] of Object.entries(worktreesByRepo)) {
            for (const worktree of worktrees) {
                if (worktree.isMain || !worktree.branch) continue;
                const change = statsCiChange(worktree.path, summaries[repo]?.[worktree.branch]);
                if (!change) continue;
                const key = `${change.number}:${change.sha}:${change.ci}`;
                if (sent.get(worktree.path) === key) continue;
                sent.set(worktree.path, key);
                void api.stats.ci(change).catch(() => undefined);
            }
        }
    }, [worktreesByRepo, summaries]);
}
