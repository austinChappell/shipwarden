import { randomUUID } from 'crypto';
import * as pty from 'node-pty';
import type { AgentState, AgentStateChange, AgentUpdate } from '@shared/agents';
import type { CreateTerminalOptions, TerminalReplay, TerminalSession } from '@shared/terminal';
import { OutputBuffer } from './output-buffer';

export interface TerminalEvents {
    data(id: string, data: string, seq: number): void;
    exit(id: string, exitCode: number): void;
    agentState(id: string, update: AgentUpdate): void;
}

/** Environment variables that the agent hooks need to reach ShipWarden. */
export interface HookEnvironment {
    url: string;
    token: string;
}

interface Entry {
    session: TerminalSession;
    process: pty.IPty;
    output: OutputBuffer;
}

/**
 * Runs the terminal processes. The PTY host process uses it, so the processes
 * continue to run when the window reloads or the app quits.
 */
export class TerminalManager {
    private readonly entries = new Map<string, Entry>();

    private hookEnvironment: HookEnvironment | undefined;

    constructor(private readonly events: TerminalEvents) {}

    /** Sets the address of the hook server. New agent sessions get it in their environment. */
    setHookEnvironment(environment: HookEnvironment): void {
        this.hookEnvironment = environment;
    }

    agentState(id: string): AgentState | undefined {
        return this.entries.get(id)?.session.agentState;
    }

    /** Sets the agent state of a session, for example from a hook event. A change without a prompt keeps the last prompt. */
    setAgentState(id: string, change: AgentStateChange): void {
        const entry = this.entries.get(id);
        if (!entry || !entry.session.isAgent) {
            return;
        }
        const { session } = entry;
        // Each tool call reports "working". The time counts from the start of the state, not from the last tool call.
        if (session.agentState !== change.state || !session.agentStateAt) {
            session.agentStateAt = Date.now();
        }
        session.agentState = change.state;
        session.agentMessage = change.message;
        if (change.prompt) {
            session.agentPrompt = change.prompt;
        }
        this.events.agentState(id, { state: change.state, message: change.message, prompt: session.agentPrompt, at: session.agentStateAt });
    }

    /** The number of sessions with a running process. */
    liveCount(): number {
        return [...this.entries.values()].filter(entry => !entry.session.exited).length;
    }

    /** Starts a process. `env` is the environment of the process. */
    create(options: CreateTerminalOptions, env: NodeJS.ProcessEnv = process.env): TerminalSession {
        const id = randomUUID();
        const shell = env.SHELL || '/bin/zsh';
        // A command runs as the shell command, so the shell does not echo it. When the command exits, a normal shell starts.
        const args = options.command ? ['-l', '-i', '-c', `${options.command}; exec ${shell} -l`] : ['-l'];
        const child = pty.spawn(shell, args, {
            name: 'xterm-256color',
            cols: Math.max(options.cols, 2),
            rows: Math.max(options.rows, 1),
            cwd: options.cwd,
            env: {
                ...env,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
                TERM_PROGRAM: 'ShipWarden',
                ...(options.isAgent && this.hookEnvironment ? {
                    SHIPWARDEN_SESSION_ID: id,
                    SHIPWARDEN_HOOK_URL: this.hookEnvironment.url,
                    SHIPWARDEN_HOOK_TOKEN: this.hookEnvironment.token
                } : {})
            }
        });
        const session: TerminalSession = {
            id,
            title: options.title,
            cwd: options.cwd,
            worktreePath: options.worktreePath,
            isAgent: options.isAgent ?? false,
            pid: child.pid,
            exited: false,
            agentState: options.isAgent && options.reportsAgentState && this.hookEnvironment ? 'starting' : undefined,
            agentStateAt: options.isAgent ? Date.now() : undefined
        };
        const entry: Entry = { session, process: child, output: new OutputBuffer() };
        this.entries.set(session.id, entry);

        child.onData(data => {
            const seq = entry.output.append(data);
            this.events.data(session.id, data, seq);
        });
        child.onExit(({ exitCode }) => {
            session.exited = true;
            session.exitCode = exitCode;
            if (session.agentState && session.agentState !== 'exited') {
                session.agentState = 'exited';
                session.agentStateAt = Date.now();
                this.events.agentState(session.id, { state: 'exited', prompt: session.agentPrompt, at: session.agentStateAt });
            }
            this.events.exit(session.id, exitCode);
        });

        return { ...session };
    }

    list(): TerminalSession[] {
        return [...this.entries.values()].map(entry => ({ ...entry.session }));
    }

    replay(id: string): TerminalReplay {
        return this.get(id).output.replay();
    }

    write(id: string, data: string): void {
        const entry = this.entries.get(id);
        if (entry && !entry.session.exited) {
            entry.process.write(data);
        }
    }

    resize(id: string, cols: number, rows: number): void {
        const entry = this.entries.get(id);
        if (entry && !entry.session.exited && cols > 0 && rows > 0) {
            entry.process.resize(cols, rows);
        }
    }

    /** Stops the process and forgets the session. */
    kill(id: string): void {
        const entry = this.entries.get(id);
        if (!entry) {
            return;
        }
        if (!entry.session.exited) {
            entry.process.kill();
        }
        this.entries.delete(id);
    }

    /** Stops all sessions that run in the worktree. */
    killWorktree(worktreePath: string): void {
        for (const entry of [...this.entries.values()]) {
            if (entry.session.worktreePath === worktreePath) {
                this.kill(entry.session.id);
            }
        }
    }

    killAll(): void {
        for (const id of [...this.entries.keys()]) {
            this.kill(id);
        }
    }

    private get(id: string): Entry {
        const entry = this.entries.get(id);
        if (!entry) {
            throw new Error(`The terminal session "${id}" does not exist.`);
        }
        return entry;
    }
}
