import { describe, expect, it } from 'vitest';
import type { RebaseResult } from './git';
import type { MergeMethod, PullRequest } from './github';
import { newStep, type PlanStep } from './plans';
import { mergeStack, parentsFirst, rebaseStack, stackEntries, stackLines, type StackEntry, type StackGit, type StackHost } from './stack-actions';

const REPO = '/repos/app';

function step(id: string, branch: string, base: string, number: number, extra: Partial<PlanStep> = {}): PlanStep {
    return {
        ...newStep(REPO),
        id,
        status: 'done',
        branch,
        worktreePath: `/wt/${branch}`,
        pr: { number, url: `https://github.com/octo/app/pull/${number}`, base },
        ...extra
    };
}

function entry(branch: string, base: string, number: number, extra: Partial<StackEntry> = {}): StackEntry {
    return {
        stepId: branch,
        key: `octo/app#${number}`,
        number,
        url: `https://github.com/octo/app/pull/${number}`,
        repo: REPO,
        branch,
        base,
        onto: base,
        worktreePath: `/wt/${branch}`,
        oldBases: [],
        ...extra
    };
}

/** A stack of three branches: a → main, b → a, c → b. */
const STACK = [entry('a', 'main', 1), entry('b', 'a', 2), entry('c', 'b', 3)];

const keyOf = (item: PlanStep) => (item.pr ? `octo/app#${item.pr.number}` : undefined);

describe('stackEntries', () => {
    it('lists the open pull requests of the plan, the bottom first', () => {
        const steps = [step('2', 'b', 'a', 2), step('1', 'a', 'main', 1), step('3', 'c', 'b', 3)];
        const entries = stackEntries(steps, keyOf, () => false);
        expect(entries.map(item => item.branch)).toEqual(['a', 'b', 'c']);
        expect(entries.map(item => item.onto)).toEqual(['main', 'a', 'b']);
    });

    it('leaves out a merged pull request, and moves the branch above it onto the base of the merged pull request', () => {
        const steps = [step('1', 'a', 'main', 1, { mergedAt: 5 }), step('2', 'b', 'a', 2, { stackBase: 'abc1234' })];
        const entries = stackEntries(
            steps,
            keyOf,
            () => false,
            () => 'def5678'
        );
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ branch: 'b', base: 'a', onto: 'main', oldBases: ['abc1234', 'def5678'] });
    });

    it('keeps the merged heads of earlier steps after the pull request got the new base', async () => {
        const steps = [step('1', 'a', 'main', 1, { mergedAt: 5 }), step('2', 'b', 'main', 2)];
        const entries = stackEntries(
            steps,
            keyOf,
            () => false,
            () => 'def5678'
        );
        expect(entries[0]).toMatchObject({ branch: 'b', onto: 'main', oldBases: ['def5678'] });
    });

    it('uses the cache to find a merge, and leaves out skipped steps and steps without a pull request', () => {
        const steps = [
            step('1', 'a', 'main', 1),
            step('2', 'b', 'a', 2),
            { ...newStep(REPO), id: '3', branch: 'x' },
            step('4', 'd', 'main', 4, { skip: true })
        ];
        const entries = stackEntries(steps, keyOf, item => item.id === '1');
        expect(entries.map(item => [item.branch, item.onto])).toEqual([['b', 'main']]);
    });

    it('marks a branch with a rebase that waits for a push', () => {
        const steps = [step('1', 'a', 'main', 1, { restack: { onto: 'main', state: 'push', merged: 9 } })];
        expect(stackEntries(steps, keyOf, () => false)[0].restackWaiting).toBe(true);
    });
});

describe('parentsFirst', () => {
    it('moves a parent before its children and keeps the order of the other entries', () => {
        const other = entry('z', 'main', 9, { repo: '/repos/web' });
        expect(parentsFirst([STACK[2], other, STACK[0], STACK[1]]).map(item => item.branch)).toEqual(['a', 'b', 'c', 'z']);
    });
});

describe('stackLines', () => {
    it('lists each pull request with its branch and target', () => {
        expect(stackLines(STACK.slice(0, 2))).toBe('1. #1  a → main\n2. #2  b → a');
    });
});

/** A fake git that records the calls. `conflictAt` stops the rebase of that worktree on a conflict. */
function fakeGit(options: { conflictAt?: string; failAt?: string; unchanged?: string[] } = {}) {
    const calls: string[] = [];
    const git: StackGit = {
        async rebase(worktree, onto, oldBases) {
            calls.push(`rebase ${worktree} ${onto} [${oldBases.join(',')}]`);
            if (worktree === options.failAt) throw new Error('The worktree has uncommitted changes.');
            if (worktree === options.conflictAt) return { status: 'conflict', state: { onto: 'f00' } } satisfies RebaseResult;
            return { status: 'done', onto: `origin/${onto}`, changed: !options.unchanged?.includes(worktree) };
        },
        async changes(worktree) {
            return { upstream: 'origin/x', ahead: options.unchanged?.includes(worktree) ? 0 : 2 };
        },
        async pushWithLease(worktree) {
            calls.push(`push ${worktree}`);
        }
    };
    return { git, calls };
}

