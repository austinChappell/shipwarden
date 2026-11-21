import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    agentDoneEvent,
    agentNeedsInputEvent,
    NeedsInputTimers,
    type AgentWait,
    ciFailedEvents,
    closedPullRequests,
    commentEvents,
    conflictEvents,
    manualScheduleEvent,
    manualTaskEvent,
    manualWorktreeEvent,
    mergeCandidates,
    mergedEvent,
    mergedPullRequestOf,
    overlapEvents,
    pullRequestResolver,
    taskEvent,
    worktreeOnBranch,
    type WorktreePlace
} from './automation-events';
import { branchName, manualTarget } from './automations';
import type { MyPullRequestItem, PullRequestCommentItem } from './dashboard';
import type { BranchSummary } from './github';
import { findOverlaps } from './worktree-overlap';

const places: WorktreePlace[] = [
    { repo: '/repo', worktree: { path: '/repo', branch: 'main', isMain: true } },
    { repo: '/repo', worktree: { path: '/wt/feature', branch: 'feature', isMain: false } }
];

function summary(change: Partial<BranchSummary> = {}): BranchSummary {
    return {
        number: 7,
        title: 'Add login',
        url: 'https://github.com/o/r/pull/7',
        headSha: 'abc',
        isDraft: false,
        reviewDecision: null,
        checks: 'PENDING',
        ...change
    };
}

const repo = { owner: 'o', name: 'r' };
const resolve = pullRequestResolver({ '/repo': repo, '/other': null }, { '/repo': { feature: summary() } }, places);

describe('worktreeOnBranch', () => {
    it('finds the worktree of a branch, but not the main worktree', () => {
        expect(worktreeOnBranch(places, '/repo', 'feature')?.worktree.path).toBe('/wt/feature');
        expect(worktreeOnBranch(places, '/repo', 'main')).toBeUndefined();
        expect(worktreeOnBranch(places, '/repo', undefined)).toBeUndefined();
    });
});

describe('ciFailedEvents', () => {
    it('makes an event when the checks of a worktree branch fail', () => {
        const events = ciFailedEvents('/repo', { feature: summary() }, { feature: summary({ checks: 'FAILURE' }) }, places, 5);
        expect(events).toEqual([
            expect.objectContaining({
                trigger: 'ci.failed',
                key: 'ci:/repo#7@abc',
                target: 'pr:/repo#7',
                worktreePath: '/wt/feature',
                branch: 'feature',
                pr: { number: 7, title: 'Add login', url: 'https://github.com/o/r/pull/7', headSha: 'abc', isDraft: false }
            })
        ]);
    });

    it('makes no event for passed checks, the first load or a branch without a worktree', () => {
        expect(ciFailedEvents('/repo', { feature: summary() }, { feature: summary({ checks: 'SUCCESS' }) }, places, 5)).toEqual([]);
        expect(ciFailedEvents('/repo', undefined, { feature: summary({ checks: 'FAILURE' }) }, places, 5)).toEqual([]);
        expect(ciFailedEvents('/repo', { other: summary() }, { other: summary({ checks: 'FAILURE' }) }, places, 5)).toEqual([]);
    });
});

describe('closedPullRequests and mergedEvent', () => {
    it('finds the pull requests of worktree branches that left the open list', () => {
        const closed = closedPullRequests('/repo', { feature: summary(), gone: summary({ number: 9 }) }, {}, places);
        expect(closed.map(item => item.branch)).toEqual(['feature']);
        expect(closedPullRequests('/repo', { feature: summary() }, { feature: summary() }, places)).toEqual([]);
        const event = mergedEvent('/repo', 'feature', closed[0].summary, closed[0].place, 1);
        expect(event).toMatchObject({ trigger: 'pr.merged', key: 'merged:/repo#7', worktreePath: '/wt/feature' });
    });
});

describe('mergeCandidates and mergedPullRequestOf', () => {
    const place = (path: string, branch: string | undefined, change: { isMain?: boolean; locked?: boolean } = {}) => ({
        repo: '/repo',
        worktree: { path, branch, isMain: false, locked: false, ...change }
    });

    it('leaves out the main worktree, a locked worktree, a detached HEAD and a branch with an open pull request', () => {
        const all = [
            place('/repo', 'main', { isMain: true }),
            place('/wt/locked', 'locked', { locked: true }),
            place('/wt/detached', undefined),
            place('/wt/open', 'open'),
            place('/wt/done', 'done')
        ];
        expect(mergeCandidates(all, { '/repo': { open: summary() } }).map(item => item.worktree.path)).toEqual(['/wt/done']);
    });

    it('gives the merged pull request only when the HEAD of the worktree is its head commit', () => {
        const merged = { done: { number: 4, headSha: 'abc' } };
        expect(mergedPullRequestOf({ branch: 'done', head: 'abc' }, merged)).toEqual({ number: 4, headSha: 'abc' });
        expect(mergedPullRequestOf({ branch: 'done', head: 'newer' }, merged)).toBeUndefined();
        expect(mergedPullRequestOf({ branch: 'other', head: 'abc' }, merged)).toBeUndefined();
        expect(mergedPullRequestOf({ branch: undefined, head: 'abc' }, merged)).toBeUndefined();
    });
});

