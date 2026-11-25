import { useSyncExternalStore } from 'react';
import type { MergedPullRequest, PullRequest } from '@shared/github';
import type { Plan, PlanStep } from '@shared/plans';
import { parsePullRequestLink, prKey } from '@shared/pr-groups';
import {
    mergeStack,
    rebaseStack,
    stackEntries,
    stackLines,
    type MergeStackResult,
    type StackEntry,
    type StackItemState,
    type StackRunResult
} from '@shared/stack-actions';
import { confirmDialog } from '../components/ConfirmDialog';
import { conflictPromptFor } from '../git/rebase-actions';
import { gitChanged } from '../git/git-store';
import { mergeBlocker, selectMergeMethod } from '../github/merge-state';
import { cachedPullRequest, writePullRequest } from '../github/pull-request-cache';
import { mergePullRequest } from '../github/pull-request-mutations';
import { keyRoots, queryClient } from '../query-client';
import { agentStateStore } from '../terminal/agent-state-store';
import { errorText } from '../util';
import { loadPullRequest } from './plan-actions';
import { cachedPlan, updatePlan } from './plan-queries';
import { planRunner } from './plan-runner';

/*
 * "Rebase stack" and "Merge stack" on the page of a plan PR group. The order and the stops are in
 * `@shared/stack-actions`. This module gives it the git calls, the calls of the review provider of each repository, and
 * the cache. Each result patches the cache, so the page shows it without a new load.
 */

const api = window.shipwarden;

export type StackActionKind = 'rebase' | 'merge';

/** A stack action of a group that runs or finished. */
export interface StackRun {
    status: 'running' | 'finished';
    kind: StackActionKind;
    /** The state of each pull request, by `prKey`. */
    items: Record<string, StackItemState>;
    /** The result, when the run finished. */
    result?: StackRunResult;
    /** The plan and the step of a rebase conflict. "Send to agent" gives the conflict to the agent of the step. */
    conflict?: { planId: string; stepId: string; worktreePath: string; branch: string };
}

/** The state of the stack action of a group. */
export type StackRunState = { status: 'idle' } | StackRun;

const IDLE: StackRunState = { status: 'idle' };
let runs = new Map<string, StackRunState>();
const listeners = new Set<() => void>();

function setRun(groupId: string, state: StackRunState): void {
    runs = new Map(runs).set(groupId, state);
    listeners.forEach(listener => listener());
}

function patchRun(groupId: string, change: (state: StackRun) => StackRunState): void {
    const current = runs.get(groupId);
    if (current && current.status !== 'idle') setRun(groupId, change(current));
}

/** The state of the stack action of a group. */
export function useStackRun(groupId: string): StackRunState {
    return useSyncExternalStore(
        listener => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => runs.get(groupId) ?? IDLE
    );
}

/** Hides the result of the last stack action of the group. */
export function dismissStackRun(groupId: string): void {
    setRun(groupId, IDLE);
}

/** The key of the pull request of a step, as the rows of the group use it. */
function keyOf(step: PlanStep): string | undefined {
    const link = step.pr ? parsePullRequestLink(step.pr.url) : undefined;
    return link ? prKey(link) : undefined;
}

/** The merged pull request of the branch of a step, from the merged list of the repository in the cache. */
function mergedOf(step: PlanStep): MergedPullRequest | undefined {
    if (!step.repo || !step.branch || !step.pr) return undefined;
    const merged = queryClient.getQueryData<Record<string, MergedPullRequest>>([...keyRoots.mergedBranches, step.repo])?.[step.branch];
    return merged?.number === step.pr.number ? merged : undefined;
}

/** The open pull requests of the plan as a stack, the bottom first. It uses only the cache. */
export function planStack(plan: Plan): StackEntry[] {
    if (plan.noStack) return [];
    return stackEntries(
        plan.steps,
        keyOf,
        step => {
            if (mergedOf(step)) return true;
            const pr = step.pr ? cachedPullRequest(queryClient, step.pr.url) : undefined;
            return !!pr && pr.state !== 'OPEN';
        },
        step => mergedOf(step)?.headSha || (step.pr ? cachedPullRequest(queryClient, step.pr.url)?.headRefOid : undefined) || undefined
    );
}

