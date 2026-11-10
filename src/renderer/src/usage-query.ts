import { useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ProviderUsage } from '@shared/usage';
import { keyRoots, queryClient } from './query-client';

/**
 * The plan usage of the agent providers. The main process loads the usage and sends each change, so the query
 * does not load again on a timer. The change goes into the cache without a new request.
 */
export function useUsage() {
    useEffect(() => window.shipwarden.usage.onChanged(usage => queryClient.setQueryData(keyRoots.usage, usage)), []);
    const query = useQuery({
        queryKey: keyRoots.usage,
        queryFn: () => window.shipwarden.usage.get(),
        staleTime: Number.POSITIVE_INFINITY,
        refetchInterval: false
    });
    return query.data ?? EMPTY;
}

const EMPTY: ProviderUsage[] = [];

/** Loads the usage again from the providers and puts the result into the cache. */
export function useRefreshUsage() {
    return useMutation({
        mutationFn: () => window.shipwarden.usage.refresh(),
        onSuccess: usage => queryClient.setQueryData(keyRoots.usage, usage)
    });
}