describe('commentEvents', () => {
    const comment: PullRequestCommentItem = {
        id: 'C1',
        repo,
        number: 7,
        prTitle: 'Add login',
        prUrl: 'u',
        author: 'sam',
        text: 'Rename this.',
        html: '',
        createdAt: '',
        url: 'u#c1',
        path: 'a.ts'
    };

    it('makes an event for a comment on a pull request of a worktree branch', () => {
        expect(commentEvents([comment], resolve, 1)).toEqual([
            expect.objectContaining({
                trigger: 'pr.comment',
                key: 'comment:C1',
                target: 'pr:/repo#7',
                worktreePath: '/wt/feature',
                comment: { id: 'C1', author: 'sam', body: 'Rename this.', url: 'u#c1', path: 'a.ts' }
            })
        ]);
    });

    it('skips approvals, closed pull requests and other repositories', () => {
        expect(commentEvents([{ ...comment, reviewState: 'APPROVED' }], resolve, 1)).toEqual([]);
        expect(commentEvents([{ ...comment, prState: 'MERGED' }], resolve, 1)).toEqual([]);
        expect(commentEvents([{ ...comment, repo: { owner: 'x', name: 'y' } }], resolve, 1)).toEqual([]);
        expect(commentEvents([{ ...comment, number: 8 }], resolve, 1)).toEqual([]);
    });
});

describe('conflictEvents', () => {
    it('makes an event for a pull request with merge conflicts, keyed by its head commit', () => {
        const item: MyPullRequestItem = { repo, number: 7, title: 'Add login', url: 'u', updatedAt: '', reasons: ['conflicts'], headSha: 'def' };
        expect(conflictEvents([item], resolve, 1)).toEqual([expect.objectContaining({ trigger: 'pr.conflict', key: 'conflict:/repo#7@def' })]);
        expect(conflictEvents([{ ...item, reasons: ['ci-failing'] }], resolve, 1)).toEqual([]);
    });
});

describe('agentDoneEvent', () => {
    it('tells whether the branch has a pull request', () => {
        const event = agentDoneEvent({ id: 's1', worktreePath: '/wt/feature' }, { at: 3, message: 'Done.' }, places, {});
        expect(event).toMatchObject({ trigger: 'agent.done', key: 'done:s1:3', target: 'wt:/wt/feature', hasPullRequest: false, agentMessage: 'Done.' });
        const withPr = agentDoneEvent({ id: 's1', worktreePath: '/wt/feature' }, { at: 4 }, places, { '/repo': { feature: summary() } });
        expect(withPr?.hasPullRequest).toBe(true);
    });

    it('ignores the main worktree and unknown folders', () => {
        expect(agentDoneEvent({ id: 's1', worktreePath: '/repo' }, { at: 3 }, places, {})).toBeUndefined();
        expect(agentDoneEvent({ id: 's1', worktreePath: '/x' }, { at: 3 }, places, {})).toBeUndefined();
    });
});

describe('agentNeedsInputEvent', () => {
    it('keys the event by the session, the start of the wait, and the wait time', () => {
        const event = agentNeedsInputEvent(
            { id: 's1', worktreePath: '/wt/feature' },
            { since: 1000, waitFor: 'permission', message: 'Bash: npm test' },
            10,
            places,
            { '/repo': { feature: summary() } }
        );
        expect(event).toMatchObject({
            trigger: 'agent.needsInput',
            key: 'needs-input:s1:1000:10',
            target: 'wt:/wt/feature',
            label: 'feature',
            at: 1000 + 10 * 60_000,
            sessionId: 's1',
            hasPullRequest: true,
            agentWaitFor: 'permission',
            agentWaitMinutes: 10,
            agentMessage: 'Bash: npm test',
            pr: { number: 7 }
        });
    });

    it('uses "input" when the hook does not tell why the agent waits', () => {
        expect(agentNeedsInputEvent({ id: 's1', worktreePath: '/wt/feature' }, { since: 1 }, 0, places, {})?.agentWaitFor).toBe('input');
    });

    it('ignores the main worktree and unknown folders', () => {
        expect(agentNeedsInputEvent({ id: 's1', worktreePath: '/repo' }, { since: 1 }, 0, places, {})).toBeUndefined();
        expect(agentNeedsInputEvent({ id: 's1', worktreePath: '/x' }, { since: 1 }, 0, places, {})).toBeUndefined();
    });
});

