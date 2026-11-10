/** A process from the process table. */
export interface ProcessRow {
    pid: number;
    ppid: number;
    /** The process group. */
    pgid: number;
    /** The foreground process group of the terminal of the process. It is 0 or less when the process has no terminal. */
    tpgid: number;
    /** The CPU use in percent. */
    cpu: number;
    /** The resident memory in kilobytes. */
    rssKb: number;
    /** The time since the start, as `ps` shows it ([[dd-]hh:]mm:ss). */
    elapsed: string;
    /** The command line. */
    command: string;
}

/** A TCP port that a process listens on. */
export interface ListeningPort {
    port: number;
    /** The address, for example "127.0.0.1", "::1" or "*". */
    address: string;
}

/** A process that is shown in the Processes panel. */
export interface ProcessInfo {
    pid: number;
    ppid: number;
    /** The short name of the program, for example "node". */
    name: string;
    command: string;
    cpu: number;
    rssKb: number;
    elapsed: string;
    ports: ListeningPort[];
}

/** A process and all its child processes. Stop stops all of them. */
export interface ProcessTree {
    root: ProcessInfo;
    /** The child processes, the children of the children, and so on. */
    descendants: ProcessInfo[];
    /** The ports of the root and of all descendants. */
    ports: ListeningPort[];
}

/** The processes of one terminal tab: the processes that its shell started. */
export interface TerminalProcesses {
    sessionId?: string;
    title: string;
    isAgent: boolean;
    shellPid: number;
    jobs: ProcessTree[];
}

export interface WorktreeProcesses {
    worktreePath: string;
    terminals: TerminalProcesses[];
    /** Processes that a ShipWarden terminal did not start, but that run in the worktree folder. */
    others: ProcessTree[];
}

/** A terminal session as the scan needs it. */
export interface ScanSession {
    id: string;
    title: string;
    isAgent: boolean;
    worktreePath?: string;
    pid?: number;
    exited: boolean;
}

/** The input of `groupProcesses`: the output of the system commands, parsed. */
export interface ScanInput {
    rows: ProcessRow[];
    /** The listening ports of each process. */
    ports: Map<number, ListeningPort[]>;
    /** The working folder of each process. */
    cwds: Map<number, string>;
    sessions: ScanSession[];
    /** The PIDs of the PTY hosts. Their child processes are the terminal shells. */
    hostPids?: number[];
    /** Processes that are never shown or stopped, with their descendants: ShipWarden itself. */
    excludedPids: number[];
    worktreePaths: string[];
}

/** Programs that are interactive shells or terminal tools. A process of the worktree folder with this name is the user's own terminal, so the scan does not show it. */
const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'tmux', 'screen', 'login']);

/** The `ps -o` fields that `parsePs` reads. */
export const PS_FIELDS = 'pid=,ppid=,pgid=,tpgid=,%cpu=,rss=,etime=,command=';

/** Parses the output of `ps -axww -o <PS_FIELDS>`. */
export function parsePs(text: string): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const line of text.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!match) continue;
        rows.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            tpgid: Number(match[4]),
            cpu: Number(match[5].replace(',', '.')) || 0,
            rssKb: Number(match[6]),
            elapsed: match[7],
            command: match[8].trim()
        });
    }
    return rows;
}

/**
 * Parses the field output of `lsof -F pn`. Each "p" line starts a process, and each "n" line is a name of the
 * process (an address or a path). Returns the names of each process.
 */
export function parseLsofNames(text: string): Map<number, string[]> {
    const names = new Map<number, string[]>();
    let pid: number | undefined;
    for (const line of text.split('\n')) {
        if (line.startsWith('p')) {
            pid = Number(line.slice(1));
            if (!names.has(pid)) names.set(pid, []);
        } else if (line.startsWith('n') && pid !== undefined) {
            names.get(pid)!.push(line.slice(1));
        }
    }
    return names;
}

/** Converts an lsof name such as "*:5173", "127.0.0.1:3000" or "[::1]:8080" to a port. */
export function parsePortName(name: string): ListeningPort | undefined {
    const match = /^(.*):(\d+)$/.exec(name.trim());
    if (!match) return undefined;
    return { address: match[1].replace(/^\[(.*)\]$/, '$1'), port: Number(match[2]) };
}

