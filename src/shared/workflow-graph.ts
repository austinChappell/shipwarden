import type { CheckConclusion, CheckRun, CheckStatus } from './github';

/** A job of a workflow file (`jobs.<id>`). The graph gets its edges from these jobs. */
export interface WorkflowJobSpec {
    /** The key of the job in the file. */
    id: string;
    /** The `name` of the job. It can contain `${{ }}` expressions. */
    name?: string;
    /** The IDs of the jobs in `needs`. */
    needs: string[];
    /** True when the job has a `strategy.matrix`. GitHub runs one job for each matrix value. */
    matrix: boolean;
    /** True when the job calls a reusable workflow (`uses`). GitHub names its jobs "<name> / <inner job>". */
    reusable: boolean;
}

/** A box row of the graph: one job, or a group of the jobs of a matrix or a reusable workflow. */
export interface GraphNode {
    /** The ID of the job in the file. A job that matches no job of the file has the ID "job:<check ID>". */
    id: string;
    label: string;
    /** "group" for a matrix or a reusable workflow. The group shows a count and a list of its jobs. */
    kind: 'job' | 'group';
    /** The jobs of the run for this node. An empty list means that the job did not start yet. */
    jobs: CheckRun[];
}

/** One box of the graph. All nodes in a box have the same `needs`. */
export interface GraphStack {
    id: string;
    nodes: GraphNode[];
}

/** An edge from a node to the box of the jobs that need it. */
export interface GraphEdge {
    from: string;
    to: string;
}

export interface WorkflowGraph {
    /** The columns from left to right. A job is in the column after its latest need. */
    columns: GraphStack[][];
    edges: GraphEdge[];
}

/** The state of a group: the jobs that completed, and one status for all jobs. */
export interface GroupState {
    status: CheckStatus;
    conclusion: CheckConclusion;
    completed: number;
    total: number;
}

const FAILED = new Set<CheckConclusion>(['failure', 'timed_out', 'cancelled', 'action_required', 'error']);

/** Returns one status for the jobs of a group. A failed job wins, then a running job, then a waiting job. */
export function groupState(jobs: readonly CheckRun[]): GroupState {
    const completed = jobs.filter(job => job.status === 'completed').length;
    const base = { completed, total: jobs.length };
    if (jobs.some(job => FAILED.has(job.conclusion))) return { ...base, status: 'completed', conclusion: 'failure' };
    if (jobs.some(job => job.status === 'in_progress')) return { ...base, status: 'in_progress', conclusion: null };
    if (completed < jobs.length) return { ...base, status: 'queued', conclusion: null };
    if (jobs.length > 0 && jobs.every(job => job.conclusion === 'skipped')) return { ...base, status: 'completed', conclusion: 'skipped' };
    return { ...base, status: 'completed', conclusion: 'success' };
}

/**
 * Returns the short name of a job in a group: the inner job of a reusable workflow, or the matrix values of a matrix
 * job. The name of the group already shows the rest.
 */
export function shortJobName(name: string): string {
    const slash = name.lastIndexOf(' / ');
    if (slash >= 0) return name.slice(slash + 3);
    const matrix = /^.+? \((.+?)\)?$/.exec(name);
    return matrix ? matrix[1] : name;
}

const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;

/** Returns the name that GitHub shows for a job of the file, before it adds matrix values or inner jobs. */
function displayName(spec: WorkflowJobSpec): string {
    return spec.name ?? spec.id;
}

