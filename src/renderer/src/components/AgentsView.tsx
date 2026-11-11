import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { Bot, ChevronRight, Play } from 'lucide-react';
import { EmptyState } from './EmptyState';
import {
    ciStateOf,
    ciText,
    compareOverview,
    countStates,
    formatElapsed,
    lastActivityAt,
    OVERVIEW_LABELS,
    overviewState,
    type CiState,
    type OverviewState
} from '@shared/agent-overview';
import type { BranchSummary } from '@shared/github';
import type { ProjectsState } from '@shared/projects';
import type { RepoColor } from '@shared/settings';
import { highestWindow, PROVIDER_NAMES, type ProviderUsage } from '@shared/usage';
import { branchSummariesQuery, summariesByRepo } from '../github/use-branch-status';
import { useUsage } from '../usage-query';
import { RepoIcon } from './RepoIcon';
import { useAgentSessions } from '../terminal/agent-state-store';
import { outputActivity } from '../terminal/output-activity';
import type { TaskLink } from '@shared/tasks';
import { runsAgent, type TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { moveListFocus } from '../keyboard/list-nav';
import { InlineTip } from './Tips';

const api = window.shipwarden;

interface Props {
    sessions: TerminalSession[];
    projects: ProjectsState | undefined;
    /** The task of each worktree, by worktree path. */
    links: Record<string, TaskLink>;
    /** The name of a repository: its name from the repository settings, else its folder name. */
    repoLabel(repo: string): string;
    repoColor(repo: string): RepoColor | undefined;
    /** Shows the tab of the agent. `projectId` is the project of the agent's worktree, if ShipWarden found one. */
    onOpen(session: TerminalSession, projectId: string | undefined): void;
    /** Goes to a place where the user can start an agent: the selected worktree, the New worktree dialog or "Add a repository". */
    onStartAgent(): void;
}

/** Where a worktree is: its repository and its branch. */
interface Place {
    repo: string;
    worktree: Worktree;
}

/** One agent with the data that its row shows. */
interface Row {
    session: TerminalSession;
    place: Place | undefined;
    pr: BranchSummary | undefined;
    ci: CiState | undefined;
    state: OverviewState;
    lastOutputAt: number | undefined;
    activityAt: number | undefined;
}

/** The CSS class of the status dot of each state. The classes come from the worktree list. */
const DOT_CLASS: Record<OverviewState, string> = {
    waiting: 'waiting',
    'blocked-ci': 'blocked-ci',
    working: 'working',
    starting: 'starting',
    done: 'done',
    quiet: ''
};

/** Gives the text about the last sign of life of an agent, for example "Output 12s ago". */
function activityText(row: Row, now: number): string | undefined {
    if (row.lastOutputAt !== undefined) {
        return `Output ${formatElapsed(row.lastOutputAt, now)} ago`;
    }
    const changed = formatElapsed(row.session.agentStateAt, now);
    return changed ? `Changed ${changed} ago` : undefined;
}

/** Gives the short plan usage of each signed-in provider, for example "Claude 42%". */
function usageText(usage: readonly ProviderUsage[]): string | undefined {
    const parts = usage
        .filter(item => item.status !== 'signed-out')
        .map(item => {
            const top = highestWindow(item.windows);
            return top ? `${PROVIDER_NAMES[item.provider]} ${top.usedPercent}%` : undefined;
        })
        .filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * The agents of all projects that still run, grouped by project. Each row shows the state of the agent, the time since
 * its last output, a name for the work (the linked task, the last prompt or the branch), what the agent does now,
 * the pull request with its CI state, and where the agent runs.
 */
export function AgentsView({ sessions: sessionList, projects, links, repoLabel, repoColor, onOpen, onStartAgent }: Props) {
    const [places, setPlaces] = useState<Record<string, Place>>({});
    // The plan usage of the agents. ShipWarden has no usage for each agent, only for each sign-in.
    const usage = useUsage();
    const sessions = useAgentSessions(sessionList);
    const [now, setNow] = useState(Date.now());

    const agents = useMemo(() => sessions.filter(runsAgent), [sessions]);
    const allRepos = useMemo(() => [...new Set((projects?.projects ?? []).flatMap(project => project.repos))], [projects]);

    // The worktrees of all repositories of all projects tell which project and branch each agent belongs to.
    const repoKey = allRepos.join('\0');
    // biome-ignore lint/correctness/useExhaustiveDependencies: repoKey holds the content of allRepos. A new agent can use a new worktree, so the count reloads the list.
    useEffect(() => {
        let cancelled = false;
        Promise.all(
            allRepos.map(async repo => {
                try {
                    return (await api.worktrees.list(repo)).map(worktree => [worktree.path, { repo, worktree }] as const);
                } catch {
                    return [];
                }
            })
        ).then(lists => {
            if (!cancelled) {
                setPlaces(Object.fromEntries(lists.flat()));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [repoKey, agents.length]);

    // Load the pull requests and their CI state for each repository that has an agent. One request covers a repository.
    // The worktree list shares the cache. It already loads the repositories of the active project each minute.
    const agentRepoKey = [...new Set(agents.map(session => session.worktreePath && places[session.worktreePath]?.repo).filter(Boolean))].sort().join('\0');
    const agentRepos = useMemo(() => (agentRepoKey ? agentRepoKey.split('\0') : []), [agentRepoKey]);
    const activeRepos = new Set(projects?.projects.find(project => project.id === projects.activeId)?.repos ?? []);
    const combineSummaries = useCallback((results: UseQueryResult<Record<string, BranchSummary>>[]) => summariesByRepo(agentRepos, results), [agentRepos]);
    /** The open pull requests of each repository by head branch, with their CI state. */
    const summaries = useQueries({
        queries: agentRepos.map(repo => ({ ...branchSummariesQuery(repo), ...(activeRepos.has(repo) ? { refetchInterval: false as const } : {}) })),
        combine: combineSummaries
    });

    // The time since the last output counts in seconds.
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    const rows = useMemo<Row[]>(
        () =>
            agents.map(session => {
                const place = session.worktreePath ? places[session.worktreePath] : undefined;
                const branch = place?.worktree.branch;
                const pr = place && branch ? summaries[place.repo]?.[branch] : undefined;
                const ci = ciStateOf(pr ? pr.checks : undefined);
                const lastOutputAt = outputActivity.get(session.id);
                return {
                    session,
                    place,
                    pr,
                    ci,
                    state: overviewState({ agentState: session.agentState, ci, lastOutputAt, now }),
                    lastOutputAt,
                    activityAt: lastActivityAt(lastOutputAt, session.agentStateAt)
                };
            }),
        [agents, places, summaries, now]
    );

    /** The groups: one for each project with agents, the active project first, then agents that are in no project. */
    const groups = useMemo(() => {
        const sorted = [...rows].sort(compareOverview);
        const list = [...(projects?.projects ?? [])]
            .sort((a, b) => (a.id === projects?.activeId ? -1 : b.id === projects?.activeId ? 1 : 0))
            .map(project => ({
                id: project.id as string | undefined,
                name: project.name,
                rows: sorted.filter(row => !!row.place && project.repos.includes(row.place.repo))
            }))
            .filter(group => group.rows.length > 0);
        const other = sorted.filter(row => !row.place);
        if (other.length > 0) {
            list.push({ id: undefined, name: 'Other', rows: other });
        }
        return list;
    }, [rows, projects]);

    const counts = countStates(rows.map(row => row.state));
    const plan = usageText(usage);

    return (
        <div className="agents-view">
            <header className="agents-header">
                <h1>Agents</h1>
                <span className="agents-count">{agents.length} running</span>
                {counts.length > 0 && (
                    <span className="agents-states">
                        {counts.map(({ state, count }) => (
                            <span key={state} className={`agents-state-count ${state}`}>
                                {count} {OVERVIEW_LABELS[state].toLowerCase()}
                            </span>
                        ))}
                    </span>
                )}
                {plan && (
                    <span className="agents-usage" title="The plan usage of the account. ShipWarden has no usage for each agent.">
                        Plan usage: {plan}
                    </span>
                )}
            </header>
            <div className="agents-scroll" onKeyDown={moveListFocus}>
                {agents.length > 0 && <InlineTip id="agents" />}
                {agents.length === 0 && (
                    <EmptyState
                        icon={Bot}
                        title="No agents run now"
                        actions={
                            <button className="button primary" onClick={onStartAgent}>
                                <Play size={13} strokeWidth={1.8} aria-hidden="true" /> Start an agent in a worktree
                            </button>
                        }
                        hint="You can also start an agent from a task with “Start in worktree”."
                    >
                        This view shows all agents of all projects and their state. Start an agent in a worktree to see it here.
                    </EmptyState>
                )}
                {groups.map(group => {
                    const headingId = `agents-group-${group.id ?? 'other'}`;
                    return (
                        <section key={group.id ?? 'other'} className="agents-group" aria-labelledby={headingId}>
                            <h2 id={headingId}>
                                {group.name}
                                {group.id === projects?.activeId && <span className="agents-current">current project</span>}
                            </h2>
                            {/* biome-ignore lint/a11y/noRedundantRoles: Safari removes the list role when the list has no bullets. */}
                            <ul className="agents-list" role="list">
                                {group.rows.map(row => {
                                    const { session, place, pr, ci, state } = row;
                                    const link = session.worktreePath ? links[session.worktreePath] : undefined;
                                    const branch = place?.worktree.branch ?? place?.worktree.path.split('/').pop();
                                    const name = link ? `${link.key ? `${link.key} · ` : ''}${link.title}` : (session.agentPrompt ?? branch ?? session.title);
                                    const label = OVERVIEW_LABELS[state];
                                    const activity = activityText(row, now);
                                    const where = place ? `${repoLabel(place.repo)} · ${branch}` : (session.cwd.split('/').pop() ?? session.cwd);
                                    const prText = pr ? `PR #${pr.number}${ciText(ci) ? ` · ${ciText(ci)}` : ''}` : undefined;
                                    const message =
                                        session.agentMessage ??
                                        (session.agentState ? '' : `${session.title} has no status hooks. The state comes from its terminal output.`);
                                    return (
                                        <li key={session.id}>
                                            <button
                                                className={`agent-row ${state}`}
                                                data-nav-item
                                                aria-label={[name, label, activity, prText, where].filter(Boolean).join('. ')}
                                                onClick={() => onOpen(session, group.id)}
                                            >
                                                <span className={`status-dot ${DOT_CLASS[state]}`} aria-hidden />
                                                <span className="agent-main">
                                                    <span className="agent-name" title={name}>
                                                        {name}
                                                    </span>
                                                    <span className="agent-activity" title={message}>
                                                        {message}
                                                    </span>
                                                </span>
                                                <span className="agent-side">
                                                    <span className="agent-state-line">
                                                        <span className={`agent-state ${state}`}>{label}</span>
                                                        {activity && <span className="agent-since"> · {activity}</span>}
                                                    </span>
                                                    <span className="agent-where">
                                                        {prText && <span className={`agent-pr ${ci ?? ''}`}>{prText}</span>}
                                                        {place && repoColor(place.repo) && <RepoIcon color={repoColor(place.repo)} size={12} />}
                                                        <span className="agent-where-text">{where}</span>
                                                    </span>
                                                </span>
                                                <ChevronRight size={14} strokeWidth={1.8} className="agent-chevron" aria-hidden />
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
