import { basename } from 'path';
import type { AgentState } from '@shared/agents';
import { activeRelayUrl, type RemoteAutomationRun, type RemoteSettings } from '@shared/remote';
import type { PushTarget } from '../remote/remote-devices';
import { sendPush, type PushMessage, type PushResult, type RelayTicket } from './relay-client';

/** The parts of `RemoteDevices` that the sender uses. */
export interface PushDevices {
    pushTargets(relayUrl: string): Promise<PushTarget[]>;
    clearPush(id: string, ticket: string): Promise<void>;
}

export interface PushSenderOptions {
    /** The phone settings. The sender reads them for each notification. */
    settings(): Promise<RemoteSettings>;
    /** The paired phones. A new instance reads the file again, because the app and the helper both write it. */
    devices(): PushDevices;
    /** Resolves when the trusted certificates of Settings › Network apply. */
    ready?: Promise<void>;
    send?: (relayUrl: string, ticket: RelayTicket, message: PushMessage) => Promise<PushResult>;
    log(message: string): void;
}

export interface PushOutcome {
    /** The number of phones that the relay accepted. */
    sent: number;
    errors: string[];
}

/**
 * Sends push notifications to the paired phones through the push relay. The message has a kind, a worktree name, and
 * IDs. It has no agent text. Each process (the app and the background helper) has its own sender.
 */
export class PushSender {
    constructor(private readonly options: PushSenderOptions) {}

    /** Sends a message to each phone with a ticket of the current relay. Sends nothing while the setting is off. */
    async send(message: PushMessage): Promise<PushOutcome> {
        const relayUrl = activeRelayUrl(await this.options.settings());
        if (!relayUrl) return { sent: 0, errors: [] };
        const devices = this.options.devices();
        const targets = await devices.pushTargets(relayUrl);
        if (targets.length === 0) return { sent: 0, errors: [] };
        await this.options.ready;
        const send = this.options.send ?? sendPush;
        const results = await Promise.all(targets.map(async target => ({ target, result: await send(relayUrl, target.push, message) })));
        const errors: string[] = [];
        for (const { target, result } of results) {
            if (result.ok) continue;
            errors.push(result.error);
            this.options.log(`The notification did not go to a phone. ${result.error}`);
            if (result.gone) await devices.clearPush(target.deviceId, target.push.ticket).catch(() => undefined);
        }
        return { sent: results.length - errors.length, errors };
    }

    /** Sends a test notification for Settings › Mobile. Throws an error that tells what is missing. */
    async test(): Promise<number> {
        const settings = await this.options.settings();
        if (!settings.enabled) throw new Error('Turn on phone connections first.');
        if (!settings.notifications) throw new Error('Turn on push notifications first.');
        const relayUrl = activeRelayUrl(settings);
        if (!relayUrl) throw new Error('Type the address of your push relay first.');
        if ((await this.options.devices().pushTargets(relayUrl)).length === 0) {
            throw new Error('No phone is registered for notifications. Open the ShipWarden app on the phone and allow notifications.');
        }
        const outcome = await this.send({ kind: 'test' });
        if (outcome.sent === 0) throw new Error(outcome.errors[0] ?? 'The relay did not send the notification.');
        return outcome.sent;
    }
}

/** The name of a worktree for a notification: the folder name. The worktree folders have the names of their branches. */
export function worktreeLabel(worktreePath: string | undefined): string | undefined {
    return worktreePath ? basename(worktreePath) || undefined : undefined;
}

/** The notification of an automation run that is waiting for approval. */
export function approvalMessage(run: Pick<RemoteAutomationRun, 'id' | 'worktreePath'>): PushMessage {
    const worktree = worktreeLabel(run.worktreePath);
    return { kind: 'approval', runId: run.id, ...(worktree ? { worktree } : {}) };
}

/**
 * The time that an agent must wait before the phone gets a notification. An agent often asks for a permission and
 * the user answers it on the Mac at once. Then the phone gets no notification.
 */
export const NEEDS_INPUT_DELAY_MS = 10_000;

export interface NeedsInputPushOptions {
    send(message: PushMessage): Promise<unknown>;
    /** The worktree of an agent session. */
    worktreeOf(sessionId: string): Promise<string | undefined>;
    delayMs?: number;
}

/**
 * Sends "Agent needs input" when an agent goes to the "waiting" state and stays in it for a short time. Each wait
 * sends one notification. A different state ends the wait.
 */
export class NeedsInputPush {
    private readonly waits = new Map<string, ReturnType<typeof setTimeout> | 'sent'>();

    constructor(private readonly options: NeedsInputPushOptions) {}

    /** Gives a new state of an agent session. */
    agentState(sessionId: string, state: AgentState | undefined): void {
        if (state !== 'waiting') {
            this.forget(sessionId);
            return;
        }
        if (this.waits.has(sessionId)) return;
        const timer = setTimeout(() => {
            this.waits.set(sessionId, 'sent');
            void this.notify(sessionId);
        }, this.options.delayMs ?? NEEDS_INPUT_DELAY_MS);
        this.waits.set(sessionId, timer);
    }

    /** Ends the wait of a session, for example when its terminal closes. */
    forget(sessionId: string): void {
        const wait = this.waits.get(sessionId);
        if (wait && wait !== 'sent') clearTimeout(wait);
        this.waits.delete(sessionId);
    }

    stop(): void {
        for (const id of [...this.waits.keys()]) this.forget(id);
    }

    private async notify(sessionId: string): Promise<void> {
        const worktree = worktreeLabel(await this.options.worktreeOf(sessionId).catch(() => undefined));
        await this.options.send({ kind: 'needsInput', agentId: sessionId, ...(worktree ? { worktree } : {}) }).catch(() => undefined);
    }
}