/** The listening ports of each process, from `lsof -nP -iTCP -sTCP:LISTEN -F pn`. The same port on IPv4 and IPv6 is one port. */
export function parseListeningPorts(text: string): Map<number, ListeningPort[]> {
    const result = new Map<number, ListeningPort[]>();
    for (const [pid, names] of parseLsofNames(text)) {
        const ports: ListeningPort[] = [];
        for (const name of names) {
            const port = parsePortName(name);
            if (port && !ports.some(item => item.port === port.port)) ports.push(port);
        }
        if (ports.length)
            result.set(
                pid,
                ports.sort((a, b) => a.port - b.port)
            );
    }
    return result;
}

/** The working folder of each process, from `lsof -a -d cwd -F pn`. */
export function parseCwds(text: string): Map<number, string> {
    const result = new Map<number, string>();
    for (const [pid, names] of parseLsofNames(text)) {
        if (names[0]) result.set(pid, names[0]);
    }
    return result;
}

/** Returns the short program name of a command line: the file name of the first word. */
export function programName(command: string): string {
    const first = command.split(/\s+/)[0] ?? command;
    const name = first.slice(first.lastIndexOf('/') + 1);
    // A login shell has "-" in front of its name.
    return name.replace(/^-/, '') || command;
}

/** Returns the child PIDs of each PID. */
export function childMap(rows: ProcessRow[]): Map<number, number[]> {
    const children = new Map<number, number[]>();
    for (const row of rows) {
        if (row.pid === row.ppid) continue;
        const list = children.get(row.ppid);
        if (list) list.push(row.pid);
        else children.set(row.ppid, [row.pid]);
    }
    return children;
}

/** Returns all descendants of a PID (not the PID itself), parents before children. */
export function descendantPids(children: Map<number, number[]>, pid: number): number[] {
    const result: number[] = [];
    const queue = [...(children.get(pid) ?? [])];
    const seen = new Set<number>([pid]);
    while (queue.length) {
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        result.push(next);
        queue.push(...(children.get(next) ?? []));
    }
    return result;
}

/** True when `path` is the folder `folder` or is in it. */
export function isInFolder(path: string, folder: string): boolean {
    const base = folder.replace(/\/+$/, '');
    return path === base || path.startsWith(`${base}/`);
}

/** Returns the worktree of a path: the longest worktree path that contains it. A linked worktree can be in the main worktree. */
export function worktreeOf(path: string, worktreePaths: string[]): string | undefined {
    let best: string | undefined;
    for (const worktree of worktreePaths) {
        if (isInFolder(path, worktree) && (!best || worktree.length > best.length)) best = worktree;
    }
    return best;
}

function info(row: ProcessRow, ports: Map<number, ListeningPort[]>): ProcessInfo {
    return {
        pid: row.pid,
        ppid: row.ppid,
        name: programName(row.command),
        command: row.command,
        cpu: row.cpu,
        rssKb: row.rssKb,
        elapsed: row.elapsed,
        ports: ports.get(row.pid) ?? []
    };
}

function tree(pid: number, byPid: Map<number, ProcessRow>, children: Map<number, number[]>, ports: Map<number, ListeningPort[]>): ProcessTree | undefined {
    const row = byPid.get(pid);
    if (!row) return undefined;
    const root = info(row, ports);
    const descendants = descendantPids(children, pid)
        .map(id => byPid.get(id))
        .filter((item): item is ProcessRow => !!item)
        .map(item => info(item, ports));
    const all = [...root.ports, ...descendants.flatMap(item => item.ports)];
    const unique = all.filter((port, index) => all.findIndex(item => item.port === port.port) === index).sort((a, b) => a.port - b.port);
    return { root, descendants, ports: unique };
}

/**
 * Groups the processes by worktree.
 * - Terminal processes: the child processes of each terminal shell (a child of the PTY host). The session of a shell
 *   gives its worktree. A shell without a known session (from an older PTY host) uses its working folder.
 * - Other processes: processes outside the terminals with a working folder in the worktree. The scan shows only the
 *   top process of each group, and leaves out shells, so the user's own terminal windows do not show.
 */
