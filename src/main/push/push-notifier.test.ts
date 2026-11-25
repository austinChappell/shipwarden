import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REMOTE_SETTINGS, type RemoteSettings } from '@shared/remote';
import type { PushTarget } from '../remote/remote-devices';
import { approvalMessage, NeedsInputPush, PushSender, worktreeLabel } from './push-notifier';
import type { PushMessage, PushResult } from './relay-client';

const RELAY = 'https://relay.example.com';
const ON: RemoteSettings = { ...DEFAULT_REMOTE_SETTINGS, enabled: true, notifications: true, relayUrl: RELAY };
const target = (id: string): PushTarget => ({ deviceId: id, push: { relayUrl: RELAY, ticket: `v1.${id}`, key: 'key' } });

function makeSender(settings: RemoteSettings, targets: PushTarget[], result: (id: string) => PushResult = () => ({ ok: true })) {
    const sent: { url: string; ticket: string; message: PushMessage }[] = [];
    const cleared: string[] = [];
    const sender = new PushSender({
        settings: async () => settings,
        devices: () => ({
            pushTargets: async url => targets.filter(item => item.push.relayUrl === url),
            clearPush: async (id, ticket) => {
                cleared.push(`${id}:${ticket}`);
            }
        }),
        send: async (url, ticket, message) => {
            sent.push({ url, ticket: ticket.ticket, message });
            return result(ticket.ticket.slice(3));
        },
        log: () => undefined
    });
    return { sender, sent, cleared };
}

describe('PushSender', () => {
    it('sends the message to each phone with a ticket of the relay', async () => {
        const { sender, sent } = makeSender(ON, [target('a'), target('b')]);
        expect(await sender.send({ kind: 'needsInput', worktree: 'fix-login', agentId: 's1' })).toEqual({ sent: 2, errors: [] });
        expect(sent.map(item => item.ticket)).toEqual(['v1.a', 'v1.b']);
        expect(sent[0]).toEqual({ url: RELAY, ticket: 'v1.a', message: { kind: 'needsInput', worktree: 'fix-login', agentId: 's1' } });
    });

    it('sends nothing while the setting is off or the relay is the placeholder', async () => {
        for (const settings of [
            { ...ON, notifications: false },
            { ...ON, enabled: false },
            { ...ON, relayUrl: DEFAULT_REMOTE_SETTINGS.relayUrl }
        ]) {
            const { sender, sent } = makeSender(settings, [target('a')]);
            expect(await sender.send({ kind: 'test' })).toEqual({ sent: 0, errors: [] });
            expect(sent).toEqual([]);
        }
    });

    it('forgets the ticket of a phone that the relay reports as gone', async () => {
        const { sender, cleared } = makeSender(ON, [target('a'), target('b')], id =>
            id === 'a' ? { ok: false, gone: true, error: 'gone' } : { ok: false, gone: false, error: 'down' }
        );
        expect(await sender.send({ kind: 'test' })).toEqual({ sent: 0, errors: ['gone', 'down'] });
        expect(cleared).toEqual(['a:v1.a']);
    });

    it('tells what is missing for a test notification', async () => {
        await expect(makeSender({ ...ON, enabled: false }, []).sender.test()).rejects.toThrow('phone connections');
        await expect(makeSender({ ...ON, notifications: false }, []).sender.test()).rejects.toThrow('push notifications');
        await expect(makeSender({ ...ON, relayUrl: DEFAULT_REMOTE_SETTINGS.relayUrl }, []).sender.test()).rejects.toThrow('address');
        await expect(makeSender(ON, []).sender.test()).rejects.toThrow('No phone');
        await expect(makeSender(ON, [target('a')], () => ({ ok: false, gone: false, error: 'The relay answered 502.' })).sender.test()).rejects.toThrow('502');
        expect(await makeSender(ON, [target('a')]).sender.test()).toBe(1);
    });
});

describe('the messages', () => {
    it('use the folder name of the worktree and no other text', () => {
        expect(worktreeLabel('/Users/ana/.shipwarden/worktrees/api/fix-login')).toBe('fix-login');
        expect(worktreeLabel(undefined)).toBeUndefined();
        expect(approvalMessage({ id: 'run-1', worktreePath: '/w/api/fix-login' })).toEqual({ kind: 'approval', runId: 'run-1', worktree: 'fix-login' });
        expect(approvalMessage({ id: 'run-2' })).toEqual({ kind: 'approval', runId: 'run-2' });
    });
});

describe('NeedsInputPush', () => {
    afterEach(() => vi.useRealTimers());

    function make() {
        vi.useFakeTimers();
        const sent: PushMessage[] = [];
        const push = new NeedsInputPush({
            send: async message => {
                sent.push(message);
            },
            worktreeOf: async id => (id === 's1' ? '/w/api/fix-login' : undefined),
            delayMs: 1000
        });
        return { push, sent };
    }

    it('sends one notification when an agent waits for the delay', async () => {
        const { push, sent } = make();
        push.agentState('s1', 'waiting');
        push.agentState('s1', 'waiting');
        await vi.advanceTimersByTimeAsync(1000);
        push.agentState('s1', 'waiting');
        await vi.advanceTimersByTimeAsync(5000);
        expect(sent).toEqual([{ kind: 'needsInput', agentId: 's1', worktree: 'fix-login' }]);
    });

    it('sends nothing when the agent continues before the delay', async () => {
        const { push, sent } = make();
        push.agentState('s1', 'waiting');
        await vi.advanceTimersByTimeAsync(500);
        push.agentState('s1', 'working');
        await vi.advanceTimersByTimeAsync(5000);
        expect(sent).toEqual([]);
    });

    it('sends again for a new wait, and nothing after the session closes', async () => {
        const { push, sent } = make();
        push.agentState('s2', 'waiting');
        await vi.advanceTimersByTimeAsync(1000);
        push.agentState('s2', 'working');
        push.agentState('s2', 'waiting');
        await vi.advanceTimersByTimeAsync(1000);
        expect(sent).toEqual([
            { kind: 'needsInput', agentId: 's2' },
            { kind: 'needsInput', agentId: 's2' }
        ]);
        push.agentState('s2', 'working');
        push.agentState('s2', 'waiting');
        push.forget('s2');
        await vi.advanceTimersByTimeAsync(5000);
        expect(sent).toHaveLength(2);
    });
});
