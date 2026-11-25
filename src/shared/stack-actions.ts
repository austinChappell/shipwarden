import type { GitChanges, RebaseResult } from './git';
import type { MergeMethod, PullRequest } from './github';
import type { PlanStep } from './plans';
import { restackOldBases } from './plans';

/**
 * Stack actions of a plan PR group: "Rebase stack" and "Merge stack". A plan stacks its steps: each pull request
 * targets the branch of the step before it in the same repository. These functions run the git and host calls in the
 * correct order and stop at the first problem. The caller gives the git and host calls, so the tests use fakes.
 *
 * The functions of this module use no Electron API and no browser API.
 */

/** One open pull request of the stack. */
export interface StackEntry {
    /** The ID of the plan step. */
    stepId: string;
    /** The key of the pull request, for example "octo/app#12" (see `prKey`). */
    key: string;
    number: number;
    url: string;
    /** The root folder of the main worktree of the repository. */
    repo: string;
    /** The head branch of the pull request. */
    branch: string;
    /** The target branch of the pull request now. */
    base: string;
    /**
     * The branch that the rebase moves the branch onto. It is the same as `base`, except when the pull request below
     * merged and the pull request still targets the merged branch. Then it is the base of the merged pull request.
     */
    onto: string;
    /** The worktree of the branch on this Mac. Undefined: the branch has no worktree, so it cannot rebase. */
    worktreePath?: string;
    /** The commits of the old base for "git rebase --onto". Empty: a usual rebase. */
    oldBases: string[];
    /** True when the plan rebased the branch after a merge below it, and the rebase is not pushed yet. */
    restackWaiting?: boolean;
}

/** The state of one pull request in a stack run. */
export type StackItemStatus = 'working' | 'done' | 'skipped' | 'stopped';

export interface StackItemState {
    status: StackItemStatus;
    /** A short text for the row, for example "Rebased and pushed". */
    text: string;
}

/** The result of a stack run. */
export type StackRunResult =
    | { status: 'done'; text: string }
    /**
     * The run stopped at the pull request with `key`. "conflict": a rebase stopped on a conflict and is still in
     * progress in the worktree. "blocked": the pull request is not ready. "error": a git or host call failed.
     */
    | { status: 'stopped'; key: string; reason: 'conflict' | 'blocked' | 'error'; text: string };

/** Tells the caller the new state of one pull request. */
export type StackProgress = (key: string, state: StackItemState) => void;

/** A short name of a pull request for the messages, for example "#12 (feature-a)". */
export function entryLabel(entry: Pick<StackEntry, 'number' | 'branch'>): string {
    return `#${entry.number} (${entry.branch})`;
}

/** A full or short commit hash. The rebase refuses other old bases. */
const COMMIT_HASH = /^[0-9a-f]{7,64}$/i;

/** Returns the text of an error. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The key of a branch in a repository. */
function branchKey(repo: string, branch: string): string {
    return `${repo}\0${branch}`;
}

/**
 * Returns the open pull requests of the plan as a stack, the bottom first. A parent always comes before its children.
 * Else the order of the steps applies. `isMerged` tells when a pull request merged or closed, from the cache. A step
 * whose pull request merged is not in the stack, and the steps above it get the base of the merged pull request in
 * `onto`. `mergedHead` returns the head commit of a merged pull request, when the cache knows it.
 */
