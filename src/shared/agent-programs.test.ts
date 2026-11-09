import { describe, expect, it } from 'vitest';
import { agentProcessesBelow, agentProgramOf } from './agent-programs';
import type { ProcessRow } from './processes';

const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, cpu: 0, rssKb: 0, elapsed: '00:01', command });

describe('agentProgramOf', () => {
    it('finds Claude Code and Codex', () => {
        expect(agentProgramOf('claude')).toBe('claude');
        expect(agentProgramOf('/Users/me/.local/share/claude/versions/2.1.319 --settings /x.json')).toBe('claude');
        expect(agentProgramOf('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('claude');
        expect(agentProgramOf('codex --no-daemon')).toBe('codex');
        expect(agentProgramOf('/opt/homebrew/bin/codex')).toBe('codex');
        expect(agentProgramOf('node /usr/lib/node_modules/@openai/codex/bin/codex.js')).toBe('codex');
    });

    it('finds Gemini CLI', () => {
        expect(agentProgramOf('gemini')).toBe('gemini');
        expect(agentProgramOf('/opt/homebrew/bin/gemini --yolo')).toBe('gemini');
        expect(agentProgramOf('node /opt/homebrew/bin/gemini')).toBe('gemini');
        // Gemini CLI starts itself again in node with a larger memory limit.
        expect(agentProgramOf('node --max-old-space-size=8192 /usr/lib/node_modules/@google/gemini-cli/dist/index.js')).toBe('gemini');
        expect(agentProgramOf('vim gemini.md')).toBeUndefined();
        expect(agentProgramOf('node --inspect server.js')).toBeUndefined();
    });

    it('finds opencode', () => {
        expect(agentProgramOf('opencode')).toBe('opencode');
        expect(agentProgramOf('/Users/me/.opencode/bin/opencode --model anthropic/claude-sonnet-4')).toBe('opencode');
        // The npm package starts the native binary from a node script.
        expect(agentProgramOf('node /opt/homebrew/lib/node_modules/opencode-ai/bin/opencode')).toBe('opencode');
        expect(agentProgramOf('vim opencode.json')).toBeUndefined();
    });

    it('ignores other programs', () => {
        expect(agentProgramOf('/bin/zsh -l')).toBeUndefined();
        expect(agentProgramOf('/Users/me/.codex/bin/codex-code-mode-host')).toBeUndefined();
        expect(agentProgramOf('vim claude.md')).toBeUndefined();
        expect(agentProgramOf('node server.js')).toBeUndefined();
    });
});

describe('agentProcessesBelow', () => {
    it('returns the top agents below the root with their ancestors', () => {
        const rows = [
            row(1, 0, '/sbin/launchd'),
            row(10, 1, 'pty-host'),
            row(20, 10, '/bin/zsh -l'),
            row(21, 20, 'claude'),
            // A subagent of the agent does not count.
            row(22, 21, 'claude'),
            row(30, 10, '/bin/zsh -l'),
            row(31, 30, 'npm run dev'),
            // An agent outside the root does not count.
            row(40, 1, 'codex')
        ];
        expect(agentProcessesBelow(rows, 10)).toEqual([{ pid: 21, program: 'claude', ancestors: [21, 20] }]);
    });
});
