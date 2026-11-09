/** The kind of a ref that points to a commit. */
export type GraphRefKind = 'head' | 'local' | 'remote' | 'tag';

export interface GraphRef {
    /** The short name, for example "main", "origin/main" or "v1.0". "HEAD" for a detached HEAD. */
    name: string;
    kind: GraphRefKind;
    /** True for the local branch that HEAD points to. */
    current?: boolean;
}

/** One commit of the graph. */
export interface GraphCommit {
    hash: string;
    /** The parent hashes. The first parent is first. A merge commit has two or more. */
    parents: string[];
    author: string;
    /** The commit time in milliseconds. */
    date: number;
    subject: string;
    refs: GraphRef[];
}

/** Which commits the graph shows. */
export type GraphScope = 'all' | 'head';

export interface GraphLog {
    commits: GraphCommit[];
    /** True when the history has more commits than the limit. */
    more: boolean;
}

/**
 * Parses the ref list of `git log --decorate=full --format=%D`, for example
 * "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1". The "HEAD" ref of a remote is not included.
 */
export function parseGraphRefs(text: string): GraphRef[] {
    const refs: GraphRef[] = [];
    for (const raw of text.split(', ')) {
        let item = raw.trim();
        if (!item) continue;
        let current = false;
        if (item.startsWith('HEAD -> ')) {
            current = true;
            item = item.slice('HEAD -> '.length);
        } else if (item === 'HEAD') {
            refs.push({ name: 'HEAD', kind: 'head' });
            continue;
        }
        if (item.startsWith('tag: ')) item = item.slice('tag: '.length);
        if (item.startsWith('refs/heads/')) {
            refs.push({ name: item.slice('refs/heads/'.length), kind: 'local', ...(current ? { current } : {}) });
        } else if (item.startsWith('refs/remotes/')) {
            const name = item.slice('refs/remotes/'.length);
            if (!name.endsWith('/HEAD')) refs.push({ name, kind: 'remote' });
        } else if (item.startsWith('refs/tags/')) {
            refs.push({ name: item.slice('refs/tags/'.length), kind: 'tag' });
        }
    }
    return refs;
}

/** The format of `git log` for `parseGraphLog`. The fields are separated by NUL, and the records by RS (0x1e). */
export const GRAPH_LOG_FORMAT = '%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e';

/** Parses the output of `git log --decorate=full --format=<GRAPH_LOG_FORMAT>`. */
export function parseGraphLog(output: string): GraphCommit[] {
    const commits: GraphCommit[] = [];
    for (const record of output.split('\x1e')) {
        const fields = record.replace(/^\n/, '').split('\0');
        if (fields.length < 6 || !fields[0]) continue;
        const [hash, parents, author, seconds, refs, ...subject] = fields;
        commits.push({
            hash,
            parents: parents.split(' ').filter(Boolean),
            author,
            date: Number(seconds) * 1000,
            subject: subject.join('\0'),
            refs: parseGraphRefs(refs)
        });
    }
    return commits;
}

/**
 * One line of the graph in a row. The row is one unit high: y 0 is the top edge, 0.5 is the commit dot and 1 is the
 * bottom edge. `color` is the lane that gives the color.
 */
export interface GraphLine {
    fromLane: number;
    fromY: 0 | 0.5;
    toLane: number;
    toY: 0.5 | 1;
    color: number;
}

export interface GraphRow {
    commit: GraphCommit;
    /** The lane of the commit dot. */
    lane: number;
    lines: GraphLine[];
}

export interface GraphLayout {
    rows: GraphRow[];
    /** The number of lanes of the widest row. */
    width: number;
}

/**
 * Puts each commit in a lane, for a graph like `git log --graph`. The commits must be in topological order, children
 * before parents. A lane keeps its place while it is in use, so the lines are straight. A free lane gets the next new
 * branch line.
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphLayout {
    /** The commit that each lane waits for. Null is a free lane. */
    let lanes: (string | null)[] = [];
    const rows: GraphRow[] = [];
    let width = 0;

    const freeLane = (): number => {
        const index = lanes.indexOf(null);
        if (index >= 0) return index;
        lanes.push(null);
        return lanes.length - 1;
    };

    for (const commit of commits) {
        const waiting = lanes.flatMap((hash, index) => (hash === commit.hash ? [index] : []));
        const lane = waiting.length > 0 ? waiting[0] : freeLane();
        const lines: GraphLine[] = [];

        // The top half: the lines that come from the row above.
        lanes.forEach((hash, index) => {
            if (hash === null) return;
            if (hash === commit.hash) lines.push({ fromLane: index, fromY: 0, toLane: lane, toY: 0.5, color: index });
            else lines.push({ fromLane: index, fromY: 0, toLane: index, toY: 1, color: index });
        });

        // The lanes after this commit: the lanes that ended in this commit are free, and the commit lane waits for the
        // first parent.
        for (const index of waiting) lanes[index] = null;
        const [first, ...others] = commit.parents;
        lanes[lane] = first ?? null;
        if (first) lines.push({ fromLane: lane, fromY: 0.5, toLane: lane, toY: 1, color: lane });

        // The other parents of a merge: a lane that waits for the parent, or a new lane.
        for (const parent of others) {
            let target = lanes.indexOf(parent);
            if (target < 0) {
                target = freeLane();
                lanes[target] = parent;
            }
            lines.push({ fromLane: lane, fromY: 0.5, toLane: target, toY: 1, color: target });
        }

        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes = lanes.slice(0, -1);
        width = Math.max(width, lane + 1, lanes.length);
        rows.push({ commit, lane, lines });
    }
    return { rows, width };
}