export function stackEntries(
    steps: readonly PlanStep[],
    keyOf: (step: PlanStep) => string | undefined,
    isMerged: (step: PlanStep) => boolean,
    mergedHead: (step: PlanStep) => string | undefined = () => undefined
): StackEntry[] {
    const withPr = steps.filter(step => step.pr && step.branch && step.repo && !step.skip);
    const merged = (step: PlanStep) => !!step.mergedAt || isMerged(step);
    const byBranch = new Map(withPr.map(step => [branchKey(step.repo as string, step.branch as string), step]));
    const entries: StackEntry[] = [];
    for (const step of withPr) {
        if (merged(step)) continue;
        const key = keyOf(step);
        const pr = step.pr;
        if (!key || !pr || !step.branch || !step.repo) continue;
        // Go down past the merged pull requests. Their commits are in the base of the lowest merged pull request.
        let onto = pr.base;
        const oldBases = [...(step.restack?.oldBases ?? []), ...restackOldBases(step, undefined)];
        const seen = new Set<string>();
        for (let parent = byBranch.get(branchKey(step.repo, onto)); parent?.pr && merged(parent); parent = byBranch.get(branchKey(step.repo, onto))) {
            if (seen.has(parent.id)) break;
            seen.add(parent.id);
            onto = parent.pr.base;
        }
        // The heads of the merged pull requests of the earlier steps of the repository. After a squash merge, the
        // branch still has these commits, also when its pull request has the new base already. Git uses the newest
        // one that the branch contains.
        for (const earlier of withPr.slice(0, withPr.indexOf(step))) {
            if (earlier.repo !== step.repo || !merged(earlier)) continue;
            const head = mergedHead(earlier);
            if (head) oldBases.push(head);
        }
        entries.push({
            stepId: step.id,
            key,
            number: pr.number,
            url: pr.url,
            repo: step.repo,
            branch: step.branch,
            base: pr.base,
            onto,
            ...(step.worktreePath ? { worktreePath: step.worktreePath } : {}),
            oldBases: [...new Set(oldBases)],
            ...(step.restack ? { restackWaiting: true } : {})
        });
    }
    return parentsFirst(entries);
}

/** Returns the entries in the same order, but each parent moves before its children. */
export function parentsFirst(entries: readonly StackEntry[]): StackEntry[] {
    const byBranch = new Map(entries.map(entry => [branchKey(entry.repo, entry.branch), entry]));
    const result: StackEntry[] = [];
    const placed = new Set<StackEntry>();
    const visiting = new Set<StackEntry>();
    const place = (entry: StackEntry) => {
        if (placed.has(entry) || visiting.has(entry)) return;
        visiting.add(entry);
        const parent = byBranch.get(branchKey(entry.repo, entry.onto));
        if (parent) place(parent);
        visiting.delete(entry);
        placed.add(entry);
        result.push(entry);
    };
    for (const entry of entries) place(entry);
    return result;
}

/** The entry of the branch that the entry stacks on, or undefined for the bottom of a stack. */
function parentOf(entries: readonly StackEntry[], entry: StackEntry): StackEntry | undefined {
    return entries.find(item => item !== entry && item.repo === entry.repo && item.branch === entry.onto);
}

