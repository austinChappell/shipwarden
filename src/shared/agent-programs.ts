import type { ProcessRow } from './processes';

/** The agent programs that ShipWarden finds in a shell tab. */
export type AgentProgram = 'claude' | 'codex' | 'gemini';

const PROGRAMS: readonly AgentProgram[] = ['claude', 'codex', 'gemini'];

const RUNTIMES = new Set(['node', 'bun', 'deno']);

function base(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Returns the agent program of a command line, or undefined for another program.
 * It knows these forms:
 * - The program name: `claude`, `codex`, `gemini`, or a path that ends with it.
 * - The native Claude Code binary: `…/claude/versions/2.1.0`.
 * - A script in a runtime: `node …/@anthropic-ai/claude-code/cli.js`, `node …/@openai/codex/bin/codex.js`,
 *   `node --max-old-space-size=8192 …/@google/gemini-cli/dist/index.js`. The options of the runtime are not the script.
 */
export function agentProgramOf(command: string): AgentProgram | undefined {
    const [program = '', ...args] = command.trim().split(/\s+/);
    const script = args.find(arg => !arg.startsWith('-')) ?? '';
    const name = base(program);
    if ((PROGRAMS as readonly string[]).includes(name)) {
        return name as AgentProgram;
    }
    if (/\/claude\/versions\/[^/]+$/.test(program)) {
        return 'claude';
    }
    if (RUNTIMES.has(name)) {
        if (script.includes('/@anthropic-ai/claude-code/') || base(script) === 'claude') {
            return 'claude';
        }
        if (script.includes('/@openai/codex/') || base(script) === 'codex' || base(script) === 'codex.js') {
            return 'codex';
        }
        if (script.includes('/@google/gemini-cli/') || base(script) === 'gemini') {
            return 'gemini';
        }
    }
    return undefined;
}

export interface AgentProcess {
    pid: number;
    program: AgentProgram;
    /** The PIDs from the process up to the root, without the root. The process is first. */
    ancestors: number[];
}

/**
 * Returns the agent processes below a root process (for example the PTY host).
 * An agent below another agent (for example a subagent) is not in the result. Only the top agent counts.
 */
export function agentProcessesBelow(rows: readonly ProcessRow[], rootPid: number): AgentProcess[] {
    const byPid = new Map(rows.map(row => [row.pid, row]));
    const result: AgentProcess[] = [];
    for (const row of rows) {
        const program = agentProgramOf(row.command);
        if (!program) {
            continue;
        }
        const chain = [row.pid];
        let parent = row.ppid;
        let nested = false;
        // The limit stops a loop in a broken process table.
        while (parent && parent !== rootPid && chain.length < 64) {
            const parentRow = byPid.get(parent);
            if (parentRow && agentProgramOf(parentRow.command)) {
                nested = true;
                break;
            }
            chain.push(parent);
            parent = parentRow?.ppid ?? 0;
        }
        if (!nested && parent === rootPid) {
            result.push({ pid: row.pid, program, ancestors: chain });
        }
    }
    return result;
}

