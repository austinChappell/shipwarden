import { useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReviewPromptInput } from '@shared/agent-review';
import { groupReviewPrompt, parseGroupReview, prKey, type GroupReviewCounts, type PrGroup } from '@shared/pr-groups';
import { keyRoots, queryClient } from '../query-client';
import { errorText } from '../util';
import { pullRequestQuery, reviewStore } from './review-store';

const api = window.shipwarden.prGroups;

/** The query of all groups. Only this module changes the groups, and each save patches the cache. */
export const groupsQuery = {
    queryKey: [...keyRoots.prGroups, 'list'] as const,
    queryFn: () => api.list(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false as const
};

const NO_GROUPS: PrGroup[] = [];

/** All groups, the newest change first, and whether they loaded. */
export function useGroups(): { groups: PrGroup[]; loaded: boolean } {
    const query = useQuery(groupsQuery);
    return { groups: query.data ?? NO_GROUPS, loaded: query.isSuccess };
}

/** The group with the ID, or undefined. */
export function useGroup(id: string | undefined): PrGroup | undefined {
    const { groups } = useGroups();
    return useMemo(() => groups.find(group => group.id === id), [groups, id]);
}

/** Returns all groups. The first call loads them from the file. Then they come from the cache. */
export function loadGroups(): Promise<PrGroup[]> {
    return queryClient.ensureQueryData(groupsQuery);
}

/** Returns the cached group with the ID. */
export function cachedGroup(id: string): PrGroup | undefined {
    return queryClient.getQueryData<PrGroup[]>(groupsQuery.queryKey)?.find(group => group.id === id);
}

function putInCache(group: PrGroup): void {
    queryClient.setQueryData<PrGroup[]>(groupsQuery.queryKey, list => [group, ...(list ?? []).filter(item => item.id !== group.id)]);
}

/** The saves of each group, in order. A change starts from the result of the change before it. */
const saving = new Map<string, Promise<unknown>>();

/**
 * Changes a group and saves it. The cache shows the change at once. The changes of one group run one after the
 * other, and each change reads the newest copy. Returns the saved group, or undefined when the group does not exist.
 * When `change` throws an error, nothing changes and the promise rejects.
 */
export function updateGroup(id: string, change: (group: PrGroup) => PrGroup): Promise<PrGroup | undefined> {
    const previous = saving.get(id) ?? Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(async () => {
            const current = cachedGroup(id);
            if (!current) return undefined;
            const changed = { ...change(current), updatedAt: Date.now() };
            putInCache(changed);
            return api.save(changed);
        });
    saving.set(id, next);
    void next.finally(() => {
        if (saving.get(id) === next) saving.delete(id);
    });
    return next;
}

/** Saves a new group and puts it first in the cache. */
export async function createGroup(group: PrGroup): Promise<PrGroup> {
    putInCache(group);
    return api.save(group);
}

/** Removes a group from the file and from the cache. A review that runs stops. */
export async function removeGroup(id: string): Promise<void> {
    cancelGroupReview(id);
    await api.remove(id);
    queryClient.setQueryData<PrGroup[]>(groupsQuery.queryKey, list => list?.filter(group => group.id !== id));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Group reviews                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The state of the review of a group: it runs, or it failed with an error. A done review is in `lastReview`. */
export type GroupRunState = { status: 'idle' } | { status: 'running'; id: string; stage: 'load' | 'agent' } | { status: 'error'; error: string };

const IDLE: GroupRunState = { status: 'idle' };
let runs: ReadonlyMap<string, GroupRunState> = new Map();
const listeners = new Set<() => void>();

function setRun(groupId: string, state: GroupRunState): void {
    const next = new Map(runs);
    if (state.status === 'idle') next.delete(groupId);
    else next.set(groupId, state);
    runs = next;
    listeners.forEach(listener => listener());
}

function runOf(groupId: string): GroupRunState {
    return runs.get(groupId) ?? IDLE;
}

function isRun(groupId: string, id: string): boolean {
    const current = runOf(groupId);
    return current.status === 'running' && current.id === id;
}

/** The review state of a group, for a view. The view can close and open again while the agent works. */
export function useGroupRun(groupId: string | undefined): GroupRunState {
    return useSyncExternalStore(
        listener => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => (groupId ? runOf(groupId) : IDLE)
    );
}

/**
 * Asks the agent to review all pull requests of the group in one run. The agent posts nothing.
 * The line comments for each pull request become pending comments of the user on that pull request, and the summary
 * of each pull request goes into its review text. The summary of the group goes into `lastReview` of the group.
 */
export async function runGroupReview(groupId: string): Promise<void> {
    const group = cachedGroup(groupId);
    if (!group || runOf(groupId).status === 'running') return;
    if (group.pullRequests.length === 0) {
        setRun(groupId, { status: 'error', error: 'The group has no pull requests. Add a pull request first.' });
        return;
    }
    const id = crypto.randomUUID();
    setRun(groupId, { status: 'running', id, stage: 'load' });
    try {
        // The newest data: the agent must review the current head commits.
        const loaded = await Promise.all(
            group.pullRequests.map(async item => {
                const [pr, files] = await Promise.all([
                    queryClient.fetchQuery({ ...pullRequestQuery(item.repo, item.number), staleTime: 0 }),
                    reviewStore.loadFiles(item.repo, item.number, true)
                ]);
                return { item, pr, files, key: prKey(item) };
            })
        );
        if (!isRun(groupId, id)) return;
        setRun(groupId, { status: 'running', id, stage: 'agent' });
        const inputs: ReviewPromptInput[] = loaded.map(({ item, pr, files }) => ({ pr, repo: item.repo, files }));
        const prompt = groupReviewPrompt({ name: group.name, note: group.note, pullRequests: inputs });
        const result = await api.review({
            id,
            prompt,
            pullRequests: loaded.map(({ item, pr }) => ({ repo: item.repo, number: item.number, headRefOid: pr.headRefOid }))
        });
        if (!isRun(groupId, id)) return;

        const parsed = parseGroupReview(
            result.answer,
            loaded.map(({ key, files }) => ({ key, files }))
        );
        const heads: Record<string, string> = {};
        const counts: Record<string, GroupReviewCounts> = {};
        for (const { item, pr, key } of loaded) {
            heads[key] = pr.headRefOid;
            const review = parsed.reviews.get(key);
            counts[key] = { comments: review?.comments.length ?? 0, notes: review?.unplaced.length ?? 0 };
            if (review) reviewStore.applyAgentReview(item.repo, item.number, review, result.agent);
        }
        await updateGroup(groupId, current => ({
            ...current,
            // The titles can change. The list shows the newest titles before the pull requests load.
            pullRequests: current.pullRequests.map(item => {
                const found = loaded.find(entry => entry.key === prKey(item));
                return found ? { ...item, title: found.pr.title } : item;
            }),
            lastReview: { at: Date.now(), agent: result.agent, summary: parsed.summary, heads, counts }
        }));
        setRun(groupId, IDLE);
    } catch (error) {
        if (!isRun(groupId, id)) return;
        setRun(groupId, { status: 'error', error: errorText(error) });
    }
}

/** Stops the review of a group. */
export function cancelGroupReview(groupId: string): void {
    const current = runOf(groupId);
    if (current.status !== 'running') return;
    setRun(groupId, IDLE);
    void api.cancelReview(current.id);
}

/** Hides the error of the last review of a group. */
export function dismissGroupError(groupId: string): void {
    if (runOf(groupId).status === 'error') setRun(groupId, IDLE);
}
