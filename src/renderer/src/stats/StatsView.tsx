import { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { formatElapsed } from '@shared/agent-overview';
import { formatTokens } from '@shared/automations';
import { formatAgo, pluralize } from '@shared/format';
import { computeStats, formatShare, STATS_WINDOWS, type StatsGroupBy, type StatsRow, type StatsWindow } from '@shared/stats';
import { EmptyState } from '../components/EmptyState';
import { radioGroupKeys } from '../components/keyboard';
import { Button, ButtonGroup, PageHeader, RefreshButton, SkeletonRows } from '../components/ui';
import { keyRoots } from '../query-client';
import { errorText } from '../util';

const api = window.shipwarden;

/** The query of the stats log. The data is local, so the view reads the log again each time it opens. */
const statsQuery = {
    queryKey: keyRoots.stats,
    queryFn: () => api.stats.events(),
    staleTime: 0,
    refetchInterval: false as const,
    refetchOnWindowFocus: false
};

const NO_DATA = 'No data';

/**
 * The Stats view: the numbers of each agent or each model in the last 7, 30, or 90 days. The numbers help to choose
 * agents and models. The view reads the local event log (`agent-stats.jsonl`). It sends no network request.
 */
export function StatsView() {
    const query = useQuery(statsQuery);
    const [days, setDays] = useState<StatsWindow>(30);
    const [groupBy, setGroupBy] = useState<StatsGroupBy>('agent');
    const stats = useMemo(() => (query.data ? computeStats(query.data, { now: Date.now(), days, groupBy }) : undefined), [query.data, days, groupBy]);
    const total = stats?.total;
    const nameLabel = groupBy === 'agent' ? 'Agent' : 'Model';

    return (
        <div className="stats-view">
            <PageHeader
                icon={BarChart3}
                title="Stats"
                meta={query.dataUpdatedAt ? `Updated ${formatAgo(new Date(query.dataUpdatedAt).toISOString())}` : undefined}
                scope={
                    <>
                        <ButtonGroup size="sm" role="radiogroup" label="Time range" onKeyDown={radioGroupKeys}>
                            {STATS_WINDOWS.map(value => (
                                <Button key={value} size="sm" role="radio" aria-checked={days === value} onClick={() => setDays(value)}>
                                    {value} days
                                </Button>
                            ))}
                        </ButtonGroup>
                        <ButtonGroup size="sm" role="radiogroup" label="Rows" onKeyDown={radioGroupKeys}>
                            <Button size="sm" role="radio" aria-checked={groupBy === 'agent'} onClick={() => setGroupBy('agent')}>
                                Agents
                            </Button>
                            <Button size="sm" role="radio" aria-checked={groupBy === 'model'} onClick={() => setGroupBy('model')}>
                                Models
                            </Button>
                        </ButtonGroup>
                    </>
                }
                actions={<RefreshButton size="lg" refreshing={query.isFetching} onRefresh={() => query.refetch()} />}
            />
            <div className="stats-scroll">
                {query.isError ? (
                    <EmptyState icon={BarChart3} title="The stats did not load">
                        {errorText(query.error)}
                    </EmptyState>
                ) : !stats || !total ? (
                    <div className="stats-page">
                        <SkeletonRows label="Loading the stats" dot={false} />
                    </div>
                ) : stats.empty ? (
                    <EmptyState icon={BarChart3} title={query.data?.length ? `No data in the last ${days} days` : 'No stats yet'}>
                        ShipWarden writes a line to the stats log at each agent state change, merge, and compare result. Start an agent on a task to collect
                        data.
                    </EmptyState>
                ) : (
                    <div className="stats-page">
                        <section className="stats-tiles" aria-label={`All agents in the last ${days} days`}>
                            <StatTile label="Merged pull requests" value={String(total.merged)} note="Merged in ShipWarden" />
                            <StatTile
                                label="Median time to merge"
                                value={durationText(total.mergeMs)}
                                note={
                                    total.timedPrs ? `From the start of the work, ${pluralize(total.timedPrs, 'pull request')}` : 'No merge with a known start'
                                }
                            />
                            <StatTile
                                label="Time in needs input"
                                value={formatShare(total.needsInputShare)}
                                note={total.agentMs ? `Of ${durationText(total.agentMs)} of agent time` : 'No agent states'}
                            />
                            <StatTile label="Time blocked on CI" value={formatShare(total.blockedCiShare)} note="The agent is done, and CI is running or failed" />
                            <StatTile
                                label="First push fails CI"
                                value={formatShare(total.firstPushFailRate)}
                                note={total.firstPushes ? `${total.firstPushFailures} of ${pluralize(total.firstPushes, 'pull request')}` : 'No CI result yet'}
                            />
                        </section>

                        <div className="stats-table-wrap">
                            <table className="stats-table">
                                <thead>
                                    <tr>
                                        <th scope="col">{nameLabel}</th>
                                        <th scope="col">Merged</th>
                                        <th scope="col">Tokens per PR</th>
                                        <th scope="col">Time to merge</th>
                                        <th scope="col">Needs input</th>
                                        <th scope="col">Blocked on CI</th>
                                        <th scope="col">First push fails</th>
                                        <th scope="col">Compare wins</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {stats.rows.map(row => (
                                        <StatsTableRow key={row.label} row={row} />
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <ul className="stats-notes">
                            <li>Each number is a median or a part of the time. “No data” shows when the log cannot give the number.</li>
                            <li>Only Claude Code gives a token count. Codex and the other agents show “No data” for tokens.</li>
                            <li>Agents without hooks, for example Codex, give no states. Their time does not count.</li>
                            <li>Only the merges in ShipWarden count. The log keeps the data of the last 90 days.</li>
                        </ul>
                    </div>
                )}
            </div>
        </div>
    );
}

function durationText(ms: number | undefined): string | undefined {
    return ms === undefined ? undefined : formatElapsed(0, ms);
}

/** One headline number of all the agents (docs/design, board 2: 28/700 stat tile number). */
function StatTile({ label, value, note }: { label: string; value: string | undefined; note: string }) {
    return (
        <div className="stats-tile">
            <span className="stats-tile-label">{label}</span>
            <span className={value === undefined ? 'stats-tile-value no-data' : 'stats-tile-value'}>{value ?? NO_DATA}</span>
            <span className="stats-tile-note">{note}</span>
        </div>
    );
}

/** A number cell of the table. A value that the log cannot give shows "No data", and its tooltip tells why. */
function Cell({ value, title }: { value: string | undefined; title: string }) {
    return (
        <td className={value === undefined ? 'num no-data' : 'num'} title={title}>
            {value ?? NO_DATA}
        </td>
    );
}

function StatsTableRow({ row }: { row: StatsRow }) {
    const agentTime = row.agentMs ? `of ${durationText(row.agentMs)} of agent time` : '';
    return (
        <tr>
            <th scope="row" title={row.label}>
                {row.label}
            </th>
            <Cell value={String(row.merged)} title={pluralize(row.merged, 'merged pull request')} />
            <Cell
                value={row.tokensPerPr === undefined ? undefined : formatTokens(row.tokensPerPr)}
                title={
                    row.tokenPrs
                        ? `Median of ${pluralize(row.tokenPrs, 'merged pull request')} with a token count`
                        : 'No merged pull request with a token count'
                }
            />
            <Cell
                value={durationText(row.mergeMs)}
                title={
                    row.timedPrs
                        ? `Median of ${pluralize(row.timedPrs, 'merged pull request')}, from the start of the work to the merge`
                        : 'No merge with a known start'
                }
            />
            <Cell value={formatShare(row.needsInputShare)} title={row.agentMs ? `${durationText(row.needsInputMs)} ${agentTime}` : 'No agent states'} />
            <Cell value={formatShare(row.blockedCiShare)} title={row.agentMs ? `${durationText(row.blockedCiMs)} ${agentTime}` : 'No agent states'} />
            <Cell
                value={formatShare(row.firstPushFailRate)}
                title={
                    row.firstPushes
                        ? `${row.firstPushFailures} of ${pluralize(row.firstPushes, 'first push', 'first pushes')} failed CI`
                        : 'No CI result of a first push'
                }
            />
            <Cell
                value={row.compareRuns ? `${row.compareWins} of ${row.compareRuns}` : undefined}
                title={row.compareRuns ? `Kept in ${row.compareWins} of ${pluralize(row.compareRuns, 'comparison')}` : 'Not in a comparison'}
            />
        </tr>
    );
}
