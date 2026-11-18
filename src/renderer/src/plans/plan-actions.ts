import type { MergedPullRequest, PullRequest, RepoTarget } from '@shared/github';
import { parsePullRequestLink } from '@shared/pr-groups';
import type { Plan, PlanStep } from '@shared/plans';
import { checkLine, checksPrompt } from '../app/agent-text';
import { threadComments, threadPlace } from '../github/agent-prompts';
import { isFailedConclusion } from '../github/ci-queries';
import { mergePullRequest } from '../github/pull-request-mutations';
import { pullRequestQuery } from '../github/review-store';
import { keyRoots, queryClient } from '../query-client';
import { planRunner } from './plan-runner';

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

/**
 * Merges the pull request of a step with the default merge method of the repository. The merged list of the
 * repository gets the branch at once, so that the page shows the step as merged before the next load.
 */
export async function mergeStep(step: PlanStep): Promise<void> {
    const pr = await loadPullRequest(step);
    if (pr.state !== 'OPEN') throw new Error(`Pull request #${pr.number} is not open anymore.`);
    if (!pr.viewerCanMerge) throw new Error(`You cannot merge pull request #${pr.number}. Ask for write access to the repository.`);
    await mergePullRequest(targetOf(step), pr, pr.defaultMergeMethod, parsePullRequestLink(pr.url)?.repo);
    if (step.repo && step.branch) {
        const branch = step.branch;
        queryClient.setQueryData<Record<string, MergedPullRequest>>([...keyRoots.mergedBranches, step.repo], merged => ({
            ...(merged ?? {}),
            [branch]: { number: pr.number, title: pr.title, headSha: pr.headRefOid }
        }));
    }
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