export function groupProcesses(input: ScanInput): WorktreeProcesses[] {
    const byPid = new Map(input.rows.map(row => [row.pid, row]));
    const children = childMap(input.rows);
    const result = new Map<string, WorktreeProcesses>(input.worktreePaths.map(path => [path, { worktreePath: path, terminals: [], others: [] }]));

    const excluded = new Set<number>();
    for (const pid of input.excludedPids) {
        excluded.add(pid);
        descendantPids(children, pid).forEach(id => excluded.add(id));
    }

    // The terminal shells and everything below them.
    const owned = new Set<number>();
    const sessionByPid = new Map(input.sessions.filter(session => session.pid && !session.exited).map(session => [session.pid!, session]));
    const shellPids = new Set<number>(sessionByPid.keys());
    for (const hostPid of input.hostPids ?? []) {
        excluded.add(hostPid);
        (children.get(hostPid) ?? []).forEach(pid => shellPids.add(pid));
    }
    for (const shellPid of shellPids) {
        const shell = byPid.get(shellPid);
        if (!shell) continue;
        owned.add(shellPid);
        descendantPids(children, shellPid).forEach(pid => owned.add(pid));
        const session = sessionByPid.get(shellPid);
        const path = session?.worktreePath ?? worktreeOf(input.cwds.get(shellPid) ?? '', input.worktreePaths);
        const group = path ? result.get(path) : undefined;
        if (!group) continue;
        const jobs = (children.get(shellPid) ?? [])
            .filter(pid => !excluded.has(pid))
            .map(pid => tree(pid, byPid, children, input.ports))
            .filter((item): item is ProcessTree => !!item);
        group.terminals.push({
            sessionId: session?.id,
            title: session?.title ?? 'Terminal',
            isAgent: session?.isAgent ?? false,
            shellPid,
            jobs
        });
    }

    // Other processes with a working folder in a worktree. Only the top process of each group shows.
    const matched = new Map<number, string>();
    for (const [pid, cwd] of input.cwds) {
        if (owned.has(pid) || excluded.has(pid) || pid === 1) continue;
        const row = byPid.get(pid);
        if (!row || SHELLS.has(programName(row.command))) continue;
        const path = worktreeOf(cwd, input.worktreePaths);
        if (path) matched.set(pid, path);
    }
    for (const [pid, path] of matched) {
        const row = byPid.get(pid)!;
        // A child of another matched process of the same worktree is in the tree of that process.
        let parent = row.ppid;
        let nested = false;
        for (let depth = 0; parent > 1 && depth < 64; depth += 1) {
            if (matched.get(parent) === path) {
                nested = true;
                break;
            }
            parent = byPid.get(parent)?.ppid ?? 0;
        }
        if (nested) continue;
        const item = tree(pid, byPid, children, input.ports);
        if (item) result.get(path)!.others.push(item);
    }

    for (const group of result.values()) {
        group.terminals.sort((a, b) => a.shellPid - b.shellPid);
        group.others.sort((a, b) => a.root.pid - b.root.pid);
    }
    return [...result.values()];
}

/** All PIDs of a worktree: the jobs of its terminals and the other processes, with their descendants. */
export function worktreePids(group: WorktreeProcesses, options: { includeOthers: boolean }): number[] {
    const trees = [...group.terminals.flatMap(terminal => terminal.jobs), ...(options.includeOthers ? group.others : [])];
    return trees.flatMap(item => [item.root.pid, ...item.descendants.map(child => child.pid)]);
}

/** A listening port of a worktree, with the process to stop for it. */
export interface PortOwner extends ListeningPort {
    /** The top process of the tree that has the port. A stop stops this process and its child processes. */
    pid: number;
    /** The short program name of the top process. */
    name: string;
}

/** The listening ports of a worktree, in port order. Each port has the top process of its tree. */
export function worktreePortOwners(group: WorktreeProcesses): PortOwner[] {
    const trees = [...group.terminals.flatMap(terminal => terminal.jobs), ...group.others];
    const owners: PortOwner[] = [];
    for (const item of trees) {
        for (const port of item.ports) {
            if (!owners.some(owner => owner.port === port.port)) owners.push({ ...port, pid: item.root.pid, name: item.root.name });
        }
    }
    return owners.sort((a, b) => a.port - b.port);
}

/** The address of a port for a browser. A port on all addresses or on the loopback address opens as localhost. */
export function portUrl(port: ListeningPort): string {
    const local = ['*', '0.0.0.0', '::', '127.0.0.1', '::1', 'localhost'].includes(port.address);
    const host = local ? 'localhost' : port.address.includes(':') ? `[${port.address}]` : port.address;
    return `http://${host}:${port.port}`;
}

/** The number of processes and the ports of a worktree, for a badge. */
export function worktreeSummary(group: WorktreeProcesses): { processes: number; ports: number[] } {
    const trees = [...group.terminals.flatMap(terminal => terminal.jobs), ...group.others];
    const ports = [...new Set(trees.flatMap(item => item.ports.map(port => port.port)))].sort((a, b) => a - b);
    return { processes: trees.length, ports };
}
