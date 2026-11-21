import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSession } from '@shared/terminal';
import { CheckpointRecorder } from './checkpoint-recorder';
import type { CheckpointInput } from './checkpoints';

function session(id: string, fields: Partial<TerminalSession> = {}): TerminalSession {
    return { id, title: 'Claude', cwd: '/repo/sub', worktreePath: '/repo', isAgent: true, exited: false, ...fields };
}

describe('CheckpointRecorder', () => {
    let sessions: Map<string, TerminalSession>;
    let created: [string, CheckpointInput][];
    let recorder: CheckpointRecorder;

    beforeEach(() => {
        vi.useFakeTimers();
        sessions = new Map();
        created = [];
        recorder = new CheckpointRecorder({
            session: async id => sessions.get(id),
            create: async (cwd, input) => {
                created.push([cwd, input]);
            },
            idleMs: 1000
        });
    });

    afterEach(() => {
        recorder.stop();
        vi.useRealTimers();
    });

    it('saves a checkpoint for each new prompt, and not for other states', async () => {
        sessions.set('s1', session('s1', { agentState: 'idle' }));
        recorder.agentState('s1', { state: 'working', message: 'Reading your prompt', newTurn: true, prompt: 'Fix it', at: 1 });
        recorder.agentState('s1', { state: 'working', message: 'Editing a.ts', at: 2 });
        recorder.agentState('s1', { state: 'done', at: 3 });
        await vi.runAllTimersAsync();
        expect(created).toEqual([['/repo', { session: 's1', kind: 'prompt', prompt: 'Fix it', agent: 'Claude' }]]);
    });

    it('saves a checkpoint when the output of an agent without hooks stops', async () => {
        sessions.set('codex', session('codex', { title: 'Codex' }));
        recorder.output('codex');
        await vi.advanceTimersByTimeAsync(10);
        recorder.output('codex');
        await vi.advanceTimersByTimeAsync(500);
        recorder.output('codex');
        expect(created).toEqual([]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(created).toEqual([['/repo', { session: 'codex', kind: 'idle', prompt: undefined, agent: 'Codex' }]]);
    });

    it('uses no idle timer for an agent with hooks or for a plain shell', async () => {
        sessions.set('claude', session('claude', { agentState: 'starting' }));
        sessions.set('shell', session('shell', { isAgent: false }));
        for (const id of ['claude', 'shell']) {
            recorder.output(id);
            await vi.advanceTimersByTimeAsync(10);
            recorder.output(id);
        }
        await vi.advanceTimersByTimeAsync(5000);
        expect(created).toEqual([]);
    });

    it('never throws when a checkpoint fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        recorder = new CheckpointRecorder({
            session: async id => session(id),
            create: async () => {
                throw new Error('not a git repository');
            }
        });
        expect(() => recorder.agentState('s1', { state: 'working', newTurn: true, at: 1 })).not.toThrow();
        await vi.runAllTimersAsync();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a git repository'));
        warn.mockRestore();
    });
});