describe('rebaseStack', () => {
    it('rebases and pushes each branch in order, the bottom first, onto its parent', async () => {
        const { git, calls } = fakeGit();
        const states: string[] = [];
        const result = await rebaseStack(STACK, {
            git,
            headBefore: item => `${item.branch}0000000`,
            progress: (key, state) => states.push(`${key} ${state.status}`)
        });
        expect(result.status).toBe('done');
        expect(calls).toEqual(['rebase /wt/a main []', 'push /wt/a', 'rebase /wt/b a [a0000000]', 'push /wt/b', 'rebase /wt/c b [b0000000]', 'push /wt/c']);
        expect(states.filter(item => item.endsWith('done'))).toEqual(['octo/app#1 done', 'octo/app#2 done', 'octo/app#3 done']);
    });

    it('stops at the first conflict, names the branch, and does not touch the branches above it', async () => {
        const { git, calls } = fakeGit({ conflictAt: '/wt/b' });
        const result = await rebaseStack(STACK, { git, progress: () => undefined });
        expect(result).toMatchObject({ status: 'stopped', key: 'octo/app#2', reason: 'conflict' });
        expect(result.text).toContain('#2 (b)');
        expect(result.text).toContain('still in progress in /wt/b');
        expect(calls).toEqual(['rebase /wt/a main []', 'push /wt/a', 'rebase /wt/b a []']);
    });

    it('stops when a rebase cannot start', async () => {
        const { git, calls } = fakeGit({ failAt: '/wt/a' });
        const result = await rebaseStack(STACK, { git, progress: () => undefined });
        expect(result).toMatchObject({ status: 'stopped', key: 'octo/app#1', reason: 'error' });
        expect(calls).toHaveLength(1);
    });

    it('stops at a branch without a worktree or with a working agent', async () => {
        const { git, calls } = fakeGit();
        const noWorktree = await rebaseStack([STACK[0], { ...STACK[1], worktreePath: undefined }], { git, progress: () => undefined });
        expect(noWorktree).toMatchObject({ status: 'stopped', key: 'octo/app#2', reason: 'blocked' });
        const busy = await rebaseStack(STACK, {
            git,
            busyReason: item => (item.branch === 'a' ? 'The agent is working.' : undefined),
            progress: () => undefined
        });
        expect(busy).toMatchObject({ status: 'stopped', key: 'octo/app#1', reason: 'blocked' });
        expect(calls).toEqual(['rebase /wt/a main []', 'push /wt/a']);
    });

    it('does not push a branch that is up to date', async () => {
        const { git, calls } = fakeGit({ unchanged: ['/wt/a', '/wt/b', '/wt/c'] });
        const result = await rebaseStack(STACK, { git, progress: () => undefined });
        expect(result).toMatchObject({ status: 'done', text: 'All branches of the stack are up to date.' });
        expect(calls.filter(call => call.startsWith('push'))).toEqual([]);
    });

    it('changes the base of a pull request whose parent merged', async () => {
        const { git } = fakeGit();
        const retargets: string[] = [];
        await rebaseStack([entry('b', 'a', 2, { onto: 'main' })], {
            git,
            retarget: async (item, base) => {
                retargets.push(`#${item.number} ${base}`);
            },
            progress: () => undefined
        });
        expect(retargets).toEqual(['#2 main']);
    });
});

function pullRequest(number: number, base: string, extra: Partial<PullRequest> = {}): PullRequest {
    return {
        number,
        state: 'OPEN',
        baseRefName: base,
        headRefOid: `head${number}`,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
        ...extra
    } as PullRequest;
}

/**
 * A fake host. It keeps the base of each pull request, and a retarget changes it. `notReady` makes a pull request not
 * ready. `unknownLoads` gives the number of loads with an UNKNOWN merge state.
 */
