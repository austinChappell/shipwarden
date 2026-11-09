import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderGit2, LoaderCircle, RefreshCw } from 'lucide-react';
import { layoutGraph, type GraphLog, type GraphRef, type GraphRow, type GraphScope } from '@shared/git-graph';
import { onGitChanged } from '../git/git-store';
import { errorText } from '../util';

/** The number of commits in each load. "Load more" adds this number. */
const PAGE = 300;
const ROW_HEIGHT = 38;
const LANE_WIDTH = 14;
/** The graph shows at most this number of lanes. The lanes after it are cut, so the text has room. */
const MAX_LANES = 10;
const SCOPE_STORAGE_KEY = 'shipwarden.graphScope';
const LANE_COLORS = ['var(--accent)', 'var(--info)', 'var(--purple)', 'var(--ok)', 'var(--danger)', 'var(--claude)'];

/** Where a new worktree starts: a commit, or a remote branch to check out. */
export type GraphWorktreeStart = { commit: string; label: string } | { remote: string };

interface Props {
    root: string;
    /** A value that changes when the commits can change, for example after a commit or a fetch. Then the graph loads again. */
    version: string;
    onNewWorktree(start: GraphWorktreeStart): void;
}

function readScope(): GraphScope {
    try {
        return localStorage.getItem(SCOPE_STORAGE_KEY) === 'head' ? 'head' : 'all';
    } catch {
        return 'all';
    }
}

const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
const laneX = (lane: number) => LANE_WIDTH / 2 + lane * LANE_WIDTH + 2;

function shortAgo(ms: number): string {
    const seconds = Math.round((Date.now() - ms) / 1000);
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    if (seconds < 86400 * 365) return `${Math.floor(seconds / 86400)}d`;
    return `${Math.floor(seconds / (86400 * 365))}y`;
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
                r={merge ? 3.4 : 4}
                fill={merge ? 'var(--panel)' : laneColor(row.lane)}
                stroke={laneColor(row.lane)}
                strokeWidth={merge ? 2 : 0}
            />
        </svg>
    );
}

function RefChip({ gitRef, onCheckout }: { gitRef: GraphRef; onCheckout(remote: string): void }) {
    const className = `gg-ref ${gitRef.kind}${gitRef.current ? ' current' : ''}`;
    if (gitRef.kind === 'remote') {
        return (
            <button
                className={className}
                title={`Check out ${gitRef.name} in a new worktree`}
                onClick={event => {
                    event.stopPropagation();
                    onCheckout(gitRef.name);
                }}
            >
                {gitRef.name}
            </button>
        );
    }
    const title = gitRef.kind === 'tag' ? `Tag ${gitRef.name}` : gitRef.current ? `${gitRef.name} (checked out here)` : gitRef.kind === 'head' ? 'Detached HEAD' : `Local branch ${gitRef.name}`;
    return <span className={className} title={title}>{gitRef.name}</span>;
}

/**
 * The Graph tab of the right panel: the commit history of the repository with its branch lines, like
 * `git log --graph`. The user can start a new worktree from a commit, or check out a remote branch in a new worktree.
 */
export function GitGraphPanel({ root, version, onNewWorktree }: Props) {
    const [scope, setScope] = useState<GraphScope>(readScope);
    const [limit, setLimit] = useState(PAGE);
    const [log, setLog] = useState<GraphLog>();
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(false);
    const [reloads, setReloads] = useState(0);

    const reload = useCallback(() => setReloads(value => value + 1), []);

    useEffect(() => {
        let current = true;
        setLoading(true);
        window.shipwarden.git.log(root, scope, limit).then(
            result => {
                if (!current) return;
                setLog(result);
                setError(undefined);
            },
            err => current && setError(errorText(err))
        ).finally(() => current && setLoading(false));
        return () => {
            current = false;
        };
    }, [root, scope, limit, version, reloads]);

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
        <div className="git-graph-panel">
            <div className="pp-header">
                <div className="segmented compact gg-scope" role="radiogroup" aria-label="Commits to show">
                    {(['all', 'head'] as const).map(value => (
                        <button
                            key={value}
                            role="radio"
                            aria-checked={scope === value}
                            className={scope === value ? 'selected' : ''}
                            onClick={() => changeScope(value)}
                        >
                            {value === 'all' ? 'All branches' : 'This branch'}
                        </button>
                    ))}
                </div>
                <span className="header-spacer" />
                <button className="icon-button" title="Refresh" onClick={reload}>
                    <RefreshCw size={14} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                </button>
            </div>
            {error && <div className="form-error pp-error">{error}</div>}
            {!log && !error && <div className="panel-note pp-note"><LoaderCircle size={12} className="spin" /> Reading the history…</div>}
            {log?.commits.length === 0 && <div className="panel-note pp-note">The repository has no commits.</div>}
            <div className="gg-rows">
                {layout.rows.map(row => {
                    const { commit } = row;
                    const short = commit.hash.slice(0, 7);
                    return (
                        <div
                            key={commit.hash}
                            className="gg-row"
                            style={{ height: ROW_HEIGHT }}
                            title={`${commit.hash}\n${commit.author} · ${new Date(commit.date).toLocaleString()}\n\n${commit.subject}`}
                        >
                            <RowGraph row={row} lanes={lanes} />
                            <div className="gg-text">
                                <div className="gg-subject">
                                    {commit.refs.map(gitRef => (
                                        <RefChip key={`${gitRef.kind}:${gitRef.name}`} gitRef={gitRef} onCheckout={remote => onNewWorktree({ remote })} />
                                    ))}
                                    <span className="gg-subject-text">{commit.subject}</span>
                                </div>
                                <div className="gg-meta">
                                    <span className="mono">{short}</span> · {commit.author} · {shortAgo(commit.date)}
                                </div>
                            </div>
                            <button
                                className="icon-button gg-action"
                                title={`New worktree from ${short}`}
                                onClick={() => onNewWorktree({ commit: commit.hash, label: `${short} ${commit.subject}` })}
                            >
                                <FolderGit2 size={14} strokeWidth={1.7} />
                            </button>
                        </div>
                    );
                })}
                {log?.more && (
                    <button className="button gg-more" disabled={loading} onClick={() => setLimit(value => value + PAGE)}>
                        {loading && <LoaderCircle size={12} className="spin" />} Load more commits
                    </button>
                )}
            </div>
        </div>
    );
}
