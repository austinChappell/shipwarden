import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PromptTemplate, PromptTemplateList } from '@shared/prompt-templates';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden.prompts;

/** The query of the prompt template files. The data changes only when a file changes, and the main process tells the page. */
export const promptListQuery = {
    queryKey: [...keyRoots.prompts, 'list'] as const,
    queryFn: () => api.list(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false as const
};

const EMPTY_LIST: PromptTemplateList = { folder: '', templates: [], problems: [] };

function byName(a: PromptTemplate, b: PromptTemplate): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * The prompt templates, and the files that ShipWarden could not read. A change in the folder (also from another app)
 * loads the files again. This reads local files only.
 */
export function usePromptTemplates(): { list: PromptTemplateList; loaded: boolean } {
    useEffect(() => api.onChanged(() => void queryClient.invalidateQueries({ queryKey: promptListQuery.queryKey })), []);
    const query = useQuery(promptListQuery);
    return { list: query.data ?? EMPTY_LIST, loaded: query.isSuccess };
}

/** Returns the templates from the cache, or loads them one time. */
export async function loadPromptTemplates(): Promise<PromptTemplate[]> {
    return (await queryClient.fetchQuery(promptListQuery)).templates;
}

/** Saves a template and puts the saved copy in the cache, so the lists show it at once. */
export async function savePromptTemplate(template: PromptTemplate, previousId?: string): Promise<PromptTemplate> {
    const saved = await api.save(template, previousId);
    queryClient.setQueryData<PromptTemplateList>(promptListQuery.queryKey, list => {
        const current = list ?? EMPTY_LIST;
        const others = current.templates.filter(item => item.id !== saved.id && item.id !== previousId);
        return { ...current, templates: [...others, saved].sort(byName) };
    });
    return saved;
}

/** Moves the file of a template to the Trash and removes it from the cache. */
export async function removePromptTemplate(id: string): Promise<void> {
    await api.remove(id);
    queryClient.setQueryData<PromptTemplateList>(
        promptListQuery.queryKey,
        list => list && { ...list, templates: list.templates.filter(item => item.id !== id) }
    );
}
