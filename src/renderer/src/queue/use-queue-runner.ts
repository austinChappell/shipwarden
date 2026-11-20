import { useCallback, useEffect, useMemo } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { BranchSummary } from '@shared/github';
import type { TerminalSession } from '@shared/terminal';
import { branchSummariesQuery, summariesByRepo } from '../github/use-branch-status';
import { queueRunner, type QueueRunnerActions } from './queue-runner';
import { useTaskQueue } from './queue-queries';

/** The runner checks the running items at this interval. It finds the idle agents and the new pull requests. */
const TICK_MS = 30_000;

interface Options {
    settingsLoaded: boolean;
    sessions: TerminalSession[];
    /** The branch summaries of the active project. They load already. */
    summaries: Record<string, Record<string, BranchSummary>>;
    actions: QueueRunnerActions;
}

/**
 * Runs the task queue while the app is open. It gives the runner the state of the app and a timer.
 * In the "pull request" mode, it loads the branch summaries of the repositories with a running item that are not in the
 * active project. The summaries use the same cache as the rest of the app, so a repository loads one time.
 */
export function useQueueRunner(options: Options): void {
    const { state, loaded } = useTaskQueue();
    const watchesPullRequests = state.settings.finishWhen === 'pullRequest';
    const extraKey = watchesPullRequests
        ? [...new Set(state.items.filter(item => item.status === 'running' && !options.summaries[item.repoPath]).map(item => item.repoPath))].sort().join('\0')
        : '';
    const extraRepos = useMemo(() => (extraKey ? extraKey.split('\0') : []), [extraKey]);
    const combine = useCallback((results: UseQueryResult<Record<string, BranchSummary>>[]) => summariesByRepo(extraRepos, results), [extraRepos]);
    const extraSummaries = useQueries({ queries: extraRepos.map(branchSummariesQuery), combine });
    const summaries = useMemo(() => ({ ...extraSummaries, ...options.summaries }), [extraSummaries, options.summaries]);

    const ready = options.settingsLoaded && loaded;
    // The runner reads the newest state at each round. The state object is cheap, so it is new at each render.
    queueRunner.setContext({ ready, sessions: options.sessions, summaries, actions: options.actions });

    // A change of the queue (a new item, a new limit) or of the pull requests can start or finish items at once.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect does not read the queue and the summaries. A change of them starts a round.
    useEffect(() => {
        if (ready) void queueRunner.tick();
    }, [ready, state, summaries]);

    useEffect(() => {
        if (!ready) return;
        const timer = setInterval(() => void queueRunner.tick(), TICK_MS);
        return () => clearInterval(timer);
    }, [ready]);
}
