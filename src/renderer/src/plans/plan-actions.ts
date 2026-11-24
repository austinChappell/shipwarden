import {
    repoLabel as repoRefLabel,
    sameRepoRef,
    type MergedPullRequest,
    type PullRequest,
    type PullRequestChange,
    type RepoRef,
    type RepoTarget
} from '@shared/github';
import { MAX_GROUP_PULL_REQUESTS, parsePullRequestLink, prKey } from '@shared/pr-groups';
import { batchPrompt, type BatchPullRequest } from '@shared/batch-prompt';
import { MAX_TITLE_LENGTH, newStep, type Plan, type PlanStep } from '@shared/plans';
import type { BatchSendResult } from '../github/pr-group-agents';
import { checkLine, checksPrompt } from '@shared/agent-text';
import { confirmForcePush } from '../git/rebase-actions';
import { threadComments, threadPlace } from '../github/agent-prompts';
import { isFailedConclusion } from '../github/ci-queries';
import { canEnqueueNow } from '../github/merge-state';
import { changePullRequest, mergePullRequest } from '../github/pull-request-mutations';
import { pullRequestQuery } from '../github/review-store';
import { keyRoots, queryClient } from '../query-client';
import { errorText } from '../util';
import { syncGroupOrder, syncPlanGroup } from './plan-group';
import { cachedPlan, updatePlan } from './plan-queries';
import { planRunner } from './plan-runner';
import { moveKeyTo } from '../components/reorder';

const api = window.shipwarden;

/** The words at the end of each prompt to a step agent. A push updates the pull request of the step. */
const PUSH = 'Then push the branch, so that the pull request gets the change.';

/** The repository of the pull request of a step, for the GitHub calls. The folder of the repository works for each host. */
function targetOf(step: PlanStep): RepoTarget {
    if (!step.repo) throw new Error('The step has no repository.');
    return step.repo;
}

/** Loads the full pull request of a step again. A review or a check can change at any time. */
async function loadPullRequest(step: PlanStep): Promise<PullRequest> {
    if (!step.pr) throw new Error('The step has no pull request.');
    const link = parsePullRequestLink(step.pr.url);
    if (link) return queryClient.fetchQuery({ ...pullRequestQuery(link.repo, link.number), staleTime: 0 });
    return api.github.pullRequest(targetOf(step), step.pr.number);
}

/** Loads the pull request of a step for a merge. It throws an error when the user cannot merge it now. */
export async function loadStepForMerge(step: PlanStep): Promise<PullRequest> {
    const pr = await loadPullRequest(step);
    if (pr.state !== 'OPEN') throw new Error(`Pull request #${pr.number} is not open anymore.`);
    if (!pr.viewerCanMerge) throw new Error(`You cannot merge pull request #${pr.number}. Ask for write access to the repository.`);
    if (pr.mergeQueueEntry) throw new Error(`Pull request #${pr.number} is already in the merge queue.`);
    if (pr.mergeQueueRequired && pr.autoMerge) throw new Error(`Auto-merge is already on for pull request #${pr.number}.`);
    return pr;
}

/** The question and the button text before the merge of a step. */
export function stepMergeConfirm(step: PlanStep, pr: PullRequest): { title: string; message: string; confirmLabel: string } {
    if (!pr.mergeQueueRequired) {
        return {
            title: `Merge #${pr.number}?`,
            message: `"${step.title}" merges into ${pr.baseRefName} with the default merge method of the repository.`,
            confirmLabel: 'Merge'
        };
    }
    return {
        title: `Merge #${pr.number} when ready?`,
        message: canEnqueueNow(pr)
            ? `"${step.title}" goes into the merge queue of ${pr.baseRefName}. GitHub merges it when the checks of the queue pass.`
            : `GitHub adds "${step.title}" to the merge queue of ${pr.baseRefName} when all the requirements pass.`,
        confirmLabel: 'Merge when ready'
    };
}

/**
 * Merges the pull request of a step with the default merge method of the repository. The merged list of the
 * repository gets the branch at once, so that the page shows the step as merged before the next load.
 * When the base branch needs a merge queue, the pull request goes into the queue, or auto-merge turns on.
 * GitHub merges it later, and the step shows as merged after a load.
 */
