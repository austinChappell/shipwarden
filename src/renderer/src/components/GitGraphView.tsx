import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderGit2, GitGraph, LoaderCircle, RefreshCw } from 'lucide-react';
import { layoutGraph, type GraphLog, type GraphRef, type GraphRow, type GraphScope } from '@shared/git-graph';
import type { Worktree } from '@shared/worktrees';
import { formatAgo, pluralize } from '@shared/format';
import { onGitChanged } from '../git/git-store';
import { errorText } from '../util';
import { moveListFocus } from '../keyboard/list-nav';
import { radioGroupKeys } from './keyboard';
import { Button, ButtonGroup, IconButton, PageHeader, SkeletonRows } from './ui';

/** The number of commits in each load. "Load more" adds this number. */
const PAGE = 500;
const ROW_HEIGHT = 28;
const LANE_WIDTH = 16;
/** The graph shows at most this number of lanes. The lanes after it are cut, so the text has room. */
const MAX_LANES = 24;
const SCOPE_STORAGE_KEY = 'shipwarden.graphScope';
const LANE_COLORS = ['var(--accent)', 'var(--info)', 'var(--purple)', 'var(--ok)', 'var(--danger)', 'var(--claude)'];

/** Where a new worktree starts: a commit, or a remote branch to check out. */
export type GraphWorktreeStart = { commit: string; label: string } | { remote: string };

interface Props {
    /** The path of the repository: its main worktree. */
    repo: string;
    repoName: string;
    /** The worktrees of the repository. A label of a branch that a worktree has checked out opens that worktree. */
    worktrees: Worktree[];
    onNewWorktree(start: GraphWorktreeStart): void;
    onOpenWorktree(worktree: Worktree): void;
}

function readScope(): GraphScope {
    try {
        return localStorage.getItem(SCOPE_STORAGE_KEY) === 'local' ? 'local' : 'all';
    } catch {
        return 'all';
    }
}

const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
const laneX = (lane: number) => LANE_WIDTH / 2 + lane * LANE_WIDTH + 2;

const WEEK_MS = 7 * 24 * 3_600_000;

