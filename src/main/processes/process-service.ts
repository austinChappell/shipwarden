import { execFile } from 'child_process';
import { userInfo } from 'os';
import {
    childMap,
    descendantPids,
    groupProcesses,
    parseCwds,
    parseListeningPorts,
    parsePs,
    worktreePids,
    type ProcessRow,
    type ScanSession,
    type WorktreeProcesses
} from '@shared/processes';

/** The time that a process gets to stop after SIGTERM. After it, the process gets SIGKILL. */
const STOP_GRACE_MS = 3000;
const POLL_MS = 150;

export interface ProcessServiceDeps {
    /** The terminal sessions of the PTY host. */
    sessions(): Promise<ScanSession[]>;
    /** The PIDs of the PTY hosts that run. */
    hostPids(): Promise<number[]>;
}

/** Runs a command and returns its output. lsof gives exit code 1 when it finds nothing. That is not an error. */
function run(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 10000 }, (error, stdout) => {
            if (error && !stdout && (error as { code?: unknown }).code !== 1) {
                reject(error);
                return;
            }
            resolve(stdout ?? '');
        });
    });
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Sends a signal. Returns false when the process does not exist or does not belong to the user. */
function signal(pid: number, name: NodeJS.Signals | 0): boolean {
    try {
        process.kill(pid, name);
        return true;
    } catch {
        return false;
    }
}

/**
 * Finds the processes and the listening ports of the worktrees, and stops them.
 * It reads only the process table, the listening sockets and the working folders. It does not read environments.
 */
export class ProcessService {
    constructor(private readonly deps: ProcessServiceDeps) {}

    async table(): Promise<ProcessRow[]> {
        return parsePs(await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,%cpu=,rss=,etime=,command=']));
    }

    /** Returns the processes of each worktree. */
    async scan(worktreePaths: string[]): Promise<WorktreeProcesses[]> {
        const paths = [...new Set(worktreePaths.filter(path => typeof path === 'string' && path.startsWith('/')))];
        if (!paths.length) return [];
        const [rows, listen, cwd, sessions, hostPids] = await Promise.all([
            this.table(),
            run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']),
            run('/usr/sbin/lsof', ['-nP', '-a', '-u', userInfo().username, '-d', 'cwd', '-F', 'pn']),
            this.deps.sessions().catch(() => []),
            this.deps.hostPids().catch(() => [])
        ]);
        return groupProcesses({
            rows,
            ports: parseListeningPorts(listen),
            cwds: parseCwds(cwd),
            sessions,
            hostPids,
            excludedPids: [process.pid],
            worktreePaths: paths
        });
    }

    /**
     * Stops a process of a worktree and all its child processes. The PID must be a process that the scan shows for
     * the worktree, so the renderer cannot stop other processes.
     */
    async stop(worktreePath: string, pid: number): Promise<void> {
        const [group] = await this.scan([worktreePath]);
        const known = group ? worktreePids(group, { includeOthers: true }) : [];
        if (!known.includes(pid)) {
            throw new Error(`Process ${pid} is not a process of this worktree. Refresh the list.`);
        }
        const rows = await this.table();
        await this.terminate([pid, ...descendantPids(childMap(rows), pid)], rows);
    }

    /** Returns the PIDs below a process (not the process itself). */
    async descendantsOf(pid: number): Promise<number[]> {
        return descendantPids(childMap(await this.table()), pid);
    }

    /**
     * Returns all processes of a worktree: the processes of its terminals and the other processes in its folder.
     * The worktree removal stops them.
     */
    async worktreePids(worktreePath: string): Promise<number[]> {
        const [group] = await this.scan([worktreePath]);
        return group ? worktreePids(group, { includeOthers: true }) : [];
    }

    /**
     * Sends SIGTERM to the processes, and SIGKILL to each process that still runs after the grace time.
     * A process gets SIGKILL only when it has the same command as before, so a new process with a reused PID is safe.
     */
    async terminate(pids: number[], rows?: ProcessRow[]): Promise<void> {
        const unique = [...new Set(pids)].filter(pid => pid > 1 && pid !== process.pid);
        if (!unique.length) return;
        const before = new Map((rows ?? await this.table()).map(row => [row.pid, row.command]));
        const targets = unique.filter(pid => before.has(pid));
        targets.forEach(pid => signal(pid, 'SIGTERM'));
        const deadline = Date.now() + STOP_GRACE_MS;
        let alive = targets;
        while (alive.length && Date.now() < deadline) {
            await delay(POLL_MS);
            alive = alive.filter(pid => signal(pid, 0));
        }
        if (!alive.length) return;
        const now = new Map((await this.table()).map(row => [row.pid, row.command]));
        for (const pid of alive) {
            if (now.get(pid) === before.get(pid)) signal(pid, 'SIGKILL');
        }
    }
}