export async function mergeStep(step: PlanStep, pr: PullRequest): Promise<void> {
    if (pr.mergeQueueRequired) {
        const change: PullRequestChange = canEnqueueNow(pr)
            ? { kind: 'mergeQueue', pullRequestId: pr.id, add: true, headSha: pr.headRefOid }
            : { kind: 'autoMerge', pullRequestId: pr.id, method: pr.defaultMergeMethod, headSha: pr.headRefOid };
        await changePullRequest(targetOf(step), pr, change);
        return;
    }
    await mergePullRequest(targetOf(step), pr, pr.defaultMergeMethod, parsePullRequestLink(pr.url)?.repo);
    if (step.repo && step.branch) {
        const branch = step.branch;
        queryClient.setQueryData<Record<string, MergedPullRequest>>([...keyRoots.mergedBranches, step.repo], merged => ({
            ...(merged ?? {}),
            [branch]: { number: pr.number, title: pr.title, headSha: pr.headRefOid }
        }));
    }
}

/**
 * Pushes the branch of a step after ShipWarden rebased it onto a new base. The user confirms the push with
 * "--force-with-lease" first. ShipWarden never force-pushes without this question.
 */
export async function pushRestackedStep(plan: Plan, step: PlanStep): Promise<void> {
    if (!step.worktreePath || !step.restack) return;
    const changes = await api.git.changes(step.worktreePath);
    if (changes.rebase) throw new Error('The rebase is not complete. Resolve the conflicts in the Changes tab first.');
    if (!changes.upstream) throw new Error('The branch has no upstream branch. Push it from the Changes tab.');
    if (await confirmForcePush(step.worktreePath, changes.upstream, `origin/${step.restack.onto}`)) await planRunner.restackPushed(plan.id, step.id);
}

/** Returns the prompt with the reviews that ask for changes and the open threads of a pull request. */
export function reviewFixPrompt(pr: PullRequest): string {
    const parts = [`Reviewers asked for changes on pull request #${pr.number} (${pr.url}).`];
    // The newest review of each reviewer counts. An older review that asked for changes can be out of date.
    const newest = new Map<string, PullRequest['reviews'][number]>();
    for (const review of pr.reviews) newest.set(review.author?.login ?? '', review);
    for (const review of newest.values()) {
        if (review.state === 'CHANGES_REQUESTED' && review.body.trim()) {
            parts.push(`${review.author?.login ?? 'Someone'} wrote:\n\n${review.body.trim()}`);
        }
    }
    for (const thread of pr.threads.filter(item => !item.isResolved)) {
        parts.push(`The open thread on ${threadPlace(thread)}:\n\n${threadComments(thread)}`);
    }
    parts.push(`Make the changes that the reviewers ask for. Run the tests and commit. ${PUSH}`);
    return parts.join('\n\n');
}

/** Sends the reviews and the open threads of the pull request of a step to the agent of the step. */
export async function sendReviewToAgent(plan: Plan, step: PlanStep): Promise<void> {
    const pr = await loadPullRequest(step);
    await planRunner.followUp(plan.id, step.id, reviewFixPrompt(pr), `Fixing the review comments on #${pr.number}`);
}

/** Sends the failed checks of the pull request of a step to the agent of the step. Each GitHub Actions job gets its saved log. */
export async function sendChecksToAgent(plan: Plan, step: PlanStep, headSha: string): Promise<void> {
    const target = targetOf(step);
    const failed = (await api.github.checks(target, headSha)).filter(check => isFailedConclusion(check.conclusion));
    if (failed.length === 0) throw new Error('No check fails now. The checks possibly ran again.');
    const lines = await Promise.all(failed.map(async check => checkLine(check, check.isActions ? await api.github.saveJobLog(target, check.id) : undefined)));
    await planRunner.followUp(plan.id, step.id, `${checksPrompt(lines)}\n${PUSH}`, `Fixing the failed checks on #${step.pr?.number}`);
}

/**
 * True when the agent of a step can get a prompt from "Prompt the agents": the step is done and has a worktree. A
 * step that runs now waits for the end of its own turn.
 */
export function canPromptStep(step: PlanStep): boolean {
    return step.status === 'done' && !!step.worktreePath && !!step.repo;
}

/**
 * Sends one prompt to the agents of the selected steps. Each agent gets the list of the steps of the plan with a
 * worktree, so it knows its part of the change. Each step gets its own result.
 */