describe('NeedsInputTimers', () => {
    let due: [AgentWait, number][];
    let timers: NeedsInputTimers;
    const waiting = (at: number, message?: string) => ({ state: 'waiting' as const, at, waitFor: 'question' as const, message });

    beforeEach(() => {
        vi.useFakeTimers();
        due = [];
        timers = new NeedsInputTimers((wait, idleFor) => due.push([wait, idleFor]));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs a wait time of 0 at once', () => {
        timers.onState('s1', waiting(5, 'Which file?'), [0]);
        expect(due).toEqual([[{ sessionId: 's1', since: 5, waitFor: 'question', message: 'Which file?' }, 0]]);
    });

    it('runs after the wait time when the agent still waits', () => {
        timers.onState('s1', waiting(5), [10]);
        vi.advanceTimersByTime(10 * 60_000 - 1);
        expect(due).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(due).toEqual([[expect.objectContaining({ sessionId: 's1', since: 5 }), 10]]);
    });

    it('cancels the timer when the agent stops waiting before the time ends', () => {
        timers.onState('s1', waiting(5), [10]);
        vi.advanceTimersByTime(5 * 60_000);
        timers.onState('s1', { state: 'working', at: 6 }, [10]);
        vi.advanceTimersByTime(60 * 60_000);
        expect(due).toEqual([]);
        expect(timers.waiting()).toEqual([]);
    });

    it('starts a new wait after the agent works again', () => {
        timers.onState('s1', waiting(5), [10]);
        timers.onState('s1', { state: 'working', at: 6 }, [10]);
        timers.onState('s1', waiting(7), [10]);
        vi.advanceTimersByTime(10 * 60_000);
        expect(due).toEqual([[expect.objectContaining({ since: 7 }), 10]]);
    });

    it('keeps the first timer when the agent sends a second "waiting" state, and uses the new message', () => {
        timers.onState('s1', waiting(5, 'First'), [10]);
        vi.advanceTimersByTime(4 * 60_000);
        timers.onState('s1', waiting(6, 'Second'), [10]);
        vi.advanceTimersByTime(6 * 60_000);
        expect(due).toEqual([[expect.objectContaining({ since: 5, message: 'Second' }), 10]]);
    });

    it('runs one time for each wait time', () => {
        timers.onState('s1', waiting(5), [10, 0, 10, 3]);
        vi.advanceTimersByTime(10 * 60_000);
        expect(due.map(([, idleFor]) => idleFor)).toEqual([0, 3, 10]);
    });

    it('keeps the sessions apart', () => {
        timers.onState('s1', waiting(5), [10]);
        timers.onState('s2', waiting(5), [10]);
        timers.onState('s1', { state: 'done', at: 6 }, [10]);
        vi.advanceTimersByTime(10 * 60_000);
        expect(due.map(([wait]) => wait.sessionId)).toEqual(['s2']);
    });

    it('does nothing without an active automation', () => {
        timers.onState('s1', waiting(5), []);
        expect(timers.waiting()).toEqual([]);
    });

    it('cancels the timers of a session on request', () => {
        timers.onState('s1', waiting(5), [10]);
        timers.cancel('s1');
        vi.advanceTimersByTime(10 * 60_000);
        expect(due).toEqual([]);
    });
});

describe('taskEvent', () => {
    it('uses the task as the key and the target', () => {
        const event = taskEvent({ id: 't1', key: 'ENG-1', title: 'Fix', status: { id: 's', name: 'To do', category: 'todo' } }, 'c1', 'clickup', '/repo', 1);
        expect(event).toMatchObject({
            key: 'task:c1:t1',
            target: 'task:c1:t1',
            label: 'ENG-1 Fix',
            connectionId: 'c1',
            pluginId: 'clickup',
            repoPath: '/repo'
        });
    });
});

