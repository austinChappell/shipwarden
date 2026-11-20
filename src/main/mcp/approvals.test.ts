import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpApprovalGate, McpApprovalStore, type ApprovalRequest } from './approvals';

const folders: string[] = [];
function store(onChanged = vi.fn()) {
    const folder = mkdtempSync(join(tmpdir(), 'mcp-approvals-'));
    folders.push(folder);
    return new McpApprovalStore(join(folder, 'approvals.json'), onChanged);
}

afterEach(() => {
    folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true }));
    vi.useRealTimers();
});

const request: ApprovalRequest = { worktree: '/w/a', tool: 'ask_agent', summary: 'Ask the agent of "b": Hi?' };

describe('McpApprovalStore', () => {
    it('adds, lists, and revokes the approvals of a worktree', async () => {
        const changed = vi.fn();
        const approvals = store(changed);
        await approvals.add('/w/a', 'set_task_status');
        await approvals.add('/w/a', 'ask_agent');
        await approvals.add('/w/b', 'ask_agent');
        expect(await approvals.list()).toEqual({ '/w/a': ['ask_agent', 'set_task_status'], '/w/b': ['ask_agent'] });
        expect(await approvals.has('/w/a', 'ask_agent')).toBe(true);
        expect(await approvals.revoke('/w/a')).toEqual({ '/w/b': ['ask_agent'] });
        expect(await approvals.has('/w/a', 'ask_agent')).toBe(false);
        expect(changed).toHaveBeenLastCalledWith({ '/w/b': ['ask_agent'] });
    });
});

describe('McpApprovalGate', () => {
    it('asks the first time, remembers "Allow" for the worktree, and does not ask again', async () => {
        const approvals = store();
        const ask = vi.fn(async () => true);
        const gate = new McpApprovalGate({ store: approvals, ask });
        await gate.approve(request);
        await gate.approve(request);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(await approvals.has('/w/a', 'ask_agent')).toBe(true);
        // Another worktree and another tool ask again.
        await gate.approve({ ...request, worktree: '/w/b' });
        await gate.approve({ ...request, tool: 'set_task_status' });
        expect(ask).toHaveBeenCalledTimes(3);
    });

    it('rejects a denial and does not remember it', async () => {
        const approvals = store();
        const ask = vi.fn(async () => false);
        const gate = new McpApprovalGate({ store: approvals, ask });
        await expect(gate.approve(request)).rejects.toThrow('The user denied ask_agent for this worktree.');
        await expect(gate.approve(request)).rejects.toThrow('denied');
        expect(ask).toHaveBeenCalledTimes(2);
        expect(await approvals.list()).toEqual({});
    });

    it('shares one question between two calls at the same time', async () => {
        let allow: (value: boolean) => void = () => undefined;
        const ask = vi.fn(() => new Promise<boolean>(resolve => (allow = resolve)));
        const gate = new McpApprovalGate({ store: store(), ask });
        const first = gate.approve(request);
        const second = gate.approve(request);
        await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
        allow(true);
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    });

    it('times out with a clear error when nobody answers, and aborts the dialog', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        // This dialog ignores the signal. The gate must not wait for it.
        const ask = vi.fn((_request: ApprovalRequest, abort: AbortSignal) => {
            signal = abort;
            return new Promise<boolean>(() => undefined);
        });
        // An in-memory store, because the fake timers do not wait for file reads.
        const approvals = { has: async () => false, add: vi.fn(async () => undefined) };
        const gate = new McpApprovalGate({ store: approvals, ask, timeoutMs: 120_000 });
        const result = gate.approve(request);
        const check = expect(result).rejects.toThrow('The user did not approve ask_agent in 2 minutes.');
        await vi.advanceTimersByTimeAsync(120_000);
        await check;
        expect(signal?.aborted).toBe(true);
        expect(approvals.add).not.toHaveBeenCalled();
    });

    it('stops the wait of a caller whose signal aborts', async () => {
        const gate = new McpApprovalGate({ store: store(), ask: () => new Promise<boolean>(() => undefined) });
        const controller = new AbortController();
        const result = gate.approve(request, controller.signal);
        controller.abort();
        await expect(result).rejects.toThrow('cancelled');
    });
});