export async function promptPlanAgents(
    plan: Plan,
    stepIds: readonly string[],
    prompt: string,
    push: boolean,
    repoLabel: (repo: string) => string
): Promise<BatchSendResult[]> {
    const steps = plan.steps.filter(canPromptStep);
    const list: BatchPullRequest[] = steps.map(step => ({
        repo: step.repo ? repoLabel(step.repo) : '',
        title: step.title,
        ...(step.pr ? { number: step.pr.number, url: step.pr.url } : {}),
        ...(step.branch ? { branch: step.branch } : {})
    }));
    const selected = new Set(stepIds);
    const targets = steps.flatMap((step, index) => (selected.has(step.id) ? [{ step, index }] : []));
    return Promise.all(
        targets.map(async ({ step, index }): Promise<BatchSendResult> => {
            try {
                const text = batchPrompt({ kind: 'plan', title: plan.title, pullRequests: list, index, recipients: targets.length, prompt, push });
                await planRunner.followUp(plan.id, step.id, text, 'Working on your request');
                return { key: step.id };
            } catch (error) {
                return { key: step.id, error: errorText(error) };
            }
        })
    );
}

/** Returns the repository folder of the project with the repository as its "origin" remote, or undefined. */
async function projectRepoOf(repo: RepoRef, repos: readonly string[]): Promise<string | undefined> {
    for (const path of repos) {
        const remote = await queryClient.fetchQuery({ queryKey: [...keyRoots.repoOf, path], queryFn: () => api.github.repoOf(path) }).catch(() => null);
        if (sameRepoRef(remote, repo)) return path;
    }
    return undefined;
}

/**
 * Adds a pull request to a plan that ran. The pull request becomes a new done step at the end of the plan. The pull
 * request must be in a repository of the project. When the repository has a worktree of the head branch, the step
 * gets that worktree, so that its agent can get prompts. The PR group of the plan gets the pull request too.
 * Throws an error with a message.
 */
export async function addPullRequestStep(planId: string, link: string, repos: readonly string[]): Promise<void> {
    const parsed = parsePullRequestLink(link);
    if (!parsed) throw new Error('Paste the link of a GitHub or Azure Repos pull request, or write owner/name#number.');
    const plan = cachedPlan(planId);
    if (!plan) throw new Error('The plan does not exist anymore.');
    const key = prKey(parsed);
    const inPlan = (steps: readonly PlanStep[]) =>
        steps.some(step => {
            const other = step.pr ? parsePullRequestLink(step.pr.url) : undefined;
            return !!other && prKey(other).toLowerCase() === key.toLowerCase();
        });
    if (inPlan(plan.steps)) throw new Error('The pull request is in the plan already.');
    if (plan.steps.length >= MAX_GROUP_PULL_REQUESTS) throw new Error(`A plan can have at most ${MAX_GROUP_PULL_REQUESTS} steps.`);
    const repo = await projectRepoOf(parsed.repo, repos);
    if (!repo) throw new Error(`The project has no clone of ${repoRefLabel(parsed.repo)}. Add the repository to the project first.`);
    const pr = await queryClient.fetchQuery(pullRequestQuery(parsed.repo, parsed.number));
    const worktree = (await api.worktrees.list(repo).catch(() => [])).find(item => item.branch === pr.headRefName);
    const step: PlanStep = {
        ...newStep(repo),
        title: pr.title.slice(0, MAX_TITLE_LENGTH),
        status: 'done',
        reviewed: true,
        branch: pr.headRefName,
        pr: { number: pr.number, url: pr.url, base: pr.baseRefName },
        finishedAt: Date.now(),
        ...(worktree ? { worktreePath: worktree.path } : {})
    };
    const updated = await updatePlan(planId, current => {
        if (inPlan(current.steps)) throw new Error('The pull request is in the plan already.');
        return { ...current, steps: [...current.steps, step] };
    });
    // A problem with the group does not undo the new step.
    if (updated && !updated.noPrGroup) {
        await syncPlanGroup(updated).catch(error => console.warn(`[plans] The PR group of "${updated.title}" did not change: ${errorText(error)}`));
    }
}

/**
 * Moves a step of a plan to the index `to` among the steps of its repository. The steps of the other repositories keep
 * their places. Earlier steps in a repository merge first, so the order is the merge order. The PR group of the plan
 * gets the same order.
 */
export async function moveStepInRepo(planId: string, stepId: string, to: number): Promise<void> {
    const plan = await updatePlan(planId, current => {
        const repo = current.steps.find(step => step.id === stepId)?.repo;
        const among = current.steps.filter(step => step.repo === repo).map(step => step.id);
        return { ...current, steps: [...moveKeyTo(current.steps, step => step.id, stepId, to, among)] };
    });
    // The PR group of the plan gets the same order.
    if (plan) await syncGroupOrder(plan);
}
