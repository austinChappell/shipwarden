import { describe, expect, it } from 'vitest';
import type { TerminalSession } from '@shared/terminal';
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, waitForAgent, waitTimeoutMs } from './agent-wait';

function agent(change: Partial<TerminalSession>): TerminalSession {
    return { id: 's1', title: 'Claude Code', cwd: '/w/a', worktreePath: '/w/a', isAgent: true, exited: false, ...change };
}

/** A fake clock. Each sleep moves the clock and gives the next list of sessions. */
function script(lists: TerminalSession[][]) {
    let time = 1000;
    let index = 0;
    return {
        sessions: async () => lists[Math.min(index, lists.length - 1)],
        now: () => time,
        sleep: async (ms: number) => {
            time += ms;
            index += 1;
        },
        polls: () => index
    };
}

const base = { worktree: '/w/a', timeoutMs: 60_000, signal: new AbortController().signal, pollMs: 1000 };

describe('waitForAgent', () => {
    it('waits while the agent works, and ends when it is idle', async () => {
        const fake = script([[agent({ agentState: 'working' })], [agent({ agentState: 'working' })], [agent({ agentState: 'idle', agentMessage: 'Done.' })]]);
        const result = await waitForAgent({ ...base, ...fake });
        expect(result).toEqual({ sessionId: 's1', title: 'Claude Code', state: 'idle', message: 'Done.' });
        expect(fake.polls()).toBe(2);
    });

    it('ends when the agent is waiting for input', async () => {
        const fake = script([[agent({ agentState: 'waiting' })]]);
        expect((await waitForAgent({ ...base, ...fake })).state).toBe('waiting');
    });

    it('counts an idle agent as busy until it reacts to the prompt', async () => {
        const fake = script([
            [agent({ agentState: 'idle', agentStateAt: 500 })],
            [agent({ agentState: 'working', agentStateAt: 1500 })],
            [agent({ agentState: 'idle', agentStateAt: 3000 })]
        ]);
        const result = await waitForAgent({ ...base, ...fake, sessionId: 's1', after: 1000 });
        expect(result.state).toBe('idle');
        expect(fake.polls()).toBe(2);
    });

    it('stops the grace time after a few seconds', async () => {
        const fake = script([[agent({ agentState: 'idle', agentStateAt: 500 })]]);
        const result = await waitForAgent({ ...base, ...fake, sessionId: 's1', after: 1000, graceMs: 3000 });
        expect(result.state).toBe('idle');
        expect(fake.polls()).toBe(3);
    });

    it('gives the exited state when the session exits', async () => {
        const fake = script([[agent({ agentState: 'working' })], [agent({ exited: true })]]);
        expect((await waitForAgent({ ...base, ...fake, sessionId: 's1' })).state).toBe('exited');
    });

    it('fails when the worktree has no agent', async () => {
        const fake = script([[agent({ worktreePath: '/w/b' })]]);
        await expect(waitForAgent({ ...base, ...fake })).rejects.toMatchObject({ code: 'notFound' });
    });

    it('fails at the timeout', async () => {
        const fake = script([[agent({ agentState: 'working' })]]);
        await expect(waitForAgent({ ...base, ...fake, timeoutMs: 3000 })).rejects.toMatchObject({ code: 'timeout' });
    });

    it('stops when the signal aborts', async () => {
        const controller = new AbortController();
        const fake = script([[agent({ agentState: 'working' })]]);
        const sleep = async (ms: number) => {
            await fake.sleep(ms);
            controller.abort();
        };
        await expect(waitForAgent({ ...base, ...fake, sleep, signal: controller.signal })).rejects.toThrow('cancelled');
    });
});

describe('waitTimeoutMs', () => {
    it('converts seconds and keeps the limits', () => {
        expect(waitTimeoutMs(90)).toBe(90_000);
        expect(waitTimeoutMs(undefined)).toBe(DEFAULT_WAIT_MS);
        expect(waitTimeoutMs(-1)).toBe(DEFAULT_WAIT_MS);
        expect(waitTimeoutMs(10 ** 9)).toBe(MAX_WAIT_MS);
    });
});
