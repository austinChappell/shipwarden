import type { AgentUpdate } from '@shared/agents';
import { agentProcessesBelow, inForeground, type AgentProgram } from '@shared/agent-programs';
import type { ProcessRow } from '@shared/processes';
import type { TerminalSession } from '@shared/terminal';

const POLL_MS = 2000;

export interface ShellAgentsDeps {
    /** The terminal sessions of the PTY hosts. */
    sessions(): Promise<TerminalSession[]>;
    /** The PIDs of the PTY hosts. */
    hostPids(): Promise<number[]>;
    /** The process table. */
    processTable(): Promise<ProcessRow[]>;
    /** Receives a new agent state of a session. */
    onState(id: string, update: AgentUpdate): void;
    /** Receives the agent program of a session, or undefined when the agent stopped. */
    onProgram(id: string, program: AgentProgram | undefined): void;
}

/**
 * Finds the agents that the user starts in a shell tab, for example with `claude` or `codex`.
 * Each 2 seconds, it reads the process table and finds the agent processes below the shell of each tab.
 * Only an agent in the foreground of the tab's terminal counts.
 * Codex has no hooks, so this is the only way to find it. A Claude Code agent also reports its state through the hooks.
 * A session of a host without the shell PID (a Yardmaster host) gets no agent program.
 */
export class ShellAgents {
    /** The agent program in each shell tab, by session ID. */
    private readonly programs = new Map<string, AgentProgram>();
    /** The "exited" states that the app sent itself, by session ID. They replace the last state of the hooks. */
    private readonly exits = new Map<string, AgentUpdate>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private polling = false;

    constructor(private readonly deps: ShellAgentsDeps) {}

    /** Starts the process scan. */
    start(): void {
        this.timer ??= setInterval(() => void this.poll(), POLL_MS);
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Forgets a session that exited or closed. The exit of the session tells the views that its agent stopped. */
    forget(id: string): void {
        this.programs.delete(id);
        this.exits.delete(id);
    }

    /** Adds the agent program and the "exited" state that the app found to the sessions of the hosts. */
    annotate(sessions: TerminalSession[]): TerminalSession[] {
        return sessions.map(session => {
            const program = this.programs.get(session.id);
            const exit = this.exits.get(session.id);
            if (!program && !exit) {
                return session;
            }
            return {
                ...session,
                ...(program ? { agentProgram: program } : {}),
                ...(exit ? { agentState: exit.state, agentMessage: undefined, agentPrompt: exit.prompt, agentStateAt: exit.at } : {})
            };
        });
    }

    /** Reads the process table one time and reports each change of the agent programs. */
    async poll(): Promise<void> {
        if (this.polling) {
            return;
        }
        this.polling = true;
        try {
            await this.scan();
        } catch (error) {
            console.warn(`[agents] The scan for agents in shell tabs failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.polling = false;
        }
    }

    private async scan(): Promise<void> {
        const shells = (await this.deps.sessions()).filter(session => !session.isAgent && !session.exited && session.pid);
        const found = new Map<string, AgentProgram>();
        if (shells.length > 0) {
            const [hostPids, rows] = await Promise.all([this.deps.hostPids(), this.deps.processTable()]);
            const byShellPid = new Map(shells.map(session => [session.pid!, session.id]));
            const byPid = new Map(rows.map(row => [row.pid, row]));
            for (const hostPid of hostPids) {
                for (const agent of agentProcessesBelow(rows, hostPid)) {
                    // A stopped or background agent does not run in the tab. The tab is a shell again.
                    const row = byPid.get(agent.pid);
                    if (!row || !inForeground(row)) {
                        continue;
                    }
                    const id = agent.ancestors.map(pid => byShellPid.get(pid)).find(Boolean);
                    if (id) {
                        found.set(id, agent.program);
                    }
                }
            }
        }
        for (const [id, program] of found) {
            if (this.programs.get(id) !== program) {
                this.programs.set(id, program);
                // A new agent started. The "exited" of the last agent must not hide the state of the new agent.
                this.exits.delete(id);
                this.deps.onProgram(id, program);
            }
        }
        for (const id of [...this.programs.keys()]) {
            if (found.has(id)) {
                continue;
            }
            this.programs.delete(id);
            this.deps.onProgram(id, undefined);
            // The agent stopped. A state from its hooks must not stay, for example when the agent stopped without SessionEnd.
            const session = shells.find(item => item.id === id);
            if (session?.agentState && session.agentState !== 'exited') {
                const exit: AgentUpdate = { state: 'exited', prompt: session.agentPrompt, at: Date.now() };
                this.exits.set(id, exit);
                this.deps.onState(id, exit);
            }
        }
    }
}