describe('manual events', () => {
    const task = { id: 't1', key: 'ENG-1', title: 'Fix', status: { id: 's', name: 'To do', category: 'todo' as const } };

    it('makes a worktree event with the pull request of the branch', () => {
        const event = manualWorktreeEvent('fix-ci', 'ci.failed', places[1], summary(), 5);
        expect(event).toMatchObject({
            trigger: 'ci.failed',
            key: 'manual:fix-ci:5',
            target: 'manual:/wt/feature',
            label: '#7 Add login',
            repoPath: '/repo',
            worktreePath: '/wt/feature',
            branch: 'feature',
            hasPullRequest: true,
            manual: true,
            pr: { number: 7, headSha: 'abc' }
        });
    });

    it('makes a worktree event without a pull request', () => {
        const event = manualWorktreeEvent('done', 'agent.done', places[1], undefined, 5);
        expect(event).toMatchObject({ label: 'feature', hasPullRequest: false, manual: true });
        expect(event.pr).toBeUndefined();
    });

    it('gives each manual run a new key, and does not use the target of the automatic limit', () => {
        const event = manualTaskEvent('tasks', task, 'c1', 'clickup', '/repo', 9);
        expect(event).toMatchObject({ key: 'manual:tasks:9', target: 'manual:task:c1:t1', label: 'ENG-1 Fix', task, manual: true });
        expect(manualTaskEvent('tasks', task, 'c1', 'clickup', '/repo', 10).key).not.toBe(event.key);
    });

    it('makes a schedule event for the time now', () => {
        const at = new Date(2026, 10, 10, 8, 5).getTime();
        expect(manualScheduleEvent('daily', '/repo', at)).toMatchObject({
            trigger: 'schedule',
            key: `manual:daily:${at}`,
            label: '2026-11-10 08:05',
            time: '08:05',
            repoPath: '/repo',
            worktreePath: '/repo',
            manual: true
        });
        expect(manualScheduleEvent('daily', undefined, at).repoPath).toBeUndefined();
    });

    it('selects the target by the trigger', () => {
        expect(manualTarget({ type: 'pr.comment' })).toBe('worktree');
        expect(manualTarget({ type: 'agent.done' })).toBe('worktree');
        expect(manualTarget({ type: 'task.new' })).toBe('task');
        expect(manualTarget({ type: 'schedule', days: [1], time: '08:00' })).toBe('none');
    });
});

describe('branchName', () => {
    it('replaces characters that git does not accept', () => {
        expect(branchName('automation/daily summary-2026-11-10-0800')).toBe('automation/daily-summary-2026-11-10-0800');
        expect(branchName(' ../a:b..c// ')).toBe('a-b.c');
        expect(branchName('???')).toBe('automation');
    });
});

describe('overlapEvents', () => {
    const overlapPlaces: WorktreePlace[] = [
        ...places,
        { repo: '/repo', worktree: { path: '/wt/fix', branch: 'fix', isMain: false } },
        { repo: '/repo', worktree: { path: '/wt/docs', branch: 'docs', isMain: false } }
    ];
    const files = [
        { path: '/wt/feature', branch: 'feature', files: ['src/a.ts', 'src/b.ts'] },
        { path: '/wt/fix', branch: 'fix', files: ['src/a.ts'] },
        { path: '/wt/docs', branch: 'docs', files: ['README.md'] }
    ];

    it('makes one event for each worktree with an overlap', () => {
        const events = overlapEvents('/repo', findOverlaps(files), overlapPlaces, 5);
        expect(events.map(event => event.worktreePath).sort()).toEqual(['/wt/feature', '/wt/fix']);
        expect(events.find(event => event.worktreePath === '/wt/feature')).toMatchObject({
            trigger: 'worktree.overlap',
            target: 'wt:/wt/feature',
            label: 'feature: 1 file also in fix',
            at: 5,
            repoPath: '/repo',
            branch: 'feature',
            overlap: { files: ['src/a.ts'], worktrees: ['fix'] }
        });
    });

    it('keeps the key for the same overlap and changes it for a new shared file', () => {
        const key = (list: typeof files) =>
            overlapEvents('/repo', findOverlaps(list), overlapPlaces, 5).find(event => event.worktreePath === '/wt/feature')?.key;
        const first = key(files);
        expect(first).toMatch(/^overlap:\/repo:\/wt\/feature@/);
        expect(key([...files].reverse())).toBe(first);
        expect(key([files[0], { ...files[1], files: ['src/a.ts', 'src/b.ts'] }, files[2]])).not.toBe(first);
    });

    it('skips a worktree that is not in the places, and the main worktree', () => {
        const list = [
            { path: '/repo', branch: 'main', files: ['src/a.ts'] },
            { path: '/wt/gone', branch: 'gone', files: ['src/a.ts'] }
        ];
        expect(overlapEvents('/repo', findOverlaps(list), overlapPlaces, 5)).toEqual([]);
    });

    it('keeps at most 50 files and tells how many more there are', () => {
        const many = Array.from({ length: 60 }, (_, index) => `f${String(index).padStart(2, '0')}`);
        const list = [
            { path: '/wt/feature', branch: 'feature', files: many },
            { path: '/wt/fix', branch: 'fix', files: many }
        ];
        const [event] = overlapEvents('/repo', findOverlaps(list), overlapPlaces, 5);
        expect(event.overlap?.files).toHaveLength(51);
        expect(event.overlap?.files.at(-1)).toBe('(and 10 more)');
        expect(event.label).toBe('feature: 60 files also in fix');
    });
});
