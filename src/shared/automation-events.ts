import type { AutomationEvent } from './automations';
import type { MyPullRequestItem, PullRequestCommentItem } from './dashboard';
import { repoId, type BranchSummary, type RepoRef } from './github';
import { ciChanges } from './notifications';
import type { Task } from './tasks';
import type { Worktree } from './worktrees';

/**
 * The functions that make automation events from the data that ShipWarden loads already: the branch summaries (one
 * request for each repository each minute), the Dashboard refreshes and the agent hooks. They send no requests.
 */

/** A worktree and its repository folder. */
export interface WorktreePlace {
    repo: string;
    worktree: Pick<Worktree, 'path' | 'branch' | 'isMain'>;
}

/** Returns the worktree of a branch in a repository. The main worktree does not count: automations do not act on it. */
export function worktreeOnBranch(places: readonly WorktreePlace[], repo: string, branch: string | undefined): WorktreePlace | undefined {
    if (!branch) return undefined;
    return places.find(place => place.repo === repo && place.worktree.branch === branch && !place.worktree.isMain);
}

function prOf(summary: BranchSummary) {
    return { number: summary.number, title: summary.title, url: summary.url, headSha: summary.headSha };
}

function prLabel(number: number, title: string | undefined): string {
    return title ? `#${number} ${title}` : `#${number}`;
}

/** The "ci.failed" events: the checks of a pull request of a worktree branch went from waiting to a failure. */
export function ciFailedEvents(
    repo: string,
    before: Record<string, BranchSummary> | undefined,
    after: Record<string, BranchSummary>,
    places: readonly WorktreePlace[],
    at: number
): AutomationEvent[] {
    return ciChanges(before, after)
        .filter(change => !change.passed)
        .flatMap(change => {
            const place = worktreeOnBranch(places, repo, change.branch);
            if (!place) return [];
            const summary = change.summary;
            return [
                {
                    trigger: 'ci.failed' as const,
                    key: `ci:${repo}#${summary.number}@${summary.headSha ?? at}`,
                    target: `pr:${repo}#${summary.number}`,
                    label: prLabel(summary.number, summary.title),
                    at,
                    repoPath: repo,
                    worktreePath: place.worktree.path,
                    branch: change.branch,
                    pr: prOf(summary)
                }
            ];
        });
}

/**
 * The pull requests of worktree branches that left the list of open pull requests between two loads. Each one can be
 * merged or closed. The caller loads the state of each one (one request) before it makes a "pr.merged" event.
 */
export function closedPullRequests(
    repo: string,
    before: Record<string, BranchSummary> | undefined,
    after: Record<string, BranchSummary>,
    places: readonly WorktreePlace[]
): { branch: string; summary: BranchSummary; place: WorktreePlace }[] {
    if (!before) return [];
    return Object.entries(before).flatMap(([branch, summary]) => {
        if (after[branch]?.number === summary.number) return [];
        const place = worktreeOnBranch(places, repo, branch);
        return place ? [{ branch, summary, place }] : [];
    });
}

/** The "pr.merged" event of a pull request that `closedPullRequests` found and that is merged. */
export function mergedEvent(repo: string, branch: string, summary: BranchSummary, place: WorktreePlace, at: number): AutomationEvent {
    return {
        trigger: 'pr.merged',
        key: `merged:${repo}#${summary.number}`,
        target: `pr:${repo}#${summary.number}`,
        label: prLabel(summary.number, summary.title),
        at,
        repoPath: repo,
        worktreePath: place.worktree.path,
        branch,
        pr: prOf(summary)
    };
}

/** Finds the repository folder, the branch and the worktree of a pull request by its GitHub repository and number. */
export type PullRequestResolver = (
    repo: RepoRef,
    number: number
) => { repoPath: string; branch: string; summary: BranchSummary; place: WorktreePlace } | undefined;

/**
 * Returns a resolver from the "origin" remote of each repository folder and the branch summaries.
 * `remotes` has the GitHub repository of each folder that is known. Folders without a GitHub remote are not in it.
 */
