import { describe, expect, it } from 'vitest';
import { codeNotePrompt, isLiveAgent, noteTargetOptions } from './code-note';
import type { TerminalSession } from './terminal';

const session = (change: Partial<TerminalSession>): TerminalSession => ({ id: 'a', title: 'Claude Code', cwd: '/w', isAgent: true, exited: false, ...change });

const agents = [
    { id: 'claude', name: 'Claude Code', command: 'claude' },
    { id: 'codex', name: 'Codex', command: 'codex' }
];

describe('isLiveAgent', () => {
    it('accepts agent tabs and shell tabs that run an agent, but not ended sessions', () => {
        expect(isLiveAgent(session({}))).toBe(true);
        expect(isLiveAgent(session({ isAgent: false, agentProgram: 'codex' }))).toBe(true);
        expect(isLiveAgent(session({ isAgent: false }))).toBe(false);
        expect(isLiveAgent(session({ exited: true }))).toBe(false);
    });
});

describe('noteTargetOptions', () => {
    it('puts the running agents first, then the repository agent, then the other agents', () => {
        const options = noteTargetOptions([
            session({ id: 's1', agentState: 'working', agentPrompt: 'fix the login test' }),
            session({ id: 's2', isAgent: false, title: 'shell', agentProgram: 'codex' }),
            session({ id: 's3', isAgent: false, title: 'shell' })
        ], agents, 'codex');
        expect(options.map(option => option.key)).toEqual(['s:s1', 's:s2', 'n:codex', 'n:claude']);
        expect(options[0].label).toBe('Claude Code · Working · fix the login test');
        expect(options[1].label).toBe('Codex');
        expect(options[2]).toEqual({ key: 'n:codex', label: 'New Codex', target: { kind: 'new', agentId: 'codex' } });
    });

    it('shortens a long prompt', () => {
        const [option] = noteTargetOptions([session({ agentPrompt: 'x'.repeat(60) })], [], undefined);
        expect(option.label).toBe(`Claude Code · ${'x'.repeat(40)}…`);
    });
});

describe('codeNotePrompt', () => {
    it('names the file and the lines, fences the code and ends with the note', () => {
        const prompt = codeNotePrompt({ path: 'src/a.ts', startLine: 7, endLine: 7, code: 'a ``` b', note: 'Rename this variable.' });
        expect(prompt).toContain('src/a.ts, line 7.');
        expect(prompt).toContain('````\na ``` b\n````');
        expect(prompt.endsWith('\n\nRename this variable.')).toBe(true);
    });
});