/** The reason that a pull request cannot use "Merge stack", or undefined. The rows load the pull requests already. */
export function mergeStackBlocker(pr: PullRequest | undefined): string | undefined {
    if (pr?.state !== 'OPEN') return undefined;
    if (pr.mergeQueueRequired) return `#${pr.number} needs the merge queue. Merge it from its page.`;
    if (pr.allowedMergeMethods.length === 0) return `The repository of #${pr.number} allows no merge method.`;
    return undefined;
}

/** Why the branch of a step cannot rebase now: an agent that works in the worktree can mix its edits with the rebase. */
function busyReason(plan: Plan, entry: StackEntry): string | undefined {
    const step = plan.steps.find(item => item.id === entry.stepId);
    const state = step?.sessionId ? agentStateStore.getSnapshot().get(step.sessionId)?.state : undefined;
    return state === 'working' || state === 'starting' ? 'The agent of the branch is working. Wait until it stops.' : undefined;
}

/** Changes the base of the pull request of a step, and patches the cache and the plan. */
async function retarget(planId: string, entry: StackEntry, base: string): Promise<void> {
    const step = cachedPlan(planId)?.steps.find(item => item.id === entry.stepId);
    if (!step?.repo) throw new Error('The step has no repository.');
    await api.github.changePullRequest(step.repo, entry.number, { kind: 'base', base });
    const cached = cachedPullRequest(queryClient, entry.url);
    if (cached) writePullRequest(queryClient, cached, current => ({ ...current, baseRefName: base }));
    await updatePlan(planId, plan => ({
        ...plan,
        steps: plan.steps.map(item => (item.id === entry.stepId && item.pr ? { ...item, pr: { ...item.pr, base } } : item))
    }));
}

/** Asks the user before a stack action. The dialog lists the pull requests in the order of the run. */
function confirmStack(kind: StackActionKind, entries: readonly StackEntry[]): Promise<boolean> {
    return confirmDialog(
        kind === 'rebase'
            ? {
                  title: `Rebase ${entries.length === 1 ? 'the branch' : `the ${entries.length} branches`} of the stack?`,
                  message:
                      'ShipWarden rebases each branch onto its parent, the bottom first, and pushes it with --force-with-lease. It stops at the first conflict and keeps that rebase in progress, so you or the agent can resolve it.',
                  detail: stackLines(entries),
                  confirmLabel: 'Rebase and push',
                  danger: true
              }
            : {
                  title: `Merge ${entries.length === 1 ? 'the pull request' : `the ${entries.length} pull requests`} of the stack?`,
                  message:
                      'ShipWarden merges the pull requests from the bottom up with the merge method of each repository. After each merge, the next pull request gets the new base. It stops at the first pull request that is not ready, and it does not wait for checks.',
                  detail: stackLines(entries),
                  confirmLabel: 'Merge'
              }
    );
}

/** Starts the run state of a group with each pull request as "waiting". */
function startRun(groupId: string, kind: StackActionKind): void {
    setRun(groupId, { status: 'running', kind, items: {} });
}

function progressOf(groupId: string) {
    return (key: string, state: StackItemState) => patchRun(groupId, current => ({ ...current, items: { ...current.items, [key]: state } }));
}

/** True while a stack action of the group runs. */
function running(groupId: string): boolean {
    return runs.get(groupId)?.status === 'running';
}

/**
 * "Rebase stack": asks the user, then rebases and pushes each branch of the stack of the plan. Returns after the run.
 * It throws an error with a message when the run cannot start.
 */
