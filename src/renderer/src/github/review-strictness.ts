import { useQuery } from '@tanstack/react-query';
import { repoId, type RepoRef } from '@shared/github';
import type { ReviewStrictness } from '@shared/review-strictness';
import { reviewStrictnessForRepo } from '@shared/settings';

/**
 * Returns the default strictness of an agent review of the repositories: the value of the local clone of each
 * repository, else the global value. When the repositories have different values, the global value applies.
 */
export async function defaultReviewStrictness(repos: readonly RepoRef[]): Promise<ReviewStrictness> {
    const settings = await window.shipwarden.settings.get();
    const roots = await Promise.all(repos.map(repo => window.shipwarden.projects.findRepo(repo).catch(() => null)));
    const levels = new Set(roots.map(root => reviewStrictnessForRepo(settings, root)));
    return levels.size === 1 ? [...levels][0] : settings.reviewStrictness;
}

/**
 * The default strictness of an agent review of the repositories. Undefined while it loads. It loads again each time a
 * page with it opens, so a change on the settings page applies.
 */
export function useDefaultReviewStrictness(repos: readonly RepoRef[]): ReviewStrictness | undefined {
    const { data } = useQuery({
        queryKey: ['reviewStrictness', ...repos.map(repoId)],
        queryFn: () => defaultReviewStrictness(repos),
        staleTime: 0
    });
    return data;
}
