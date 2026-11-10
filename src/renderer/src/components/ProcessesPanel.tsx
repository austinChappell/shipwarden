import { useCallback, useEffect, useState } from 'react';
import { Bot, ChevronRight, CircleStop, ExternalLink, LoaderCircle, RefreshCw, SquareTerminal } from 'lucide-react';
import { portUrl, type ListeningPort, type ProcessInfo, type ProcessTree, type WorktreeProcesses } from '@shared/processes';
import { errorText } from '../util';
import { openLink } from '../links';

const POLL_MS = 3000;

interface Props {
    worktreePath: string;
    /** Shows the terminal tab of a session. */
    onShowTerminal?(sessionId: string): void;
}

function formatMemory(kb: number): string {
    if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
    if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
    return `${kb} KB`;
}

/** Converts the "[[dd-]hh:]mm:ss" time of ps to a short text, for example "5m" or "2h 10m". */
function formatElapsed(value: string): string {
    const [days, rest] = value.includes('-') ? value.split('-') : ['0', value];
    const parts = rest.split(':').map(Number).reverse();
    const seconds = parts[0] ?? 0;
    const minutes = parts[1] ?? 0;
    const hours = parts[2] ?? 0;
    if (Number(days) > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

/** The arguments of a command line, without the program. The name of the program shows next to it. */
function commandArguments(command: string): string {
    const index = command.search(/\s/);
    return index < 0 ? '' : command.slice(index + 1).trim();
}

function PortChips({ ports }: { ports: ListeningPort[] }) {
    return (
        <>
            {ports.map(port => (
                <button
                    key={port.port}
                    className="port-chip"
                    title={`Open ${portUrl(port)} in the browser (⇧⌘-click: in ShipWarden). The process listens on ${port.address}:${port.port}.`}
                    onClick={event => {
                        event.stopPropagation();
                        openLink(portUrl(port), event);
                    }}
                >
                    :{port.port}
                </button>
            ))}
        </>
    );
}

function ProcessLine({
    process,
    ports,
    stopping,
    onStop,
    children
}: {
    process: ProcessInfo;
    ports: ListeningPort[];
    stopping: boolean;
    onStop(): void;
    children?: React.ReactNode;
}) {
    return (
        <div className="process-line">
            {children}
            <span className="process-name" title={process.command}>
                {process.name}
            </span>
            <span className="process-command" title={process.command}>
                {commandArguments(process.command)}
            </span>
            <PortChips ports={ports} />
            <span
                className="process-stats"
                title={`PID ${process.pid}. CPU ${process.cpu}%. Memory ${formatMemory(process.rssKb)}. Runs for ${formatElapsed(process.elapsed)}.`}
            >
                {formatElapsed(process.elapsed)}
            </span>
            <button
                className="icon-button process-stop"
                title={`Stop ${process.name} (PID ${process.pid}) and its child processes`}
                disabled={stopping}
                onClick={onStop}
            >
                {stopping ? <LoaderCircle size={13} className="spin" /> : <CircleStop size={14} strokeWidth={1.7} />}
            </button>
        </div>
    );
}

function TreeRow({ tree, stopping, onStop }: { tree: ProcessTree; stopping: Set<number>; onStop(pid: number): void }) {
    const [open, setOpen] = useState(false);
    const hasChildren = tree.descendants.length > 0;
    return (
        <div className="process-tree">
            <ProcessLine process={tree.root} ports={tree.ports} stopping={stopping.has(tree.root.pid)} onStop={() => onStop(tree.root.pid)}>
                <button
                    className={`process-toggle${hasChildren ? '' : ' empty'}`}
                    title={hasChildren ? `${open ? 'Hide' : 'Show'} ${tree.descendants.length} child processes` : undefined}
                    disabled={!hasChildren}
                    onClick={() => setOpen(value => !value)}
                >
                    {hasChildren && <ChevronRight size={12} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />}
                </button>
            </ProcessLine>
            {open &&
                tree.descendants.map(child => (
                    <div key={child.pid} className="process-child">
                        <ProcessLine process={child} ports={child.ports} stopping={stopping.has(child.pid)} onStop={() => onStop(child.pid)} />
                    </div>
                ))}
        </div>
    );
}

/**
 * The Processes tab of the right panel: the processes that the terminals of the worktree started, the other
 * processes in the worktree folder, and their listening ports. The user can stop each process.
 */
export function ProcessesPanel({ worktreePath, onShowTerminal }: Props) {
    const [data, setData] = useState<WorktreeProcesses>();
    const [error, setError] = useState<string>();
    const [stopping, setStopping] = useState(new Set<number>());

    const load = useCallback(async () => {
        try {
            const [result] = await window.shipwarden.processes.list([worktreePath]);
            setData(result);
            setError(undefined);
        } catch (err) {
            setError(errorText(err));
        }
    }, [worktreePath]);

    useEffect(() => {
        setData(undefined);
        void load();
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible') void load();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    const stop = async (pid: number) => {
        setStopping(set => new Set(set).add(pid));
        try {
            await window.shipwarden.processes.stop(worktreePath, pid);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setStopping(set => {
                const next = new Set(set);
                next.delete(pid);
                return next;
            });
            await load();
        }
    };

    if (!data) {
        return (
            <div className="panel-message">
                {error ?? (
                    <>
                        <LoaderCircle size={14} className="spin" /> Looking for processes…
                    </>
                )}
            </div>
        );
    }

    const terminals = data.terminals.filter(terminal => terminal.jobs.length > 0);
    const trees = [...terminals.flatMap(terminal => terminal.jobs), ...data.others];
    const ports = trees
        .flatMap(tree => tree.ports.map(port => ({ port, tree })))
        .filter((item, index, list) => list.findIndex(other => other.port.port === item.port.port) === index)
        .sort((a, b) => a.port.port - b.port.port);

    return (
        <div className="processes-panel">
            <div className="processes-header">
                <span className="processes-summary">
                    {trees.length === 0 ? 'No running processes' : `${trees.length} running · ${ports.length} ${ports.length === 1 ? 'port' : 'ports'}`}
                </span>
                <button className="icon-button" title="Refresh" onClick={() => void load()}>
                    <RefreshCw size={14} strokeWidth={1.6} />
                </button>
            </div>
            {error && <div className="form-error">{error}</div>}

            {ports.length > 0 && (
                <section className="processes-section">
                    <div className="section-title">Ports</div>
                    {ports.map(({ port, tree }) => (
                        <div key={port.port} className="port-row">
                            <button
                                className="port-link"
                                title={`Open ${portUrl(port)} in the browser (⇧⌘-click: in ShipWarden)`}
                                onClick={event => openLink(portUrl(port), event)}
                            >
                                localhost:{port.port}
                                <ExternalLink size={11} strokeWidth={1.8} />
                            </button>
                            <span className="process-command" title={tree.root.command}>
                                {tree.root.name}
                            </span>
                            <button
                                className="icon-button process-stop"
                                title={`Stop ${tree.root.name} (PID ${tree.root.pid}), which has this port`}
                                disabled={stopping.has(tree.root.pid)}
                                onClick={() => void stop(tree.root.pid)}
                            >
                                {stopping.has(tree.root.pid) ? <LoaderCircle size={13} className="spin" /> : <CircleStop size={14} strokeWidth={1.7} />}
                            </button>
                        </div>
                    ))}
                </section>
            )}

            {terminals.map(terminal => (
                <section key={terminal.shellPid} className="processes-section">
                    <div className="section-title processes-terminal">
                        {terminal.isAgent ? <Bot size={12} strokeWidth={1.8} /> : <SquareTerminal size={12} strokeWidth={1.8} />}
                        {terminal.sessionId && onShowTerminal ? (
                            <button className="link-button" title="Show the terminal tab" onClick={() => onShowTerminal(terminal.sessionId!)}>
                                {terminal.title}
                            </button>
                        ) : (
                            <span>{terminal.title}</span>
                        )}
                    </div>
                    {terminal.jobs.map(tree => (
                        <TreeRow key={tree.root.pid} tree={tree} stopping={stopping} onStop={pid => void stop(pid)} />
                    ))}
                </section>
            ))}

            {data.others.length > 0 && (
                <section className="processes-section">
                    <div className="section-title" title="These processes run in the worktree folder, but a ShipWarden terminal did not start them.">
                        Other processes in this folder
                    </div>
                    {data.others.map(tree => (
                        <TreeRow key={tree.root.pid} tree={tree} stopping={stopping} onStop={pid => void stop(pid)} />
                    ))}
                </section>
            )}

            {trees.length === 0 && (
                <p className="panel-note processes-empty">
                    The processes that you start in the terminals of this worktree show here, with their ports. A closed terminal tab or a removed worktree
                    stops its processes.
                </p>
            )}
        </div>
    );
}