function fakeHost(options: { notReady?: number[]; merged?: number[]; unknownLoads?: Record<number, number> } = {}) {
    const calls: string[] = [];
    const bases = new Map<number, string>(STACK.map(item => [item.number, item.base]));
    const unknown = { ...(options.unknownLoads ?? {}) };
    const host: StackHost = {
        async load(item) {
            const pending = unknown[item.number] ?? 0;
            if (pending > 0) unknown[item.number] = pending - 1;
            return pullRequest(item.number, bases.get(item.number) ?? item.base, {
                ...(options.merged?.includes(item.number) ? { state: 'MERGED' } : {}),
                ...(options.notReady?.includes(item.number) ? { mergeStateStatus: 'BLOCKED' } : {}),
                ...(pending > 0 ? { mergeable: 'UNKNOWN' } : {})
            });
        },
        async merge(item, _pr, method) {
            calls.push(`merge #${item.number} ${method}`);
        },
        async retarget(item, base) {
            calls.push(`base #${item.number} ${base}`);
            bases.set(item.number, base);
        },
        async wait() {
            calls.push('wait');
        }
    };
    return { host, calls };
}

const blocker = (pr: PullRequest) => (pr.mergeable === 'UNKNOWN' ? 'Still checking.' : pr.mergeStateStatus === 'BLOCKED' ? 'Checks are pending.' : undefined);
const method =
    (value: MergeMethod = 'merge') =>
    () =>
        value;

describe('mergeStack', () => {
    it('merges from the bottom up and changes the base of the next pull request after each merge', async () => {
        const { host, calls } = fakeHost();
        const result = await mergeStack(STACK, { host, blocker, method: method(), progress: () => undefined });
        expect(result.status).toBe('done');
        expect(result.merged.map(item => item.entry.number)).toEqual([1, 2, 3]);
        expect(calls).toEqual(['merge #1 merge', 'base #2 main', 'merge #2 merge', 'base #3 main', 'merge #3 merge']);
    });

    it('stops at the first pull request that is not ready, after it gets the new base', async () => {
        const { host, calls } = fakeHost({ notReady: [2] });
        const states: string[] = [];
        const result = await mergeStack(STACK, { host, blocker, method: method(), progress: (key, state) => states.push(`${key} ${state.status}`) });
        expect(result).toMatchObject({ status: 'stopped', key: 'octo/app#2', reason: 'blocked' });
        expect(result.text).toContain('Checks are pending.');
        expect(result.text).toContain('merged 1 of 3');
        expect(result.merged.map(item => item.entry.number)).toEqual([1]);
        expect(calls).toEqual(['merge #1 merge', 'base #2 main']);
        expect(states).not.toContain('octo/app#3 working');
    });

    it('stops above a squash merge, because the branch needs a rebase first', async () => {
        const { host, calls } = fakeHost();
        const result = await mergeStack(STACK, { host, blocker, method: method('squash'), progress: () => undefined });
        expect(result).toMatchObject({ status: 'stopped', key: 'octo/app#2', reason: 'blocked' });
        expect(result.text).toContain('Rebase stack');
        expect(calls).toEqual(['merge #1 squash', 'base #2 main']);
    });

    it('skips a pull request that merged before, and gives its base to the next pull request', async () => {
        const { host, calls } = fakeHost({ merged: [1] });
        const result = await mergeStack(STACK, { host, blocker, method: method(), progress: () => undefined });
        expect(result.status).toBe('done');
        expect(calls).toEqual(['base #2 main', 'merge #2 merge', 'base #3 main', 'merge #3 merge']);
    });

    it('loads again while the host checks the merge state', async () => {
        const { host, calls } = fakeHost({ unknownLoads: { 1: 2 } });
        const result = await mergeStack(STACK.slice(0, 1), { host, blocker, method: method(), progress: () => undefined });
        expect(result.status).toBe('done');
        expect(calls).toEqual(['wait', 'wait', 'merge #1 merge']);
    });

    it('stops at a pull request that targets a branch that merged before the run', async () => {
        const { host, calls } = fakeHost();
        const result = await mergeStack([entry('b', 'a', 2, { onto: 'main' })], { host, blocker, method: method(), progress: () => undefined });
        expect(result).toMatchObject({ status: 'stopped', reason: 'blocked' });
        expect(calls).toEqual([]);
    });

    it('stops at a branch with a rebase that is not pushed', async () => {
        const { host, calls } = fakeHost();
        const result = await mergeStack([{ ...STACK[0], restackWaiting: true }], { host, blocker, method: method(), progress: () => undefined });
        expect(result).toMatchObject({ status: 'stopped', reason: 'blocked' });
        expect(calls).toEqual([]);
    });

    it('stops with the error of a failed merge', async () => {
        const { host } = fakeHost();
        host.merge = async () => {
            throw new Error('Head branch was modified.');
        };
        const result = await mergeStack(STACK, { host, blocker, method: method(), progress: () => undefined });
        expect(result).toMatchObject({ status: 'stopped', key: 'octo/app#1', reason: 'error' });
        expect(result.text).toContain('Head branch was modified.');
    });
});
