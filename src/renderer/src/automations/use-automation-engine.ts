import { useCallback, useEffect, useMemo } from 'react';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { isWorktreeTrigger, type Automation } from '@shared/automations';
import type { BranchSummary } from '@shared/github';
import type { AppSettings } from '@shared/settings';
import type { TaskLink } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { onDashboardNews } from '../dashboard-store';
import { branchSummariesQuery, summariesByRepo } from '../github/use-branch-status';
import { keyRoots } from '../query-client';
import { useUsage } from '../usage-query';
import { useAutomationList, useAutomationRuns } from './automation-queries';
import { automationEngine, type EngineActions, type EnginePlace } from './engine';

/** The engine checks schedules, task collections and held runs at this interval. */
const TICK_MS = 30_000;
/** The worktree lists of the other projects load again at this interval. They are local git data. */
const PLACES_MS = 60_000;

interface Options {
    settingsLoaded: boolean;
    appSettings: AppSettings;
    sessions: TerminalSession[];
    /** The repositories of all projects. */
    allRepos: string[];
    /** The repositories of the active project. Their summaries and worktrees load already. */
    activeRepos: string[];
    worktreesByRepo: Record<string, Worktree[]>;
    /** The branch summaries of the active project. */
    summaries: Record<string, Record<string, BranchSummary>>;
    links: Record<string, TaskLink>;
    actions: EngineActions;
}

/**
 * Runs the automation engine while the app is open. It gives the engine the state of the app, the events and a timer.
 * When no automation is on, it loads nothing more than the app loads already.
 */
export function useAutomationEngine(options: Options): void {
    const { list, loaded: listLoaded } = useAutomationList();
    const { loaded: runsLoaded } = useAutomationRuns();
    const usage = useUsage();
    const automations = list.automations;
    const active = useMemo(() => automations.filter(automation => automation.status !== 'off'), [automations]);
    const watchesWorktrees = active.some(automation => isWorktreeTrigger(automation.trigger.type));

    // The worktrees of all projects. An agent or a pull request of another project can start a run too.
    const repoKey = options.allRepos.join('\0');
    const otherRepos = useMemo(() => (repoKey ? repoKey.split('\0') : []).filter(repo => !options.activeRepos.includes(repo)), [repoKey, options.activeRepos]);
    const otherWorktrees = useQuery({
        queryKey: [...keyRoots.automations, 'places', ...otherRepos],
        queryFn: async () =>
            Object.fromEntries(await Promise.all(otherRepos.map(async repo => [repo, await window.shipwarden.worktrees.list(repo).catch(() => [])] as const))),
        enabled: active.length > 0 && otherRepos.length > 0,
        staleTime: PLACES_MS,
        refetchInterval: PLACES_MS
    });
    const places = useMemo<EnginePlace[]>(() => {
        const byRepo = { ...(otherWorktrees.data ?? {}), ...options.worktreesByRepo };
        return Object.entries(byRepo).flatMap(([repo, worktrees]) => worktrees.map(worktree => ({ repo, worktree })));
    }, [otherWorktrees.data, options.worktreesByRepo]);

    // The repositories to watch: the active project, the repositories with an agent, and the repositories of the
    // automations. The active project polls its summaries already. The other summaries load each minute while an
    // automation needs them. One request covers a repository.
    const sessionRepos = options.sessions
        .filter(session => session.isAgent && !session.exited)
        .map(session => places.find(place => place.worktree.path === session.worktreePath)?.repo);
    const boundRepos = active.flatMap(automation => (isWorktreeTrigger(automation.trigger.type) ? (automation.binding.repos ?? []) : []));
    const extraKey = watchesWorktrees
        ? [...new Set([...sessionRepos, ...boundRepos].filter((repo): repo is string => !!repo && !options.activeRepos.includes(repo)))].sort().join('\0')
        : '';
    const extraRepos = useMemo(() => (extraKey ? extraKey.split('\0') : []), [extraKey]);
    const combine = useCallback((results: UseQueryResult<Record<string, BranchSummary>>[]) => summariesByRepo(extraRepos, results), [extraRepos]);
    const extraSummaries = useQueries({ queries: extraRepos.map(branchSummariesQuery), combine });
    const summaries = useMemo(() => ({ ...extraSummaries, ...options.summaries }), [extraSummaries, options.summaries]);

    const ready = options.settingsLoaded && listLoaded && runsLoaded;
    // The engine reads the newest state at each event. The state object is cheap, so it is new at each render.
    automationEngine.setContext({
        ready,
        automations,
        settings: options.appSettings.automations,
        notifications: options.appSettings.notifications,
        usage,
        sessions: options.sessions,
        places,
        summaries,
        links: options.links,
        actions: options.actions
    });

    useEffect(() => {
        if (ready) automationEngine.onSummaries(summaries);
    }, [ready, summaries]);

    useEffect(() => onDashboardNews(news => void automationEngine.onDashboardNews(news)), []);

    const hasTimers = active.some(automation => timerTrigger(automation));
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new automation with a schedule or a task trigger starts a tick at once.
    useEffect(() => {
        if (!ready) return;
        void automationEngine.tick();
        const timer = setInterval(() => void automationEngine.tick(), TICK_MS);
        return () => clearInterval(timer);
    }, [ready, hasTimers]);
}

/** True for a trigger that the timer checks: a schedule or a task collection. */
function timerTrigger(automation: Automation): boolean {
    return automation.trigger.type === 'schedule' || automation.trigger.type === 'task.new';
}
