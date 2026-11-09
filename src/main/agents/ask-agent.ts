import { spawn } from 'child_process';
import { afterMarker, stripTerminalCodes } from '@shared/ask-agent';

/** The marker before the agent output. The startup files of an interactive shell can write text before it. */
const MARKER = '__SHIPWARDEN_ANSWER__';
/** The most output that the runner keeps. */
const MAX_OUTPUT = 2 * 1024 * 1024;
/** The end of the errors that a failure message shows. */
const MAX_ERROR = 2000;
const DEFAULT_TIMEOUT = 10 * 60_000;

export interface AskRun {
    /** The print-mode command, from `printCommand`. */
    command: string;
    prompt: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number;
    shell?: string;
}

/**
 * Runs agents in print mode for the "Ask agent" box. Each run has an ID, so the user can cancel it.
 * The command runs in an interactive login shell, the same as an agent terminal, so the PATH, the aliases and
 * NODE_EXTRA_CA_CERTS of the user's shell apply.
 */
export class AskAgentRunner {
    private readonly running = new Map<string, () => void>();

    /** Runs the command and returns its output. Rejects when the command fails, times out or is cancelled. */
    run(id: string, options: AskRun): Promise<string> {
        this.cancel(id);
        const shell = options.shell ?? (process.env.SHELL || '/bin/zsh');
        const script = `printf '%s' '${MARKER}'; exec ${options.command}`;
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let stopped: 'timeout' | 'cancel' | undefined;
            const child = spawn(shell, ['-l', '-i', '-c', script], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
            const stop = (reason: 'timeout' | 'cancel') => {
                stopped = reason;
                child.kill('SIGTERM');
            };
            const cancel = () => stop('cancel');
            this.running.set(id, cancel);
            const timer = setTimeout(() => stop('timeout'), timeoutMs);
            child.stdout.on('data', (data: Buffer) => {
                stdout = (stdout + data.toString()).slice(0, MAX_OUTPUT);
            });
            child.stderr.on('data', (data: Buffer) => {
                stderr = (stderr + data.toString()).slice(-MAX_ERROR);
            });
            // The agent can exit before it reads all of the prompt. The close event then reports the failure.
            child.stdin.on('error', () => undefined);
            child.stdin.end(options.prompt);
            const finish = () => {
                clearTimeout(timer);
                if (this.running.get(id) === cancel) this.running.delete(id);
            };
            child.on('error', error => {
                finish();
                reject(error);
            });
            child.on('close', code => {
                finish();
                if (stopped === 'cancel') return reject(new Error('The question was cancelled.'));
                if (stopped === 'timeout') return reject(new Error(`The agent did not answer in ${Math.round(timeoutMs / 60_000)} minutes.`));
                const answer = stripTerminalCodes(afterMarker(stdout, MARKER)).trim();
                const errors = stripTerminalCodes(stderr).trim();
                if (code !== 0) {
                    const detail = errors || answer;
                    return reject(new Error(`The agent stopped with exit code ${code}.${detail ? `\n${detail.slice(-MAX_ERROR)}` : ''}`));
                }
                if (!answer) return reject(new Error(`The agent gave no answer.${errors ? `\n${errors}` : ''}`));
                resolve(answer);
            });
        });
    }

    /** Stops a run. Does nothing when the run is not active. */
    cancel(id: string): void {
        this.running.get(id)?.();
    }

    /** Stops all runs, for example when the app quits. */
    cancelAll(): void {
        [...this.running.values()].forEach(cancel => cancel());
    }
}