export async function runRebaseStack(groupId: string, planId: string): Promise<void> {
    const plan = cachedPlan(planId);
    if (!plan || running(groupId)) return;
    const entries = planStack(plan);
    if (entries.length === 0) throw new Error('The plan has no open pull requests to rebase.');
    if (!(await confirmStack('rebase', entries))) return;
    startRun(groupId, 'rebase');
    planRunner.hold(planId);
    // The children use the head of their parent on the host before the run as their old base.
    const heads = new Map(entries.map(entry => [entry.key, cachedPullRequest(queryClient, entry.url)?.headRefOid]));
    let result: StackRunResult;
    try {
        result = await rebaseStack(entries, {
            git: {
                rebase: (worktree, onto, oldBases) => api.git.rebase(worktree, onto, oldBases).finally(gitChanged),
                changes: worktree => api.git.changes(worktree),
                pushWithLease: worktree => api.git.pushWithLease(worktree).finally(gitChanged)
            },
            busyReason: entry => busyReason(plan, entry),
            retarget: (entry, base) => retarget(planId, entry, base),
            headBefore: entry => heads.get(entry.key) || undefined,
            progress: (key, state) => {
                progressOf(groupId)(key, state);
                // A pushed branch has no rebase that waits anymore.
                const entry = entries.find(item => item.key === key);
                if (state.status === 'done' && entry?.restackWaiting) void planRunner.restackPushed(planId, entry.stepId);
            }
        });
    } catch (error) {
        result = { status: 'stopped', key: '', reason: 'error', text: errorText(error) };
    } finally {
        await planRunner.release(planId);
    }
    const stopped = result.status === 'stopped' && result.reason === 'conflict' ? entries.find(entry => entry.key === result.key) : undefined;
    patchRun(groupId, current => ({
        ...current,
        status: 'finished',
        result,
        ...(stopped?.worktreePath ? { conflict: { planId, stepId: stopped.stepId, worktreePath: stopped.worktreePath, branch: stopped.branch } } : {})
    }));
}

/** Sends the rebase conflict of the last "Rebase stack" to the agent of the step. */
export async function sendStackConflict(groupId: string): Promise<void> {
    const state = runs.get(groupId);
    const conflict = state && state.status !== 'idle' ? state.conflict : undefined;
    if (!conflict) return;
    const prompt = await conflictPromptFor(conflict.worktreePath, undefined);
    await planRunner.followUp(conflict.planId, conflict.stepId, prompt, `Resolving the rebase conflict of ${conflict.branch}`);
    patchRun(groupId, current => ({ ...current, conflict: undefined }));
}

/** Puts the merged pull requests into the merged list of each repository, so the plan sees them without a load. */
function patchMergedBranches(plan: Plan, merged: MergeStackResult['merged']): void {
    for (const { entry, pr } of merged) {
        const step = plan.steps.find(item => item.id === entry.stepId);
        if (!step?.repo) continue;
        queryClient.setQueryData<Record<string, MergedPullRequest>>([...keyRoots.mergedBranches, step.repo], list => ({
            ...(list ?? {}),
            [entry.branch]: { number: pr.number, title: pr.title, headSha: pr.headRefOid }
        }));
    }
}

/**
 * "Merge stack": asks the user, then merges the ready pull requests of the stack from the bottom up. Each merge goes
 * to the review provider of the repository. Returns after the run.
 */
export async function runMergeStack(groupId: string, planId: string): Promise<void> {
    const plan = cachedPlan(planId);
    if (!plan || running(groupId)) return;
    const entries = planStack(plan);
    if (entries.length === 0) throw new Error('The plan has no open pull requests to merge.');
    if (!(await confirmStack('merge', entries))) return;
    startRun(groupId, 'merge');
    planRunner.hold(planId);
    const stepOf = (entry: StackEntry): PlanStep => {
        const step = cachedPlan(planId)?.steps.find(item => item.id === entry.stepId);
        if (!step?.repo) throw new Error(`The step of #${entry.number} has no repository.`);
        return step;
    };
    let result: MergeStackResult;
    try {
        result = await mergeStack(entries, {
            host: {
                // The load writes the pull request into the cache, so the rows show the newest state.
                load: entry => loadPullRequest(stepOf(entry)),
                merge: (entry, pr, method) => mergePullRequest(stepOf(entry).repo as string, pr, method, parsePullRequestLink(pr.url)?.repo),
                retarget: (entry, base) => retarget(planId, entry, base),
                wait: ms => new Promise(resolve => setTimeout(resolve, ms))
            },
            blocker: pr => {
                if (!pr.viewerCanMerge) return `You cannot merge #${pr.number}. Ask for write access to the repository.`;
                return mergeStackBlocker(pr) ?? mergeBlocker(pr);
            },
            method: pr => selectMergeMethod(pr, undefined),
            progress: progressOf(groupId)
        });
        patchMergedBranches(plan, result.merged);
    } catch (error) {
        result = { status: 'stopped', key: '', reason: 'error', text: errorText(error), merged: [] };
    } finally {
        // The plan now sees the merges, and rebases the branch above the last merge when that is necessary.
        await planRunner.release(planId);
    }
    patchRun(groupId, current => ({ ...current, status: 'finished', result }));
}
