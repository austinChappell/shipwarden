import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EMPTY_RUN_STATE, firedKey, type Automation, type AutomationList, type AutomationRun, type AutomationRunState } from '@shared/automations';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden.automations;

/** The query keys of the automations. The data is local: the files in ~/.shipwarden/automations and the run file. */
export const automationKeys = {
    list: [...keyRoots.automations, 'list'] as const,
    runs: [...keyRoots.automations, 'runs'] as const
};

/** The query of the automation files. The data changes only when a file changes, and the main process tells the page. */
export const automationListQuery = {
    queryKey: automationKeys.list,
    queryFn: () => api.list(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false as const
};

/** The query of the run history. The engine is the only writer, and it patches the cache after each change. */
export const automationRunsQuery = {
    queryKey: automationKeys.runs,
    queryFn: () => api.runs(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false as const
};

const EMPTY_LIST: AutomationList = { folder: '', automations: [], problems: [] };

/**
 * The automations, and the files that ShipWarden could not read. A change in the folder (also from another app) loads
 * the files again. This reads local files only.
 */
export function useAutomationList(): { list: AutomationList; loaded: boolean } {
    useEffect(() => api.onChanged(() => void queryClient.invalidateQueries({ queryKey: automationKeys.list })), []);
    const query = useQuery(automationListQuery);
    return { list: query.data ?? EMPTY_LIST, loaded: query.isSuccess };
}

/** The run history, newest first. */
export function useAutomationRuns(): { state: AutomationRunState; loaded: boolean } {
    const query = useQuery(automationRunsQuery);
    return { state: query.data ?? EMPTY_RUN_STATE, loaded: query.isSuccess };
}

/** Saves an automation and puts the saved copy in the cache, so the list shows it at once. */
export async function saveAutomation(automation: Automation, previousId?: string): Promise<Automation> {
    const saved = await api.save(automation, previousId);
    queryClient.setQueryData<AutomationList>(automationKeys.list, list => {
        const current = list ?? EMPTY_LIST;
        const others = current.automations.filter(item => item.id !== saved.id && item.id !== previousId);
        const automations = [...others, saved].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return { ...current, automations };
    });
    return saved;
}

/** Moves the file of an automation to the Trash and removes it from the cache. */
export async function removeAutomation(id: string): Promise<void> {
    await api.remove(id);
    queryClient.setQueryData<AutomationList>(automationKeys.list, list => list && { ...list, automations: list.automations.filter(item => item.id !== id) });
}

/** Returns the run state from the cache. */
export function cachedRunState(): AutomationRunState {
    return queryClient.getQueryData<AutomationRunState>(automationKeys.runs) ?? EMPTY_RUN_STATE;
}

/** Puts a new run first in the cached history, and records its fired key. */
export function addRunToCache(run: AutomationRun): void {
    queryClient.setQueryData<AutomationRunState>(automationKeys.runs, state => {
        const current = state ?? EMPTY_RUN_STATE;
        return {
            ...current,
            runs: [run, ...current.runs.filter(item => item.id !== run.id)],
            fired: { ...current.fired, [firedKey(run.automationId, run.event)]: run.createdAt }
        };
    });
}

/** Replaces a run in the cached history. */
export function replaceRunInCache(run: AutomationRun): void {
    queryClient.setQueryData<AutomationRunState>(
        automationKeys.runs,
        state => state && { ...state, runs: state.runs.map(item => (item.id === run.id ? run : item)) }
    );
}

/** Changes the cached run state with a function. */
export function patchRunState(change: (state: AutomationRunState) => AutomationRunState): void {
    queryClient.setQueryData<AutomationRunState>(automationKeys.runs, state => change(state ?? EMPTY_RUN_STATE));
}
