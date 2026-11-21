import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { ciStateOf, ciText, idleReasonText, OVERVIEW_LABELS, overviewState } from '@shared/agent-overview';
import { compareRunState, groupsOfTask, runsToRemove, type CompareGroup, type CompareRun, type CompareRunState } from '@shared/agent-compare';
import { worktreeAgentState } from '@shared/agents';
import { pluralize } from '@shared/format';
import { diffTotals, type BranchDiff } from '@shared/git';
import type { AgentDefinition } from '@shared/settings';
import type { Task } from '@shared/tasks';
import { runsAgent, type TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { branchDiffKey, useCompareGroups } from '../../compare/compare-cache';
import { branchSummariesQuery } from '../../github/use-branch-status';
import { queryClient } from '../../query-client';
import { useAgentSessions } from '../../terminal/agent-state-store';
import { outputActivity } from '../../terminal/output-activity';
import { errorText, optionalErrorText } from '../../util';
import { ciTone, STATE_TONE } from '../AgentsView';
import { TaskCard } from '../tasks/TaskBody';
import { Age, Button, Chip, IconButton } from '../ui';
import { CompareDiff, LineCounts } from './CompareDiff';

const api = window.shipwarden;

/** The data and the actions of agent comparisons, from the app. */
export interface CompareProps {
    /** The agents of Settings › Agents. */
    agents: AgentDefinition[];
    sessions: TerminalSession[];
    /** The worktrees of each repository of the active project. */
    worktreesByRepo: Record<string, Worktree[]>;
    /** Makes a worktree for each agent and starts the agents on the task. */
    start(task: Task, connectionId: string, pluginId: string, repo: string, agentIds: string[]): Promise<void>;
    /** Keeps one run, and asks to remove the worktrees of the other runs. */
    keep(group: CompareGroup, worktreePath: string): Promise<void>;
    onOpenWorktree(path: string): void;
}

const RUN_STATE_TEXT: Partial<Record<CompareRunState, string>> = { kept: 'Kept', removed: 'Removed' };

interface Props {
    compare: CompareProps;
    connectionId: string;
    taskId: string;
}

/** The agent comparisons of a task: one card for each comparison, the newest first. */
export function CompareRuns({ compare, connectionId, taskId }: Props) {
    const groups = groupsOfTask(useCompareGroups(), connectionId, taskId);
    return (
        <>
            {groups.map(group => (
                <CompareCard key={group.id} group={group} compare={compare} />
            ))}
        </>
    );
}

function CompareCard({ group, compare }: { group: CompareGroup; compare: CompareProps }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [diffOpen, setDiffOpen] = useState<string>();
    const sessions = useAgentSessions(compare.sessions);
    const listed = compare.worktreesByRepo[group.repoPath];
    // A repository of another project has no list here. Then each worktree counts as present.
    const existing = useMemo(() => new Set(listed ? listed.map(worktree => worktree.path) : group.runs.map(run => run.worktreePath)), [listed, group.runs]);
    const states = group.runs.map(run => compareRunState(group, run, existing));
    const present = group.runs.filter((_run, index) => states[index] !== 'removed');

    const diffs = useQueries({
        queries: group.runs.map((run, index) => ({
            queryKey: branchDiffKey(run.worktreePath),
            queryFn: () => api.git.branchDiff(run.worktreePath),
            enabled: states[index] !== 'removed',
            staleTime: 0,
            refetchInterval: false as const
        }))
    });
    // The sidebar loads the summaries of the active project on a timer. This view only reads the cache.
    const summaries = useQuery({ ...branchSummariesQuery(group.repoPath), refetchInterval: false }).data;
    const others = runsToRemove(group, existing);

    const act = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(undefined);
        try {
            await action();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    const refresh = () => {
        for (const run of present) void queryClient.invalidateQueries({ queryKey: branchDiffKey(run.worktreePath) });
    };

    return (
        <TaskCard
            title="Compare agents"
            count={group.runs.length}
            className="compare-card"
            actions={
                <>
                    <Age date={new Date(group.createdAt).toISOString()} format="prose" />
                    <IconButton size="sm" icon={<RefreshCw size={14} strokeWidth={1.6} />} label="Count the changes again" onClick={refresh} />
                </>
            }
        >
            <div className="compare-runs">
                {group.runs.map((run, index) => (
                    <RunRow
                        key={run.worktreePath}
                        run={run}
                        state={states[index]}
                        canKeep={!group.keptPath && !busy}
                        sessions={sessions}
                        diff={diffs[index]?.data}
                        diffError={optionalErrorText(diffs[index]?.error)}
                        checks={summaries?.[run.branch] ? summaries[run.branch].checks : undefined}
                        prNumber={summaries?.[run.branch]?.number}
                        diffOpen={diffOpen === run.worktreePath}
                        onToggleDiff={() => setDiffOpen(current => (current === run.worktreePath ? undefined : run.worktreePath))}
                        onOpen={() => compare.onOpenWorktree(run.worktreePath)}
                        onKeep={() => void act(() => compare.keep(group, run.worktreePath))}
                    />
                ))}
            </div>
            {others.length > 0 && group.keptPath && (
                <div className="compare-footer">
                    <Button variant="danger" disabled={busy} onClick={() => void act(() => compare.keep(group, group.keptPath!))}>
                        Remove other worktrees
                    </Button>
                </div>
            )}
            {error && <div className="form-error">{error}</div>}
        </TaskCard>
    );
}

interface RowProps {
    run: CompareRun;
    state: CompareRunState;
    canKeep: boolean;
    sessions: TerminalSession[];
    diff: BranchDiff | undefined;
    diffError: string | undefined;
    /** `BranchSummary.checks` of the pull request of the branch. Undefined when the branch has no pull request. */
    checks: string | null | undefined;
    prNumber: number | undefined;
    diffOpen: boolean;
    onToggleDiff(): void;
    onOpen(): void;
    onKeep(): void;
}

function RunRow({ run, state, canKeep, sessions, diff, diffError, checks, prNumber, diffOpen, onToggleDiff, onOpen, onKeep }: RowProps) {
    const removed = state === 'removed';
    const agents = sessions.filter(session => session.worktreePath === run.worktreePath && runsAgent(session));
    const agentState = worktreeAgentState(agents.map(session => session.agentState));
    const lastOutputAt = agents
        .map(session => outputActivity.get(session.id))
        .reduce<number | undefined>((latest, at) => (at !== undefined && (latest === undefined || at > latest) ? at : latest), undefined);
    const ci = ciStateOf(checks);
    const now = Date.now();
    const overview = agents.length ? overviewState({ agentState, ci, lastOutputAt, now }) : undefined;
    // The agent that gives the state of the row also gives the reason.
    const shown = agents.find(session => session.agentState === agentState) ?? agents[0];
    const reason = shown
        ? idleReasonText({ agentState, waitFor: shown.agentWaitFor, ci, lastOutputAt, now, exited: shown.exited, exitCode: shown.exitCode })
        : undefined;
    const totals = diff ? diffTotals(diff.files) : undefined;
    const stateText = RUN_STATE_TEXT[state];

    return (
        <div className="compare-run">
            <div className="compare-run-row">
                <span className="compare-run-agent">{run.agentName}</span>
                <Chip mono title={run.branch}>
                    {run.branch}
                </Chip>
                <span className="header-spacer" />
                {stateText && <Chip tone={state === 'kept' ? 'success' : 'neutral'}>{stateText}</Chip>}
                {!removed && overview && (
                    <Chip tone={STATE_TONE[overview]} title={reason}>
                        {OVERVIEW_LABELS[overview]}
                    </Chip>
                )}
                {!removed && !overview && <Chip>No agent</Chip>}
                {!removed && totals && (
                    <span className="compare-run-stat" title={diff?.base ? `Since ${diff.base.slice(0, 7)}` : 'Since HEAD'}>
                        {pluralize(totals.files, 'file')} <LineCounts file={{ ...totals, binary: false }} />
                    </span>
                )}
                {!removed && prNumber !== undefined && <Chip tone={ciTone(ci)}>{`PR #${prNumber}${ciText(ci) ? ` · ${ciText(ci)}` : ''}`}</Chip>}
                {!removed && (
                    <>
                        <Button aria-expanded={diffOpen} disabled={!diff} onClick={onToggleDiff}>
                            {diffOpen ? 'Hide diff' : 'Diff'}
                        </Button>
                        <Button onClick={onOpen}>Open</Button>
                        {state === 'active' && (
                            <Button variant="accent" disabled={!canKeep} onClick={onKeep}>
                                Keep this one
                            </Button>
                        )}
                    </>
                )}
            </div>
            {diffError && <div className="form-error">{diffError}</div>}
            {diffOpen && diff && <CompareDiff worktree={run.worktreePath} diff={diff} />}
        </div>
    );
}