/** Returns "7h ago" for a commit of the last 7 days. An older commit shows its date. */
function formatDate(ms: number): string {
    if (Date.now() - ms < WEEK_MS) return formatAgo(new Date(ms).toISOString());
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The lines and the dot of one row. A merge commit has a ring, other commits a full dot. */
function RowGraph({ row, lanes }: { row: GraphRow; lanes: number }) {
    const width = lanes * LANE_WIDTH + 4;
    const y = (value: number) => value * ROW_HEIGHT;
    const merge = row.commit.parents.length > 1;
    return (
        <svg className="gg-lanes" width={width} height={ROW_HEIGHT} aria-hidden="true">
            {row.lines.map((line, index) => {
                const x1 = laneX(line.fromLane);
                const x2 = laneX(line.toLane);
                const y1 = y(line.fromY);
                const y2 = y(line.toY);
                // A line that changes lanes bends with a curve. A straight line stays straight.
                const d = x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
                return <path key={index} d={d} stroke={laneColor(line.color)} strokeWidth={1.6} fill="none" />;
            })}
            <circle
                cx={laneX(row.lane)}
                cy={y(0.5)}
                r={merge ? 3.6 : 4.2}
                fill={merge ? 'var(--bg)' : laneColor(row.lane)}
                stroke={laneColor(row.lane)}
                strokeWidth={merge ? 2 : 0}
            />
        </svg>
    );
}

interface RefChipProps {
    gitRef: GraphRef;
    /** The worktree that has this local branch checked out. */
    worktree?: Worktree;
    onCheckout(remote: string): void;
    onOpenWorktree(worktree: Worktree): void;
}

function RefChip({ gitRef, worktree, onCheckout, onOpenWorktree }: RefChipProps) {
    const className = `gg-ref ${gitRef.kind}${gitRef.current ? ' current' : ''}${worktree ? ' in-worktree' : ''}`;
    const action =
        gitRef.kind === 'remote'
            ? { title: `Check out ${gitRef.name} in a new worktree`, run: () => onCheckout(gitRef.name) }
            : worktree
              ? { title: `Open the worktree of ${gitRef.name}`, run: () => onOpenWorktree(worktree) }
              : undefined;
    if (action) {
        return (
            <button
                className={className}
                title={action.title}
                onClick={event => {
                    event.stopPropagation();
                    action.run();
                }}
            >
                {gitRef.name}
            </button>
        );
    }
    const title = gitRef.kind === 'tag' ? `Tag ${gitRef.name}` : gitRef.kind === 'head' ? 'Detached HEAD' : `Local branch ${gitRef.name}`;
    return (
        <span className={className} title={title}>
            {gitRef.name}
        </span>
    );
}

/**
 * The commit graph of a repository on a full page, like `git log --graph`. The user can start a new worktree from a
 * commit, check out a remote branch in a new worktree, or open the worktree of a local branch.
 */
export function GitGraphView({ repo, repoName, worktrees, onNewWorktree, onOpenWorktree }: Props) {
    const [scope, setScope] = useState<GraphScope>(readScope);
    const [limit, setLimit] = useState(PAGE);
    const [log, setLog] = useState<GraphLog>();
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(false);
    const [reloads, setReloads] = useState(0);

    const reload = useCallback(() => setReloads(value => value + 1), []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: A different repository clears the old log and the page limit.
    useEffect(() => {
        setLog(undefined);
        setError(undefined);
        setLimit(PAGE);
    }, [repo]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: A change of reloads loads the log again.
    useEffect(() => {
        let current = true;
        setLoading(true);
        window.shipwarden.git
            .log(repo, scope, limit)
            .then(
                result => {
                    if (!current) return;
                    setLog(result);
                    setError(undefined);
                },
                err => current && setError(errorText(err))
            )
            .finally(() => current && setLoading(false));
        return () => {
            current = false;
        };
    }, [repo, scope, limit, reloads]);

    useEffect(() => {
        const off = onGitChanged(reload);
        window.addEventListener('focus', reload);
        return () => {
            off();
            window.removeEventListener('focus', reload);
        };
    }, [reload]);

    const layout = useMemo(() => layoutGraph(log?.commits ?? []), [log]);
    const lanes = Math.min(Math.max(layout.width, 1), MAX_LANES);
    const worktreeOfBranch = useMemo(() => new Map(worktrees.filter(item => item.branch).map(item => [item.branch!, item])), [worktrees]);

    const changeScope = (next: GraphScope) => {
        setScope(next);
        setLimit(PAGE);
        try {
            localStorage.setItem(SCOPE_STORAGE_KEY, next);
        } catch {
            // The scope stays for this session only.
        }
    };

    return (
        <div className="git-graph-view">
            <PageHeader
                icon={GitGraph}
                title={repoName}
                meta={log ? (log.more ? `${log.commits.length}+ commits` : pluralize(log.commits.length, 'commit')) : undefined}
                scope={
                    <ButtonGroup role="radiogroup" size="lg" label="Commits to show" onKeyDown={radioGroupKeys}>
                        {(['all', 'local'] as const).map(value => (
                            <Button key={value} role="radio" aria-checked={scope === value} onClick={() => changeScope(value)}>
                                {value === 'all' ? 'All branches' : 'Local branches'}
                            </Button>
                        ))}
                    </ButtonGroup>
                }
                actions={
                    <IconButton size="lg" icon={<RefreshCw size={16} strokeWidth={1.6} className={loading ? 'spin' : ''} />} label="Refresh" onClick={reload} />
                }
            />
            {error && <div className="form-error pp-error">{error}</div>}
            {!log && !error && <SkeletonRows count={8} label="Loading the history" />}
            {log?.commits.length === 0 && <div className="panel-note pp-note">The repository has no commits.</div>}
            <div className="gg-rows" onKeyDown={moveListFocus}>
                {layout.rows.map(row => {
                    const { commit } = row;
                    const short = commit.hash.slice(0, 7);
                    return (
                        <div
                            key={commit.hash}
                            className="gg-row"
                            style={{ height: ROW_HEIGHT }}
                            tabIndex={0}
                            role="group"
                            aria-label={`${short} ${commit.subject}`}
                            data-nav-item
                        >
                            <RowGraph row={row} lanes={lanes} />
                            <div className="gg-subject" title={commit.subject}>
                                {commit.refs.map(gitRef => (
                                    <RefChip
                                        key={`${gitRef.kind}:${gitRef.name}`}
                                        gitRef={gitRef}
                                        worktree={gitRef.kind === 'local' ? worktreeOfBranch.get(gitRef.name) : undefined}
                                        onCheckout={remote => onNewWorktree({ remote })}
                                        onOpenWorktree={onOpenWorktree}
                                    />
                                ))}
                                <span className="gg-subject-text">{commit.subject}</span>
                            </div>
                            <span className="gg-author" title={commit.author}>
                                {commit.author}
                            </span>
                            <span className="gg-date" title={new Date(commit.date).toLocaleString()}>
                                {formatDate(commit.date)}
                            </span>
                            <span className="gg-hash mono" title={commit.hash}>
                                {short}
                            </span>
                            <IconButton
                                size="sm"
                                className="gg-action"
                                icon={<FolderGit2 size={14} strokeWidth={1.7} />}
                                label={`New worktree from ${short}`}
                                onClick={() => onNewWorktree({ commit: commit.hash, label: `${short} ${commit.subject}` })}
                            />
                        </div>
                    );
                })}
                {log?.more && (
                    <Button
                        className="gg-more"
                        disabled={loading}
                        icon={loading ? <LoaderCircle size={12} className="spin" /> : undefined}
                        onClick={() => setLimit(value => value + PAGE)}
                    >
                        Load more commits
                    </Button>
                )}
            </div>
        </div>
    );
}
