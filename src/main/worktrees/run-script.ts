import { spawn } from 'child_process';

/** The output that the result keeps: the last part, because the end of the output has the error. */
const MAX_OUTPUT = 16 * 1024;

export interface ScriptResult {
    /** The exit code. Null when the script did not finish in time, or a signal stopped it. */
    code: number | null;
    timedOut: boolean;
    /** The last part of the output and the errors, together. */
    output: string;
}

/**
 * Runs a shell script in the user's login shell, so the script finds the same commands as a terminal.
 * The script gets the environment of this process and `env`.
 */
export function runScript(script: string, cwd: string, env: Record<string, string>, timeoutMs = 5 * 60_000, shell = process.env.SHELL || '/bin/zsh'): Promise<ScriptResult> {
    return new Promise(resolve => {
        let output = '';
        let timedOut = false;
        const keep = (data: Buffer) => {
            output = (output + data.toString()).slice(-MAX_OUTPUT);
        };
        const child = spawn(shell, ['-l', '-c', script], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, timeoutMs);
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        child.on('error', error => {
            clearTimeout(timer);
            resolve({ code: null, timedOut: false, output: `${output}${error.message}` });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code: timedOut ? null : code, timedOut, output: output.trimEnd() });
        });
    });
}