export function pullRequestResolver(
    remotes: Record<string, RepoRef | null>,
    summaries: Record<string, Record<string, BranchSummary>>,
    places: readonly WorktreePlace[]
): PullRequestResolver {
    return (repo, number) => {
        const id = repoId(repo).toLowerCase();
        for (const [repoPath, remote] of Object.entries(remotes)) {
            if (!remote || repoId(remote).toLowerCase() !== id) continue;
            for (const [branch, summary] of Object.entries(summaries[repoPath] ?? {})) {
                if (summary.number !== number) continue;
                const place = worktreeOnBranch(places, repoPath, branch);
                if (place) return { repoPath, branch, summary, place };
            }
        }
        return undefined;
    };
}

/** The "pr.comment" events: new comments and reviews from other people on pull requests of worktree branches. */
export function commentEvents(comments: readonly PullRequestCommentItem[], resolve: PullRequestResolver, at: number): AutomationEvent[] {
    return comments.flatMap(item => {
        // An approval needs no change, and the Dashboard keeps merged pull requests for a few days.
        if (item.reviewState === 'APPROVED' || (item.prState && item.prState !== 'OPEN')) return [];
        const found = resolve(item.repo, item.number);
        if (!found) return [];
        return [
            {
                trigger: 'pr.comment' as const,
                key: `comment:${item.id}`,
                target: `pr:${found.repoPath}#${item.number}`,
                label: `${prLabel(item.number, item.prTitle)}: ${item.author}`,
                at,
                repoPath: found.repoPath,
                worktreePath: found.place.worktree.path,
                branch: found.branch,
                pr: { number: item.number, title: item.prTitle, url: item.prUrl, headSha: found.summary.headSha },
                comment: {
                    id: item.id,
                    author: item.author,
                    body: item.text,
                    url: item.url,
                    ...(item.path ? { path: item.path } : {}),
                    ...(item.reviewState ? { reviewState: item.reviewState } : {})
                }
            }
        ];
    });
}

/** The "pr.conflict" events: pull requests of worktree branches that the Dashboard now shows with merge conflicts. */
export function conflictEvents(items: readonly MyPullRequestItem[], resolve: PullRequestResolver, at: number): AutomationEvent[] {
    return items.flatMap(item => {
        if (!item.reasons.includes('conflicts')) return [];
        const found = resolve(item.repo, item.number);
        if (!found) return [];
        return [
            {
                trigger: 'pr.conflict' as const,
                // A new push can make new conflicts. The head commit makes them a new event.
                key: `conflict:${found.repoPath}#${item.number}@${item.headSha ?? found.summary.headSha ?? at}`,
                target: `pr:${found.repoPath}#${item.number}`,
                label: prLabel(item.number, item.title),
                at,
                repoPath: found.repoPath,
                worktreePath: found.place.worktree.path,
                branch: found.branch,
                pr: { number: item.number, title: item.title, url: item.url, headSha: item.headSha }
            }
        ];
    });
}

/** The "agent.done" event of an agent session in a worktree. */
export function agentDoneEvent(
    session: { id: string; worktreePath?: string },
    update: { at: number; message?: string },
    places: readonly WorktreePlace[],
    summaries: Record<string, Record<string, BranchSummary>>
): AutomationEvent | undefined {
    const place = places.find(item => item.worktree.path === session.worktreePath);
    if (!place || place.worktree.isMain) return undefined;
    const branch = place.worktree.branch;
    const summary = branch ? summaries[place.repo]?.[branch] : undefined;
    return {
        trigger: 'agent.done',
        key: `done:${session.id}:${update.at}`,
        target: `wt:${place.worktree.path}`,
        label: branch ?? place.worktree.path,
        at: update.at,
        repoPath: place.repo,
        worktreePath: place.worktree.path,
        branch,
        sessionId: session.id,
        hasPullRequest: !!summary,
        ...(summary ? { pr: prOf(summary) } : {}),
        ...(update.message ? { agentMessage: update.message } : {})
    };
}

/** The key and the target of a task. A task starts one run only, also after a restart. */
export function taskKey(connectionId: string, taskId: string): string {
    return `task:${connectionId}:${taskId}`;
}

/** The "task.new" event of a task. */
export function taskEvent(task: Task, connectionId: string, pluginId: string, repoPath: string | undefined, at: number): AutomationEvent {
    const key = taskKey(connectionId, task.id);
    return {
        trigger: 'task.new',
        key,
        target: key,
        label: task.key ? `${task.key} ${task.title}` : task.title,
        at,
        ...(repoPath ? { repoPath } : {}),
        task,
        connectionId,
        pluginId
    };
}