/** The lines of the confirm dialog: one line for each pull request, for example "1. #12 feature-a → main". */
export function stackLines(entries: readonly StackEntry[]): string {
    return entries.map((entry, index) => `${index + 1}. #${entry.number}  ${entry.branch} → ${entry.onto}`).join('\n');
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Rebase stack                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The git calls of "Rebase stack". */
export interface StackGit {
    /** Fetches "origin" and rebases the branch onto "origin/<onto>". See `api.git.rebase`. */
    rebase(worktree: string, onto: string, oldBases: string[]): Promise<RebaseResult>;
    changes(worktree: string): Promise<Pick<GitChanges, 'upstream' | 'ahead'>>;
    /** Pushes the branch with "--force-with-lease". */
    pushWithLease(worktree: string): Promise<void>;
}

export interface RebaseStackOptions {
    git: StackGit;
    /** Returns why the branch cannot rebase now, for example an agent that works in the worktree. */
    busyReason?(entry: StackEntry): string | undefined;
    /** Changes the base of the pull request to `onto`, when `onto` is not its base. */
    retarget?(entry: StackEntry, base: string): Promise<void>;
    /** The head commit of the branch on the host before the run. The children use it as their old base. */
    headBefore?(entry: StackEntry): string | undefined;
    progress: StackProgress;
}

/**
 * Rebases each branch of the stack onto its parent, the bottom first, and pushes it with "--force-with-lease". The
 * bottom branch moves onto its base branch. Each child then moves onto the pushed branch of its parent with
 * "git rebase --onto", so only the commits of the child move.
 *
 * The run stops at the first problem. A conflict stops the run, and the rebase stays in progress in the worktree of
 * that branch. The user or the agent of the worktree resolves it. The branches below it are rebased and pushed. The
 * branches above it do not change.
 */
export async function rebaseStack(entries: readonly StackEntry[], options: RebaseStackOptions): Promise<StackRunResult> {
    const { git, progress } = options;
    let rebased = 0;
    for (const entry of entries) {
        const label = entryLabel(entry);
        const stop = (reason: 'conflict' | 'blocked' | 'error', text: string): StackRunResult => {
            progress(entry.key, { status: 'stopped', text });
            return { status: 'stopped', key: entry.key, reason, text: `The rebase of the stack stopped at ${label}. ${text}` };
        };
        if (!entry.worktreePath) return stop('blocked', 'The branch has no worktree on this Mac.');
        const busy = options.busyReason?.(entry);
        if (busy) return stop('blocked', busy);
        const parent = parentOf(entries, entry);
        const parentHead = parent ? options.headBefore?.(parent) : undefined;
        const oldBases = [...new Set([...entry.oldBases, ...(parentHead ? [parentHead] : [])])].filter(commit => COMMIT_HASH.test(commit));
        progress(entry.key, { status: 'working', text: `Rebasing onto ${entry.onto}` });
        let result: RebaseResult;
        try {
            result = await git.rebase(entry.worktreePath, entry.onto, oldBases);
        } catch (error) {
            return stop('error', `The rebase did not start: ${errorText(error)}`);
        }
        if (result.status === 'conflict') {
            return stop(
                'conflict',
                `The rebase onto ${entry.onto} stopped on a conflict. The rebase is still in progress in ${entry.worktreePath}. Resolve the conflict, push the branch, then select "Rebase stack" again.`
            );
        }
        let pushed = false;
        try {
            const changes = await git.changes(entry.worktreePath);
            if (!changes.upstream) return stop('error', 'The branch is rebased, but it has no upstream branch. Push it from the Changes tab.');
            if (changes.ahead > 0) {
                progress(entry.key, { status: 'working', text: 'Pushing with --force-with-lease' });
                await git.pushWithLease(entry.worktreePath);
                pushed = true;
            }
        } catch (error) {
            return stop('error', `The branch is rebased, but the push failed: ${errorText(error)}`);
        }
        if (entry.onto !== entry.base && options.retarget) {
            try {
                await options.retarget(entry, entry.onto);
            } catch (error) {
                return stop('error', `The branch is rebased, but the base of the pull request did not change to ${entry.onto}: ${errorText(error)}`);
            }
        }
        if (pushed) rebased++;
        progress(entry.key, { status: 'done', text: pushed ? 'Rebased and pushed' : 'Up to date' });
    }
    return {
        status: 'done',
        text: rebased === 0 ? 'All branches of the stack are up to date.' : `ShipWarden rebased and pushed ${rebased} of ${entries.length} branches.`
    };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Merge stack                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The host calls of "Merge stack". The review provider of the repository makes them. */
export interface StackHost {
    /** Loads the pull request from the host, not from the cache. */
    load(entry: StackEntry): Promise<PullRequest>;
    merge(entry: StackEntry, pr: PullRequest, method: MergeMethod): Promise<void>;
    /** Points the pull request at a different base branch. */
    retarget(entry: StackEntry, base: string): Promise<void>;
    /** Waits `ms` milliseconds. */
    wait(ms: number): Promise<void>;
}

export interface MergeStackOptions {
    host: StackHost;
    /** Returns why the pull request cannot merge now, or undefined when it is ready. */
    blocker(pr: PullRequest): string | undefined;
    /** The merge method for the pull request: the setting of the repository. Undefined: no method is allowed. */
    method(pr: PullRequest): MergeMethod | undefined;
    progress: StackProgress;
}

/** The time between two loads while the host checks whether a pull request can merge. */
export const MERGE_STATE_WAIT_MS = 3_000;
/** The most loads while the host checks whether a pull request can merge. */
export const MERGE_STATE_TRIES = 3;

const METHOD_NAMES: Record<MergeMethod, string> = { merge: 'a merge commit', squash: 'squash', rebase: 'rebase' };

/** The result of "Merge stack", with the merged pull requests. */
export type MergeStackResult = StackRunResult & { merged: { entry: StackEntry; pr: PullRequest }[] };

/**
 * Merges the pull requests of the stack, the bottom first. It merges only the pull requests that are ready, and it
 * stops at the first one that is not ready. It does not wait for checks.
 *
 * After each merge, the pull requests that target the merged branch get the base of the merged pull request. After a
 * squash or a rebase merge, the branch above has the old commits of the merged branch. Then the run stops at that pull
 * request: the branch needs a rebase first ("Rebase stack"), and the checks must run again.
 */
export async function mergeStack(entries: readonly StackEntry[], options: MergeStackOptions): Promise<MergeStackResult> {
    const { host, progress } = options;
    // The merged branches of the run and of earlier merges: their base, and the merge method of this run.
    const mergedBranches = new Map<string, { base: string; number: number; method?: MergeMethod }>();
    const merged: MergeStackResult['merged'] = [];
    for (const [index, entry] of entries.entries()) {
        const label = entryLabel(entry);
        const stop = (reason: 'blocked' | 'error', text: string): MergeStackResult => {
            progress(entry.key, { status: 'stopped', text });
            const done = merged.length > 0 ? ` ShipWarden merged ${merged.length} of ${entries.length} pull requests.` : '';
            return { status: 'stopped', key: entry.key, reason, text: `The merge of the stack stopped at ${label}. ${text}${done}`, merged };
        };
        progress(entry.key, { status: 'working', text: 'Checking' });
        try {
            let pr = await host.load(entry);
            if (pr.state === 'MERGED') {
                mergedBranches.set(branchKey(entry.repo, entry.branch), { base: pr.baseRefName, number: pr.number });
                progress(entry.key, { status: 'skipped', text: 'Merged before' });
                continue;
            }
            if (pr.state !== 'OPEN') return stop('blocked', 'The pull request is closed.');
            if (entry.restackWaiting) return stop('blocked', 'The branch has a rebase that is not pushed. Push it, or select "Rebase stack" first.');
            const parent = mergedBranches.get(branchKey(entry.repo, pr.baseRefName));
            if (parent) {
                // The host can change the base itself when it deletes the merged branch. Else ShipWarden changes it.
                progress(entry.key, { status: 'working', text: `Changing the base to ${parent.base}` });
                await host.retarget(entry, parent.base);
                pr = await host.load(entry);
            } else if (entry.onto !== entry.base && pr.baseRefName === entry.base) {
                // The pull request below merged before the run, and this pull request still targets the merged branch.
                return stop(
                    'blocked',
                    `The pull request targets ${entry.base}, which merged. Select "Rebase stack" first. It also changes the base to ${entry.onto}.`
                );
            }
            const before = parent ?? mergedBranches.get(branchKey(entry.repo, entry.base));
            const rewritten = before?.method && before.method !== 'merge' ? before : undefined;
            if (rewritten) {
                return stop(
                    'blocked',
                    `#${rewritten.number} merged with ${METHOD_NAMES[rewritten.method as MergeMethod]}, so the branch still has the old commits of #${rewritten.number}. Select "Rebase stack", wait for the checks, then select "Merge stack" again.`
                );
            }
            for (let tries = 1; pr.mergeable === 'UNKNOWN' && tries < MERGE_STATE_TRIES; tries++) {
                await host.wait(MERGE_STATE_WAIT_MS);
                pr = await host.load(entry);
            }
            const blocker = options.blocker(pr);
            if (blocker) return stop('blocked', blocker);
            const method = options.method(pr);
            if (!method) return stop('blocked', 'The repository allows no merge method.');
            progress(entry.key, { status: 'working', text: 'Merging' });
            await host.merge(entry, pr, method);
            merged.push({ entry, pr });
            mergedBranches.set(branchKey(entry.repo, entry.branch), { base: pr.baseRefName, number: pr.number, method });
            progress(entry.key, { status: 'done', text: 'Merged' });
            // The next pull requests target the merged branch. They get its base now, also when the run stops before them.
            // A failed change is not a stop: the run tries it again when it gets to the child.
            for (const child of entries.slice(index + 1)) {
                if (child.repo !== entry.repo || child.base !== entry.branch) continue;
                await host.retarget(child, pr.baseRefName).catch(() => undefined);
            }
        } catch (error) {
            return stop('error', errorText(error));
        }
    }
    return {
        status: 'done',
        text: merged.length === 0 ? 'All pull requests of the stack merged before.' : `ShipWarden merged ${merged.length} of ${entries.length} pull requests.`,
        merged
    };
}