/** Returns the literal text of a name, without its expressions. A longer literal text is a more specific name. */
function literalLength(name: string): number {
    return name.replace(EXPRESSION, '').length;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns a pattern for the job names of a job of the file. An expression matches any text. GitHub adds
 * " (<matrix values>)" to a matrix job when the name has no matrix expression, and " / <inner job>" to the jobs of a
 * reusable workflow. GitHub cuts a long name and adds "...", so the matrix values can have no ")".
 */
function namePattern(spec: WorkflowJobSpec): RegExp {
    const name = displayName(spec);
    const parts = name.split(EXPRESSION).map(escapeRegExp);
    return new RegExp(`^${parts.join('.+?')}(?: \\(.+)?(?: / .+)?$`);
}

/** Returns the label of a node. A name with an expression shows as the ID of the job. */
function labelOf(spec: WorkflowJobSpec): string {
    const name = displayName(spec);
    return name.match(EXPRESSION) ? spec.id : name;
}

/**
 * Finds the jobs of each job of the file. First the exact names match, then the patterns, the most specific pattern
 * first. Returns the jobs of each ID, and the jobs that match no job of the file.
 */
export function matchJobs(specs: readonly WorkflowJobSpec[], jobs: readonly CheckRun[]): { byId: Map<string, CheckRun[]>; rest: CheckRun[] } {
    const byId = new Map<string, CheckRun[]>(specs.map(spec => [spec.id, []]));
    const exact = new Map<string, string>();
    for (const spec of specs) {
        const name = displayName(spec);
        if (!name.match(EXPRESSION) && !exact.has(name)) exact.set(name, spec.id);
    }
    const patterns = [...specs]
        .sort((a, b) => literalLength(displayName(b)) - literalLength(displayName(a)))
        .map(spec => ({ id: spec.id, pattern: namePattern(spec) }));
    const rest: CheckRun[] = [];
    for (const job of jobs) {
        const id = exact.get(job.name) ?? patterns.find(item => item.pattern.test(job.name))?.id;
        if (id === undefined) rest.push(job);
        else byId.get(id)?.push(job);
    }
    return { byId, rest };
}

/**
 * Builds the graph of a run from the jobs of its workflow file and the jobs of the run.
 * A job is in the column after its latest need. The jobs with the same needs share one box. A job of the run that
 * matches no job of the file is a box of its own in the first column.
 */
export function buildWorkflowGraph(specs: readonly WorkflowJobSpec[], jobs: readonly CheckRun[]): WorkflowGraph {
    const known = new Set(specs.map(spec => spec.id));
    const needsOf = new Map(specs.map(spec => [spec.id, [...new Set(spec.needs.filter(need => known.has(need) && need !== spec.id))]]));
    const { byId, rest } = matchJobs(specs, jobs);

    // The column of a job is the length of its longest chain of needs. A cycle stops the count.
    const depth = new Map<string, number>();
    const depthOf = (id: string, seen: Set<string>): number => {
        const cached = depth.get(id);
        if (cached !== undefined) return cached;
        if (seen.has(id)) return 0;
        seen.add(id);
        const needs = needsOf.get(id) ?? [];
        const value = needs.length === 0 ? 0 : 1 + Math.max(...needs.map(need => depthOf(need, seen)));
        seen.delete(id);
        depth.set(id, value);
        return value;
    };

    const nodeOf = (spec: WorkflowJobSpec): GraphNode => {
        const matched = byId.get(spec.id) ?? [];
        const group = spec.matrix || spec.reusable || matched.length > 1;
        return {
            id: spec.id,
            label: spec.matrix ? `Matrix: ${labelOf(spec)}` : labelOf(spec),
            kind: group ? 'group' : 'job',
            jobs: matched
        };
    };

    // The boxes of each column. The jobs without needs each get a box. The other jobs share a box by their needs.
    const columnBoxes: { stack: GraphStack; needs: string[] }[][] = [];
    const boxByKey = new Map<string, { stack: GraphStack; needs: string[] }>();
    const addBox = (column: number, key: string | undefined, id: string, needs: string[]) => {
        while (columnBoxes.length <= column) columnBoxes.push([]);
        const existing = key === undefined ? undefined : boxByKey.get(key);
        if (existing) return existing;
        const box = { stack: { id, nodes: [] as GraphNode[] }, needs };
        columnBoxes[column].push(box);
        if (key !== undefined) boxByKey.set(key, box);
        return box;
    };
    for (const spec of specs) {
        const needs = needsOf.get(spec.id) ?? [];
        const column = depthOf(spec.id, new Set());
        const key = needs.length === 0 ? undefined : `${column}\u0000${[...needs].sort().join('\u0000')}`;
        addBox(column, key, `stack:${spec.id}`, needs).stack.nodes.push(nodeOf(spec));
    }
    for (const job of rest) {
        const id = `job:${job.id}`;
        addBox(0, undefined, `stack:${id}`, []).stack.nodes.push({ id, label: job.name, kind: 'job', jobs: [job] });
    }

    // Sorts the boxes of each column by the mean row of their needs, so that fewer edges cross.
    const rowOf = new Map<string, number>();
    const columns = columnBoxes.map((boxes, index) => {
        const sorted =
            index === 0
                ? boxes
                : boxes
                      .map((box, order) => {
                          const rows = box.needs.map(need => rowOf.get(need) ?? 0);
                          return { box, order, mean: rows.reduce((sum, row) => sum + row, 0) / Math.max(rows.length, 1) };
                      })
                      .sort((a, b) => a.mean - b.mean || a.order - b.order)
                      .map(item => item.box);
        let row = 0;
        for (const box of sorted) {
            for (const node of box.stack.nodes) rowOf.set(node.id, row++);
        }
        return sorted;
    });

    const edges: GraphEdge[] = [];
    for (const box of columns.flat()) {
        for (const need of box.needs) edges.push({ from: need, to: box.stack.id });
    }
    return { columns: columns.map(boxes => boxes.map(box => box.stack)), edges };
}
