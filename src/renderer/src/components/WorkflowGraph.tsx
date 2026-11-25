import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Circle, Workflow } from 'lucide-react';
import type { CheckRun, RepoTarget } from '@shared/github';
import { buildWorkflowGraph, groupState, shortJobName, type GraphNode, type WorkflowGraph as Graph } from '@shared/workflow-graph';
import { pluralize } from '@shared/format';
import { formatDuration } from '../util';
import { CheckIcon } from './ChecksPanel';
import { Button } from './ui';
import { workflowJobsQuery, workflowRunQuery } from '../github/ci-queries';

const GRAPH_SHOWN_KEY = 'shipwarden.workflowGraphShown';

/** The listeners of the Graph choice. All views that show a graph share one choice. */
const graphListeners = new Set<() => void>();

function readGraphShown(): boolean {
    try {
        return localStorage.getItem(GRAPH_SHOWN_KEY) !== 'false';
    } catch {
        return true;
    }
}

let graphShown = readGraphShown();

function setGraphShown(value: boolean): void {
    graphShown = value;
    try {
        localStorage.setItem(GRAPH_SHOWN_KEY, String(value));
    } catch {
        // The choice stays for this session only.
    }
    for (const listener of graphListeners) listener();
}

function subscribeGraphShown(listener: () => void): () => void {
    graphListeners.add(listener);
    return () => graphListeners.delete(listener);
}

/** True when the user shows the job graphs. The Pipelines view and the Checks panels share the choice. */
export function useGraphShown(): boolean {
    return useSyncExternalStore(subscribeGraphShown, () => graphShown);
}

/** The button that shows or hides the job graphs. The list of the jobs always shows. */
export function GraphToggle() {
    const shown = useGraphShown();
    return (
        <Button
            size="sm"
            active={shown}
            aria-pressed={shown}
            icon={<Workflow size={13} strokeWidth={1.8} />}
            title={shown ? 'Hide the job graph' : 'Show the job graph'}
            onClick={() => setGraphShown(!shown)}
        >
            Graph
        </Button>
    );
}

/** The graph of one workflow run of a commit, with the name of its workflow and its trigger. It shows when it is ready. */
function RunGraph({
    target,
    runId,
    checks,
    selectedId,
    onOpen
}: {
    target: RepoTarget;
    runId: number;
    checks: CheckRun[];
    selectedId?: number;
    onOpen(check: CheckRun): void;
}) {
    const run = useQuery(workflowRunQuery(target, runId)).data;
    const specs = useQuery(workflowJobsQuery(target, run?.path, run?.headSha)).data;
    const graph = useMemo(() => (specs ? buildWorkflowGraph(specs, checks) : undefined), [specs, checks]);
    if (!run || !graph) return null;
    return (
        <section className="run-graph">
            <div className="run-graph-title">
                <span className="run-graph-name">{run.workflowName}</span>
                <span className="run-graph-event">on: {run.event}</span>
            </div>
            <WorkflowGraph graph={graph} selectedJobId={selectedId} onSelectJob={onOpen} />
        </section>
    );
}

/**
 * Returns the GitHub Actions checks of each workflow run. Other checks have no graph. An old check of a replaced run
 * goes into the newer run, so that one workflow has one graph.
 */
export function checksByRun(checks: readonly CheckRun[] | undefined): Map<number, CheckRun[]> {
    const byRun = new Map<number, CheckRun[]>();
    for (const check of checks ?? []) {
        const runId = check.newerRunId ?? check.runId;
        if (!check.isActions || runId === undefined) continue;
        byRun.set(runId, [...(byRun.get(runId) ?? []), check]);
    }
    return byRun;
}

/**
 * The job graphs of the checks of a commit: one graph for each workflow run. Only GitHub has the workflow files for a
 * graph. A run whose workflow file is not found has no graph.
 */
export function CommitGraphs({
    target,
    checks,
    selectedId,
    onOpen
}: {
    target: RepoTarget;
    checks: readonly CheckRun[] | undefined;
    selectedId?: number;
    onOpen(check: CheckRun): void;
}) {
    const runs = useMemo(() => checksByRun(checks), [checks]);
    return (
        <>
            {[...runs].map(([runId, runChecks]) => (
                <RunGraph key={runId} target={target} runId={runId} checks={runChecks} selectedId={selectedId} onOpen={onOpen} />
            ))}
        </>
    );
}

