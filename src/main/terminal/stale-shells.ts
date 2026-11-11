import type { ProcessRow } from '@shared/processes';
import { isStaleShell, type TerminalSession } from '@shared/terminal';

/** The time between two checks for stale shells. */
const CHECK_MS = 60 * 60 * 1000;
/** The time from the start to the first check. The app has a few seconds to connect to the PTY host. */
const FIRST_CHECK_MS = 60 * 1000;

/**
 * Returns true when the shell waits at its prompt. Then the foreground process group of its terminal is the group of the shell.
 * When a command runs in the foreground, for example a dev server, the group is the group of the command.
 */
export function shellAtPrompt(rows: readonly ProcessRow[], pid: number): boolean {
    const row = rows.find(item => item.pid === pid);
    return !!row && row.tpgid > 0 && row.tpgid === row.pgid;
}

/** Returns the IDs of the stale shells that wait at their prompt. A shell without a PID or without a process row stays open. */
export function staleShellIds(sessions: readonly TerminalSession[], rows: readonly ProcessRow[], now: number): string[] {
    return sessions.filter(session => isStaleShell(session, now) && !!session.pid && shellAtPrompt(rows, session.pid)).map(session => session.id);
}

export interface StaleShellCloserDeps {
    /** True when Settings › Worktrees has "Close stale shells" on. */
    enabled(): Promise<boolean>;
    /** The sessions of the PTY hosts, with the agents that the app found in shell tabs. */
    sessions(): Promise<TerminalSession[]>;
    processTable(): Promise<ProcessRow[]>;
    /** Stops a session. Its tab closes when the exit event gets to the page. */
    close(id: string): Promise<void>;
}

/** Closes the shell tabs with no input and no output for 7 days, while the app runs. */
export class StaleShellCloser {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private checking = false;

    constructor(private readonly deps: StaleShellCloserDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => this.tick(), FIRST_CHECK_MS);
    }

    stop(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    /** Closes the stale shells now. Returns the IDs of the closed sessions. */
    async check(now = Date.now()): Promise<string[]> {
        if (this.checking || !(await this.deps.enabled())) return [];
        this.checking = true;
        try {
            const sessions = await this.deps.sessions();
            if (!sessions.some(session => isStaleShell(session, now))) return [];
            const ids = staleShellIds(sessions, await this.deps.processTable(), now);
            for (const id of ids) {
                await this.deps.close(id);
            }
            if (ids.length) console.log(`[terminals] Closed ${ids.length} stale shells.`);
            return ids;
        } finally {
            this.checking = false;
        }
    }

    private tick(): void {
        this.check()
            .catch(error => console.warn('[terminals] The check for stale shells failed:', error))
            .finally(() => {
                if (this.timer) this.timer = setTimeout(() => this.tick(), CHECK_MS);
            });
    }
}
