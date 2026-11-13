import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { repoId, type GitHubRepoInfo } from '@shared/github';
import { type ComboboxGroup, sortedGroups } from '../components/ui';
import { reviewScopeKey, useReviewProviders } from '../review-providers-store';
import { repositoriesQuery } from './ci-queries';

/**
 * Puts repositories into the groups of a repository picker: one group for each organization or user. The groups and the
 * repositories in each group are in alphabetical order. The value of an item is `repoId`.
 */
export function repoGroups(repos: readonly GitHubRepoInfo[]): ComboboxGroup[] {
    return sortedGroups(
        [...repos],
        item => item.owner,
        item => ({ value: repoId(item), label: item.name })
    );
}

/** The repositories of the review providers that are on, for a repository picker. */
export interface RepoChoices {
    groups: ComboboxGroup[];
    /** True while the providers or the repositories load. */
    loading: boolean;
    /** True when no review provider is on. Then the list is always empty. */
    noProvider: boolean;
    error: unknown;
}

/** Returns the repositories of the GitHub and Azure DevOps providers that are on. The Pipelines view uses the same query. */
export function useRepoChoices(): RepoChoices {
    const reviewKey = reviewScopeKey(useReviewProviders());
    const query = useQuery({ ...repositoriesQuery(reviewKey ?? null), enabled: !!reviewKey });
    const groups = useMemo(() => repoGroups(query.data ?? []), [query.data]);
    return {
        groups,
        loading: reviewKey === undefined || (!!reviewKey && query.isPending),
        noProvider: reviewKey === null,
        error: query.error
    };
}