interface Props {
    graph: Graph;
    /** The ID of the job whose log shows. Its row has the selected look. */
    selectedJobId?: number;
    onSelectJob(job: CheckRun): void;
}

/** A line of the graph, in the coordinates of the canvas. */
interface Line {
    key: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/** The icon of a job that did not start yet. */
function WaitingIcon() {
    return <Circle size={15} strokeWidth={1.8} className="check-icon skipped" />;
}

/** One job of the run: its status, its name and its duration. A click opens its log. */
function JobRow({
    job,
    label,
    nodeId,
    selected,
    onSelect
}: {
    job: CheckRun;
    label: string;
    nodeId?: string;
    selected: boolean;
    onSelect(job: CheckRun): void;
}) {
    return (
        <button
            className={`wg-job${selected ? ' selected' : ''}`}
            data-node={nodeId}
            data-nav-item
            aria-pressed={selected}
            title={`Open the log of ${job.name}`}
            onClick={() => onSelect(job)}
        >
            <CheckIcon check={job} />
            <span className="wg-job-name">{label}</span>
            <span className="wg-job-time">{formatDuration(job.startedAt, job.completedAt)}</span>
        </button>
    );
}

/** A matrix or a reusable workflow: a count of its completed jobs, and a list of its jobs that the user can open. */
function GroupNode({
    node,
    open,
    selectedJobId,
    onToggle,
    onSelect
}: {
    node: GraphNode;
    open: boolean;
    selectedJobId?: number;
    onToggle(): void;
    onSelect(job: CheckRun): void;
}) {
    const state = groupState(node.jobs);
    return (
        <div className="wg-group">
            <div className="wg-group-label">{node.label}</div>
            <div className="wg-group-head" data-node={node.id}>
                {node.jobs.length ? <CheckIcon check={state} /> : <WaitingIcon />}
                <span className="wg-job-name">{node.jobs.length ? `${state.completed}/${pluralize(state.total, 'job')} completed` : 'Waiting'}</span>
            </div>
            {node.jobs.length > 0 && (
                <button className="wg-group-toggle" aria-expanded={open} onClick={onToggle}>
                    {open ? 'Hide the jobs' : 'Show all jobs'}
                </button>
            )}
            {open &&
                node.jobs.map(job => <JobRow key={job.id} job={job} label={shortJobName(job.name)} selected={job.id === selectedJobId} onSelect={onSelect} />)}
        </div>
    );
}

/** Returns an S curve from the first point to the second point: horizontal, or vertical in the vertical layout. */
function curve({ x1, y1, x2, y2 }: Line, vertical: boolean): string {
    if (vertical) {
        const bend = Math.max(8, (y2 - y1) / 2);
        return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
    }
    const bend = Math.max(16, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** The width of a box, the gap between two columns, and the padding of the canvas. The values are the same as in the CSS. */
const STACK_WIDTH = 272;
const COLUMN_GAP = 56;
const CANVAS_PADDING = 16;

/** Returns the width that the horizontal layout needs for the columns. */
function horizontalWidth(columns: number): number {
    return columns * STACK_WIDTH + Math.max(columns - 1, 0) * COLUMN_GAP + 2 * CANVAS_PADDING;
}

/**
 * The graph of a workflow run: one column for each step of the `needs` chain, from left to right. A line connects a
 * job to the box of the jobs that need it. The lines come from the positions of the boxes after the layout.
 * When the parent is too narrow for two columns, the steps go from top to bottom, and a line connects a step to a box.
 */
export function WorkflowGraph({ graph, selectedJobId, onSelectJob }: Props) {
    const canvasRef = useRef<HTMLDivElement>(null);
    const [lines, setLines] = useState<Line[]>([]);
    const [size, setSize] = useState({ width: 0, height: 0 });
    /** The groups whose job list shows. */
    const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
    /** True when the parent is too narrow for the columns. */
    const [vertical, setVertical] = useState(false);

    useLayoutEffect(() => {
        const parent = canvasRef.current?.parentElement;
        if (!parent) return;
        // A pane that shows two columns scrolls to the other columns. A narrower pane gets the vertical layout.
        const needed = horizontalWidth(Math.min(graph.columns.length, 2));
        const check = () => setVertical(parent.clientWidth > 0 && parent.clientWidth < needed);
        check();
        const observer = new ResizeObserver(check);
        observer.observe(parent);
        return () => observer.disconnect();
    }, [graph]);

    const toggleGroup = (id: string) =>
        setOpenGroups(current => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    // An open or closed group moves the rows below it, so the lines must move too.
    // biome-ignore lint/correctness/useExhaustiveDependencies: openGroups changes the positions that the effect reads.
    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const measure = () => {
            const origin = canvas.getBoundingClientRect();
            const next: Line[] = [];
            if (vertical) {
                // One line from the bottom of a step to the top of each box that needs a job of the step. A line between
                // two boxes of the same step would show a need that is not there.
                const seen = new Set<string>();
                for (const edge of graph.edges) {
                    const from = canvas.querySelector<HTMLElement>(`[data-node="${CSS.escape(edge.from)}"]`)?.closest<HTMLElement>('[data-column]');
                    const stack = canvas.querySelector<HTMLElement>(`[data-stack="${CSS.escape(edge.to)}"]`);
                    const key = `${from?.dataset.column}>${edge.to}`;
                    if (!from || !stack || seen.has(key)) continue;
                    seen.add(key);
                    const fromRect = from.getBoundingClientRect();
                    const toRect = stack.getBoundingClientRect();
                    next.push({
                        key,
                        x1: fromRect.left + fromRect.width / 2 - origin.left,
                        y1: fromRect.bottom - origin.top,
                        x2: toRect.left + toRect.width / 2 - origin.left,
                        y2: toRect.top - origin.top
                    });
                }
                setLines(next);
                setSize({ width: canvas.scrollWidth, height: canvas.scrollHeight });
                return;
            }
            for (const edge of graph.edges) {
                const from = canvas.querySelector<HTMLElement>(`[data-node="${CSS.escape(edge.from)}"]`);
                const stack = canvas.querySelector<HTMLElement>(`[data-stack="${CSS.escape(edge.to)}"]`);
                const target = stack?.querySelector<HTMLElement>('[data-node]');
                if (!from || !stack || !target) continue;
                const box = from.closest<HTMLElement>('[data-stack]') ?? from;
                const fromRect = from.getBoundingClientRect();
                const targetRect = target.getBoundingClientRect();
                next.push({
                    key: `${edge.from}>${edge.to}`,
                    x1: box.getBoundingClientRect().right - origin.left,
                    y1: fromRect.top + fromRect.height / 2 - origin.top,
                    x2: stack.getBoundingClientRect().left - origin.left,
                    y2: targetRect.top + targetRect.height / 2 - origin.top
                });
            }
            setLines(next);
            setSize({ width: canvas.scrollWidth, height: canvas.scrollHeight });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [graph, openGroups, vertical]);

    // The ends of the lines. One dot for each point, also when more lines share it.
    const dots = new Map<string, { x: number; y: number }>();
    for (const line of lines) {
        dots.set(`${line.x1},${line.y1}`, { x: line.x1, y: line.y1 });
        dots.set(`${line.x2},${line.y2}`, { x: line.x2, y: line.y2 });
    }

    return (
        <div className={`wg-canvas${vertical ? ' vertical' : ''}`} ref={canvasRef}>
            <svg className="wg-edges" width={size.width} height={size.height} aria-hidden="true">
                {lines.map(line => (
                    <path key={line.key} d={curve(line, vertical)} />
                ))}
                {[...dots].map(([key, dot]) => (
                    <circle key={key} cx={dot.x} cy={dot.y} r={3.5} />
                ))}
            </svg>
            {graph.columns.map((column, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: A column has no ID. Its position is its identity.
                <div className="wg-column" data-column={index} key={index}>
                    {column.map(stack => (
                        <div className="wg-stack" data-stack={stack.id} key={stack.id}>
                            {stack.nodes.map(node =>
                                node.kind === 'group' ? (
                                    <GroupNode
                                        key={node.id}
                                        node={node}
                                        open={openGroups.has(node.id)}
                                        selectedJobId={selectedJobId}
                                        onToggle={() => toggleGroup(node.id)}
                                        onSelect={onSelectJob}
                                    />
                                ) : node.jobs[0] ? (
                                    <JobRow
                                        key={node.id}
                                        job={node.jobs[0]}
                                        label={node.label}
                                        nodeId={node.id}
                                        selected={node.jobs[0].id === selectedJobId}
                                        onSelect={onSelectJob}
                                    />
                                ) : (
                                    <div key={node.id} className="wg-job waiting" data-node={node.id} title="This job did not start.">
                                        <WaitingIcon />
                                        <span className="wg-job-name">{node.label}</span>
                                    </div>
                                )
                            )}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}
