import { describe, expect, it } from 'vitest';
import type { AgentUpdate } from '@shared/agents';
import type { ProcessRow } from '@shared/processes';
import type { TerminalSession } from '@shared/terminal';
import { ShellAgents } from './shell-agents';

const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, cpu: 0, rssKb: 0, elapsed: '00:01', command });
const shell = (id: string, pid?: number): TerminalSession => ({ id, title: id, cwd: '/w', isAgent: false, exited: false, pid });

function setup(sessions: TerminalSession[], rows: ProcessRow[], hostPids = [10]) {
    const states: [string, AgentUpdate][] = [];
    const programs: [string, string | undefined][] = [];
    const tracker = new ShellAgents({
        sessions: async () => sessions,
        hostPids: async () => hostPids,
        processTable: async () => rows,
        onState: (id, update) => states.push([id, update]),
        onProgram: (id, program) => programs.push([id, program])
    });
    return { tracker, states, programs, rows };
}

describe('ShellAgents', () => {
    it('finds an agent below the shell of a tab, in each host', async () => {
        const test = setup([shell('a', 20), shell('b', 50)], [
            row(20, 10, '/bin/zsh -l'),
            row(21, 20, 'codex'),
            // The shell of tab "b" runs in a second host.
            row(50, 40, '/bin/zsh -l'),
            row(51, 50, '/Users/me/.local/share/claude/versions/2.1.319')
        ], [10, 40]);
        await test.tracker.poll();
        expect(test.programs).toEqual([['a', 'codex'], ['b', 'claude']]);
        expect(test.tracker.annotate([shell('a', 20)])[0].agentProgram).toBe('codex');
    });

    it('ignores a session without a shell PID', async () => {
        const test = setup([shell('a')], [row(20, 10, '/bin/zsh -l'), row(21, 20, 'claude')]);
        await test.tracker.poll();
        expect(test.programs).toEqual([]);
    });

    it('reports "exited" when the agent process stops while the hooks still show a live state', async () => {
        const test = setup([{ ...shell('a', 20), agentState: 'done', agentPrompt: 'Fix it' }], [row(20, 10, '/bin/zsh -l'), row(21, 20, 'claude')]);
        await test.tracker.poll();
        test.rows.pop();
        await test.tracker.poll();
        expect(test.programs).toEqual([['a', 'claude'], ['a', undefined]]);
        expect(test.states.map(([id, update]) => [id, update.state, update.prompt])).toEqual([['a', 'exited', 'Fix it']]);
        expect(test.tracker.annotate([{ ...shell('a', 20), agentState: 'done' }])[0].agentState).toBe('exited');
    });
});
