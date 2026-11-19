import { repoLabel, type RepoRef } from '@shared/github';
import { batchPrompt, type BatchPullRequest } from '@shared/batch-prompt';
import { prKey, type PrGroup } from '@shared/pr-groups';
import type { TerminalSession } from '@shared/terminal';
import type { CreatedWorktree, Worktree } from '@shared/worktrees';
import { queryClient } from '../query-client';
import { errorText } from '../util';
import { pullRequestQuery } from './review-store';

const api = window.shipwarden;

/** The functions of the app that the group agents use. They throw an error with a message. */
export interface GroupAgentActions {
    promptAgent(worktree: Pick<Worktree, 'path'>, prompt: string, target?: { repoPath?: string }): Promise<TerminalSession>;
    prepareWorktree(repoPath: string, worktree: CreatedWorktree): Promise<void>;
    refreshWorktrees(repo: string): Promise<Worktree[]>;
    findRepoPath(repo: RepoRef): Promise<{ projectId: string; repoPath: string } | undefined>;
}

let actions: GroupAgentActions | undefined;

/** App gives the newest functions at each render. */
export function setGroupAgentActions(next: GroupAgentActions): void {
    actions = next;
}

/** The result for one pull request. Without `error`, the agent got the prompt. */
export interface BatchSendResult {
    key: string;
    error?: string;
}

/**
 * Finds the worktree of the head branch of a pull request. Without one, ShipWarden makes a worktree that tracks the
 * branch on "origin". Throws an error with a message.
 */
async function worktreeOf(
    repo: RepoRef,
    branch: string,
    crossRepository: boolean | undefined
): Promise<{ worktree: Pick<Worktree, 'path'>; repoPath: string }> {
    if (!actions) throw new Error('ShipWarden did not load yet. Try again in a few seconds.');
    const found = await actions.findRepoPath(repo);
    if (!found) throw new Error(`No project has a clone of ${repoLabel(repo)}. Add a clone to a project.`);
    const { repoPath } = found;
    const existing = (await api.worktrees.list(repoPath)).find(item => item.branch === branch);
    if (existing) return { worktree: existing, repoPath };
    if (crossRepository) throw new Error(`The branch ${branch} is in a fork. ShipWarden can make a worktree only from a branch of origin.`);
    const created = await api.worktrees.create({ repoPath, branch, trackRef: `origin/${branch}` });
    await actions.prepareWorktree(repoPath, created);
    await actions.refreshWorktrees(repoPath);
    return { worktree: created, repoPath };
}

/**
 * Sends the prompt to the agent in the worktree of each selected pull request of a group. A pull request without a
 * worktree gets a new worktree. A pull request without an agent gets a new agent. Each pull request gets its own
 * result, so one problem does not stop the others.
 */
export async function promptGroupAgents(group: PrGroup, keys: readonly string[], prompt: string, push: boolean): Promise<BatchSendResult[]> {
    const loaded = await Promise.all(
        group.pullRequests.map(async pr => {
            try {
                return await queryClient.fetchQuery({ ...pullRequestQuery(pr.repo, pr.number), staleTime: 0 });
            } catch {
                return undefined;
            }
        })
    );
    const list: BatchPullRequest[] = group.pullRequests.map((pr, index) => ({
        repo: repoLabel(pr.repo),
        number: pr.number,
        title: loaded[index]?.title ?? pr.title ?? '',
        ...(loaded[index] ? { url: loaded[index].url, branch: loaded[index].headRefName } : {})
    }));
    const selected = new Set(keys);
    const targets = group.pullRequests.flatMap((pr, index) => (selected.has(prKey(pr)) ? [{ pr, index }] : []));
    const results: BatchSendResult[] = [];
    const ready: { key: string; index: number; worktree: Pick<Worktree, 'path'>; repoPath: string }[] = [];
    // One worktree at a time: two "git worktree add" commands in one repository can block each other.
    for (const { pr, index } of targets) {
        const key = prKey(pr);
        const data = loaded[index];
        try {
            if (!data) throw new Error('The pull request did not load.');
            if (data.state !== 'OPEN') throw new Error(`Pull request #${pr.number} is not open.`);
            ready.push({ key, index, ...(await worktreeOf(pr.repo, data.headRefName, data.isCrossRepository)) });
        } catch (error) {
            results.push({ key, error: errorText(error) });
        }
    }
    const sent = await Promise.all(
        ready.map(async ({ key, index, worktree, repoPath }): Promise<BatchSendResult> => {
            try {
                if (!actions) throw new Error('ShipWarden did not load yet. Try again in a few seconds.');
                const text = batchPrompt({ kind: 'group', title: group.name, pullRequests: list, index, recipients: targets.length, prompt, push });
                await actions.promptAgent(worktree, text, { repoPath });
                return { key };
            } catch (error) {
                return { key, error: errorText(error) };
            }
        })
    );
    return [...results, ...sent];
}
