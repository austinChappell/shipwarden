import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { Bot, ChevronRight, Pin, PinOff, Plus, Square } from 'lucide-react';
import { pluralize } from '@shared/format';
import { confirmDialog } from './ConfirmDialog';
import { clickSelection, toggleAll } from './agent-selection';
import { EmptyState } from './EmptyState';
import {
    ciStateOf,
    ciText,
    compareOverview,
    countStates,
    formatElapsed,
    idleReasonText,
    lastActivityAt,
    OVERVIEW_LABELS,
    overviewState,
    type CiState,
    type OverviewState
} from '@shared/agent-overview';
import type { BranchSummary } from '@shared/github';
import type { ProjectsState } from '@shared/projects';
import type { RepoColor } from '@shared/settings';
import { branchSummariesQuery, summariesByRepo } from '../github/use-branch-status';
import { RepoIcon } from './RepoIcon';
import { useAgentSessions } from '../terminal/agent-state-store';
import { useAgentTokens } from '../terminal/agent-tokens-query';
import { sumAgentTokens, tokensText, tokensTitle, type AgentTokens } from '@shared/agent-tokens';
import { outputActivity } from '../terminal/output-activity';
import type { TaskLink } from '@shared/tasks';
import { runsAgent, type TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { moveListFocus } from '../keyboard/list-nav';
import { InlineTip } from './Tips';
import { Button, Chip, Count, FilterField, IconButton, PageHeader, type ChipTone } from './ui';
import { TranscriptSearch } from './TranscriptSearch';
import { OverlapChip } from './OverlapChip';
import { useOverlaps } from '../git/overlap-query';
import { overlapChipText } from '@shared/worktree-overlap';
import { hasTags, sessionIdOf, tagCounts, type PinnedSession } from '@shared/pinned-sessions';
import { type RecentSession, visibleRecentSessions } from '@shared/recent-sessions';
import { PinnedSessions, RecentSessions, UnpinnedSessions, type ResumePlace } from './PinnedSessions';
import { TagFilter } from './TagEditor';
import { canPin, pinOfSession, pinSession, usePinnedSessions, useSessionTags, useUnpinnedSessions } from '../terminal/pinned-sessions';
import { useRecentSessions } from '../terminal/recent-sessions';
import { showToast } from './Toast';

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
    /** The worktree that the app shows now. */
    selectedPath: string | undefined;
    /** Pins the session of an agent. The agent gives the pin a name. */
    onPin(session: TerminalSession, place: { repoPath?: string; branch?: string }): void;
    onUnpin(pin: PinnedSession): void;
    /** Resumes a pinned session in a worktree of any project. */
    onResume(pin: PinnedSession, place: ResumePlace): Promise<void>;
    /** Resumes a recent session without a pin in a worktree of any project. */
    onResumeRecent(session: RecentSession, place: ResumePlace): Promise<void>;
    /** Stops the agents and closes their terminals. The user agreed before the call. */
    onStop(sessions: TerminalSession[]): Promise<void>;
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
    /** Why the agent does not work, for the tooltip of the state chip. Undefined while it works or starts. */
    reason: string | undefined;
    lastOutputAt: number | undefined;
    activityAt: number | undefined;
    /** The tokens of the agent session. Undefined when the agent writes no Claude Code transcript. */
    tokens: AgentTokens | undefined;
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

/** The chip tone of each state. The tones follow the status colors of docs/design (board 2). */
export const STATE_TONE: Record<OverviewState, ChipTone> = {
    waiting: 'warning',
    'blocked-ci': 'danger',
    working: 'pending',
    starting: 'neutral',
    done: 'success',
    quiet: 'neutral'
};

/** The chip tone of the CI state of a pull request. */
export function ciTone(ci: CiState | undefined): ChipTone {
    if (ci === 'failed') return 'danger';
    if (ci === 'running') return 'pending';
    if (ci === 'passed') return 'success';
    return 'neutral';
}

/** Gives the text about the last sign of life of an agent, for example "Output 12s ago". */
function activityText(row: Row, now: number): string | undefined {
    if (row.lastOutputAt !== undefined) {
        return `Output ${formatElapsed(row.lastOutputAt, now)} ago`;
    }
    const changed = formatElapsed(row.session.agentStateAt, now);
    return changed ? `Changed ${changed} ago` : undefined;
}

/**
 * The agents of all projects that still run, grouped by project. Each row shows the state of the agent, the time since
 * its last output, a name for the work (the linked task, the last prompt or the branch), what the agent does now,
 * the pull request with its CI state, and where the agent runs.
 */
export function AgentsView({
    sessions: sessionList,
    projects,
    links,
    repoLabel,
    repoColor,
    onOpen,
    onStartAgent,
    selectedPath,
    onPin,
    onUnpin,
    onResume,
    onResumeRecent,
    onStop
}: Props) {
    const pins = usePinnedSessions();
    const unpinned = useUnpinnedSessions();
    const sessionTags = useSessionTags();
    const recentSessions = useRecentSessions();
    /** The tags that the session lists must have. */
    const [tagFilter, setTagFilter] = useState<string[]>([]);
    /** The text of the transcript search. While it has text, the view shows the search results. */
    const [searchText, setSearchText] = useState('');
    const searching = searchText.trim().length > 0;
    const [places, setPlaces] = useState<Record<string, Place>>({});
    const sessions = useAgentSessions(sessionList);
    const [now, setNow] = useState(Date.now());

    const agents = useMemo(() => sessions.filter(runsAgent), [sessions]);
    // A pinned, unpinned, or running session shows in its own list, so the recent list leaves it out.
    const recent = useMemo(() => {
        const pinned = new Set([...pins, ...unpinned].map(pin => pin.sessionId));
        const running = new Set(
            sessions.flatMap(session => {
                const id = !session.exited && session.agentTranscript ? sessionIdOf(session.agentTranscript) : undefined;
                return id ? [id] : [];
            })
        );
        return visibleRecentSessions(recentSessions, pinned, running);
    }, [recentSessions, pins, unpinned, sessions]);
    // The tags of the sessions in the three lists, with their counts. A tag of a session that is in no list does not show.
    const filterTags = useMemo(
        () =>
            tagCounts(
                sessionTags,
                [...pins, ...unpinned, ...recent].map(item => item.sessionId)
            ),
        [sessionTags, pins, unpinned, recent]
    );
    // A tag that no listed session has any more leaves the filter.
    const activeFilter = useMemo(() => tagFilter.filter(tag => filterTags.some(([name]) => name === tag)), [tagFilter, filterTags]);
    const toggleTag = (tag: string) => setTagFilter(list => (list.includes(tag) ? list.filter(item => item !== tag) : [...list, tag]));
    const allTags = useMemo(() => filterTags.map(([tag]) => tag), [filterTags]);
    const tagged = <T extends { sessionId: string }>(list: T[]) => list.filter(item => hasTags(sessionTags, item.sessionId, activeFilter));
    const tokensByTranscript = useAgentTokens(agents);
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

    // The files that two or more worktrees of a repository change. Local git only, in the cycle of the summaries.
    const overlaps = useOverlaps(agentRepos);

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
                    reason: idleReasonText({
                        agentState: session.agentState,
                        waitFor: session.agentWaitFor,
                        ci,
                        lastOutputAt,
                        now,
                        exited: session.exited,
                        exitCode: session.exitCode
                    }),
                    lastOutputAt,
                    activityAt: lastActivityAt(lastOutputAt, session.agentStateAt),
                    tokens: session.agentTranscript ? tokensByTranscript[session.agentTranscript] : undefined
                };
            }),
        [agents, places, summaries, now, tokensByTranscript]
    );

    /** The tokens of all agents in each worktree, by worktree path. Only a worktree with two or more agents has an entry. */
    const worktreeTokens = useMemo(() => {
        const byPath = new Map<string, TerminalSession[]>();
        for (const session of agents) {
            if (session.worktreePath) byPath.set(session.worktreePath, [...(byPath.get(session.worktreePath) ?? []), session]);
        }
        const result: Record<string, AgentTokens> = {};
        for (const [worktreePath, list] of byPath) {
            if (list.length > 1)
                result[worktreePath] = sumAgentTokens(
                    list.map(session => session.agentTranscript),
                    tokensByTranscript
                );
        }
        return result;
    }, [agents, tokensByTranscript]);

    const today = sumAgentTokens(
        agents.map(session => session.agentTranscript),
        tokensByTranscript
    ).today;

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

    /** Pins a session that has no pin. The agent gives the pin a name. */
    const pinRecent = (session: RecentSession) => {
        const repoPath = places[session.cwd]?.repo;
        pinSession({
            transcript: session.transcript,
            cwd: session.cwd,
            ...(repoPath ? { repoPath } : {}),
            ...(session.branch ? { branch: session.branch } : {}),
            fallbackName: session.name
        })
            .then(() => showToast('Session pinned', 'The agent is naming it. Find it in Pinned sessions.'))
            .catch(error =>
                showToast(
                    'The session did not pin',
                    error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
                )
            );
    };

    // The selected agents, by session ID. The IDs of agents that stopped stay in the set, but `selection` drops them.
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    /** The last checkbox that the user clicked. A Shift-click selects the range from it. */
    const anchor = useRef<string | undefined>(undefined);
    const [stopping, setStopping] = useState(false);
    /** The session IDs in the order of the rows on the screen. */
    const order = useMemo(() => groups.flatMap(group => group.rows.map(row => row.session.id)), [groups]);
    const selection = useMemo(() => agents.filter(session => selectedIds.has(session.id)), [agents, selectedIds]);

    const select = (id: string, shift: boolean) => {
        // React calls the updater during the next render. Read the anchor now, before the next line changes it.
        const from = anchor.current;
        setSelectedIds(set => clickSelection(set, order, id, from, shift));
        anchor.current = id;
    };
    const clearSelection = () => {
        setSelectedIds(new Set());
        anchor.current = undefined;
    };
    /** A click on a row opens the agent. A click with Shift, ⌘ or Ctrl selects the agent. */
    const clickRow = (event: MouseEvent, session: TerminalSession, projectId: string | undefined) => {
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            event.preventDefault();
            select(session.id, event.shiftKey);
            return;
        }
        onOpen(session, projectId);
    };
    const stopSelected = async () => {
        const list = selection;
        if (list.length === 0) return;
        const ok = await confirmDialog({
            title: `Stop ${pluralize(list.length, 'agent')}?`,
            message: list.length === 1 ? 'The agent stops and its terminal closes.' : 'The agents stop and their terminals close.',
            confirmLabel: 'Stop',
            danger: true
        });
        if (!ok) return;
        setStopping(true);
        try {
            await onStop(list);
            clearSelection();
        } finally {
            setStopping(false);
        }
    };

    return (
        <div
            className="agents-view"
            onKeyDown={event => {
                if (event.key === 'Escape' && selection.length > 0 && !event.defaultPrevented) {
                    event.preventDefault();
                    clearSelection();
                }
            }}
        >
            <PageHeader
                className="agents-header"
                icon={Bot}
                title="Agents"
                meta={
                    today.tokens > 0 ? (
                        <span title={`The tokens of the running agents since midnight. ${tokensTitle(today)} Only Claude Code and Codex report tokens.`}>
                            {agents.length} running · {tokensText(today)} today
                        </span>
                    ) : (
                        `${agents.length} running`
                    )
                }
                scope={
                    counts.length > 0 && (
                        <span className="agents-states">
                            {counts.map(({ state, count }) => (
                                <span key={state} className="agents-state-count">
                                    {OVERVIEW_LABELS[state]}
                                    <Count value={count} label={`${count} ${OVERVIEW_LABELS[state].toLowerCase()}`} />
                                </span>
                            ))}
                        </span>
                    )
                }
                filter={
                    <FilterField
                        value={searchText}
                        onChange={setSearchText}
                        placeholder="Search transcripts"
                        label="Search the prompts, the agent text, and the files of all Claude Code sessions"
                    />
                }
                primary={
                    <Button variant="primary" size="lg" icon={<Plus size={14} strokeWidth={2} aria-hidden="true" />} onClick={onStartAgent}>
                        Start agent
                    </Button>
                }
            />
            <div className={`agents-scroll${selection.length > 0 ? ' has-selection' : ''}`} onKeyDown={moveListFocus}>
                {searching && (
                    <TranscriptSearch
                        text={searchText}
                        repos={allRepos}
                        places={places}
                        selectedPath={selectedPath}
                        repoLabel={repoLabel}
                        pins={pins}
                        onResume={onResume}
                        onResumeRecent={onResumeRecent}
                        onPin={pinRecent}
                    />
                )}
                {!searching && agents.length > 0 && <InlineTip id="agents" />}
                {!searching && agents.length === 0 && pins.length === 0 && unpinned.length === 0 && recent.length === 0 && (
                    <EmptyState
                        icon={Bot}
                        title="No agents running"
                        actions={
                            <Button variant="primary" size="lg" icon={<Plus size={14} strokeWidth={2} aria-hidden="true" />} onClick={onStartAgent}>
                                Start agent
                            </Button>
                        }
                        hint="Or use “Start in worktree” on a task."
                    >
                        Agents from every project show here with their state.
                    </EmptyState>
                )}
                {(searching ? [] : groups).map(group => {
                    const headingId = `agents-group-${group.id ?? 'other'}`;
                    const groupIds = group.rows.map(row => row.session.id);
                    const groupCount = groupIds.filter(id => selectedIds.has(id)).length;
                    return (
                        <section key={group.id ?? 'other'} className="agents-group" aria-labelledby={headingId}>
                            <h2 id={headingId}>
                                <input
                                    type="checkbox"
                                    className="agent-select"
                                    aria-label={`Select all agents in ${group.name}`}
                                    checked={groupCount > 0 && groupCount === groupIds.length}
                                    ref={element => {
                                        if (element) element.indeterminate = groupCount > 0 && groupCount < groupIds.length;
                                    }}
                                    onChange={() => {
                                        setSelectedIds(set => toggleAll(set, groupIds));
                                        anchor.current = undefined;
                                    }}
                                />
                                <span>
                                    {group.name} <span className="agents-group-count">({group.rows.length})</span>
                                </span>
                                {group.id === projects?.activeId && <Chip>Current project</Chip>}
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
                                    const overlap = place ? overlaps[place.repo]?.[place.worktree.path] : undefined;
                                    const tokens = row.tokens && row.tokens.total.tokens > 0 ? row.tokens.total : undefined;
                                    const shared = session.worktreePath ? worktreeTokens[session.worktreePath]?.total : undefined;
                                    // A narrow list hides the activity and the tokens. The chip tooltip gives them.
                                    const chipTitle =
                                        [
                                            row.reason && `${row.reason}.`,
                                            activity,
                                            tokens && tokensTitle(tokens),
                                            shared && shared.tokens > 0 && `All agents in this worktree: ${tokensText(shared)}.`
                                        ]
                                            .filter(Boolean)
                                            .join('\n') || undefined;
                                    const message =
                                        session.agentMessage ??
                                        (session.agentState ? '' : `${session.title} has no status hooks. The state comes from its terminal output.`);
                                    const selected = selectedIds.has(session.id);
                                    return (
                                        <li key={session.id} className={selected ? 'selected' : undefined}>
                                            <input
                                                type="checkbox"
                                                className="agent-select"
                                                aria-label={`Select “${name}”`}
                                                checked={selected}
                                                onMouseDown={event => {
                                                    // Shift-click must not select the text between the rows.
                                                    if (event.shiftKey) event.preventDefault();
                                                }}
                                                onChange={event => select(session.id, (event.nativeEvent as globalThis.MouseEvent).shiftKey === true)}
                                            />
                                            <button
                                                className={`agent-row ${state}`}
                                                data-nav-item
                                                aria-label={[
                                                    name,
                                                    label,
                                                    row.reason,
                                                    activity,
                                                    tokens && tokensText(tokens),
                                                    prText,
                                                    overlap && overlapChipText(overlap),
                                                    where
                                                ]
                                                    .filter(Boolean)
                                                    .join('. ')}
                                                onMouseDown={event => {
                                                    if (event.shiftKey) event.preventDefault();
                                                }}
                                                onClick={event => clickRow(event, session, group.id)}
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
                                                        {tokens && (
                                                            <span className="agent-since agent-tokens" title={tokensTitle(tokens)}>
                                                                {tokensText(tokens)}
                                                            </span>
                                                        )}
                                                        {activity && <span className="agent-since agent-output">{activity}</span>}
                                                        <Chip tone={STATE_TONE[state]} title={chipTitle}>
                                                            {label}
                                                        </Chip>
                                                    </span>
                                                    <span className="agent-where">
                                                        {prText && <Chip tone={ciTone(ci)}>{prText}</Chip>}
                                                        {overlap && <OverlapChip overlap={overlap} />}
                                                        {place && repoColor(place.repo) && <RepoIcon color={repoColor(place.repo)} size={12} />}
                                                        <span className="agent-where-text">{where}</span>
                                                        {shared && shared.tokens > 0 && (
                                                            <span className="agent-tokens" title={`All agents in this worktree. ${tokensTitle(shared)}`}>
                                                                {tokensText(shared)} in worktree
                                                            </span>
                                                        )}
                                                    </span>
                                                </span>
                                                <ChevronRight size={14} strokeWidth={1.8} className="agent-chevron" aria-hidden />
                                            </button>
                                            {canPin(session) &&
                                                (() => {
                                                    const pin = pinOfSession(pins, session);
                                                    return (
                                                        <IconButton
                                                            size="sm"
                                                            className={`agent-pin${pin ? ' pinned' : ''}`}
                                                            active={!!pin}
                                                            icon={pin ? <PinOff size={14} strokeWidth={1.8} /> : <Pin size={14} strokeWidth={1.8} />}
                                                            label={pin ? `Unpin “${pin.name}”` : 'Pin the session to resume it later'}
                                                            onClick={() =>
                                                                pin ? onUnpin(pin) : onPin(session, { repoPath: place?.repo, branch: place?.worktree.branch })
                                                            }
                                                        />
                                                    );
                                                })()}
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    );
                })}
                {!searching && (
                    <>
                        <TagFilter className="sessions-tag-filter" tags={filterTags} selected={activeFilter} onToggle={toggleTag} noun="session" />
                        <PinnedSessions
                            pins={tagged(pins)}
                            places={places}
                            selectedPath={selectedPath}
                            repoLabel={repoLabel}
                            onResume={onResume}
                            tags={sessionTags}
                            allTags={allTags}
                        />
                        <UnpinnedSessions
                            pins={tagged(unpinned)}
                            places={places}
                            selectedPath={selectedPath}
                            repoLabel={repoLabel}
                            onResume={onResume}
                            tags={sessionTags}
                            allTags={allTags}
                        />
                        <RecentSessions
                            sessions={tagged(recent)}
                            places={places}
                            selectedPath={selectedPath}
                            repoLabel={repoLabel}
                            onResume={onResumeRecent}
                            onPin={pinRecent}
                            tags={sessionTags}
                            allTags={allTags}
                        />
                    </>
                )}
            </div>
            {/* The bar floats above the list, so a click on a checkbox does not move the rows. */}
            {selection.length > 0 && (
                <div className="agents-selection" role="toolbar" aria-label="Selected agents">
                    <span className="agents-selection-count">{pluralize(selection.length, 'agent')} selected</span>
                    <Button variant="link" onClick={clearSelection}>
                        Clear
                    </Button>
                    <Button
                        variant="danger"
                        icon={<Square size={12} strokeWidth={2} aria-hidden="true" />}
                        disabled={stopping}
                        onClick={() => void stopSelected()}
                    >
                        {stopping ? 'Stopping…' : 'Stop selected'}
                    </Button>
                </div>
            )}
        </div>
    );
}
