import { useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Plan } from '@shared/plans';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden.plans;

/** The query of all plans. Only this page changes the plans, and each save patches the cache. */
export const plansQuery = {
    queryKey: [...keyRoots.plans, 'list'] as const,
    queryFn: () => api.list(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false as const
};

const NO_PLANS: Plan[] = [];

/** The plans of all projects, the newest change first, and whether they loaded. */
export function usePlans(): { plans: Plan[]; loaded: boolean } {
    const query = useQuery(plansQuery);
    return { plans: query.data ?? NO_PLANS, loaded: query.isSuccess };
}

/** The plans of one project, the newest change first. */
export function useProjectPlans(projectId: string | undefined): Plan[] {
    const { plans } = usePlans();
    return useMemo(() => plans.filter(plan => plan.projectId === projectId), [plans, projectId]);
}

/** Returns the cached plan with the ID. */
export function cachedPlan(id: string): Plan | undefined {
    return queryClient.getQueryData<Plan[]>(plansQuery.queryKey)?.find(plan => plan.id === id);
}

/** Returns all cached plans. */
export function cachedPlans(): Plan[] {
    return queryClient.getQueryData<Plan[]>(plansQuery.queryKey) ?? NO_PLANS;
}

function putInCache(plan: Plan): void {
    queryClient.setQueryData<Plan[]>(plansQuery.queryKey, list => [plan, ...(list ?? []).filter(item => item.id !== plan.id)]);
}

/** The saves of each plan, in order. A change starts from the result of the change before it. */
const saving = new Map<string, Promise<unknown>>();

/**
 * Changes a plan and saves it. The cache shows the change at once. The changes of one plan run one after the other,
 * and each change reads the newest copy. Returns the saved plan, or undefined when the plan does not exist.
 */
export function updatePlan(id: string, change: (plan: Plan) => Plan): Promise<Plan | undefined> {
    const previous = saving.get(id) ?? Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(async () => {
            const current = cachedPlan(id);
            if (!current) return undefined;
            const changed = { ...change(current), updatedAt: Date.now() };
            putInCache(changed);
            const saved = await api.save(changed);
            return saved;
        });
    saving.set(id, next);
    void next.finally(() => {
        if (saving.get(id) === next) saving.delete(id);
    });
    return next;
}

/** Saves a new plan and puts it first in the cache. */
export async function createPlan(plan: Plan): Promise<Plan> {
    putInCache(plan);
    return api.save(plan);
}

/** Removes a plan from the file and from the cache. */
export async function removePlan(id: string): Promise<void> {
    await api.remove(id);
    queryClient.setQueryData<Plan[]>(plansQuery.queryKey, list => list?.filter(plan => plan.id !== id));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Explorations                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The state of the exploration of a plan: it runs, or it failed with an error. */
export interface ExploreState {
    running: boolean;
    error?: string;
}

const IDLE: ExploreState = { running: false };
let explorations: ReadonlyMap<string, ExploreState> = new Map();
const listeners = new Set<() => void>();

/** Sets the exploration state of a plan. The view can close and open again while the agent works. */
export function setExploreState(id: string, state: ExploreState): void {
    const next = new Map(explorations);
    if (!state.running && !state.error) next.delete(id);
    else next.set(id, state);
    explorations = next;
    listeners.forEach(listener => listener());
}

/** Returns the exploration state of a plan. */
export function exploreStateOf(id: string): ExploreState {
    return explorations.get(id) ?? IDLE;
}

/** The exploration state of a plan, for a view. */
export function useExploreState(id: string): ExploreState {
    return useSyncExternalStore(
        listener => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => explorations.get(id) ?? IDLE
    );
}
