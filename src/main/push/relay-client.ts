import { createHmac } from 'crypto';

/**
 * The client of the push relay (`relay/` in this repository). The Mac sends a push request with the ticket and the
 * push key that the phone got from the relay. The relay makes the notification text. The Mac sends no agent text.
 *
 * This file uses only Node modules, so the relay tests can import it and check the signature.
 */

/** The kinds of notifications. The relay knows the same kinds. */
export type PushKind = 'needsInput' | 'approval' | 'test';

export interface PushMessage {
    kind: PushKind;
    /** The name of the worktree. The notification shows it. */
    worktree?: string;
    /** The agent session. A tap opens it. */
    agentId?: string;
    /** The automation run that is waiting for approval. */
    runId?: string;
}

/** The ticket and the push key that the phone got from the relay. */
export interface RelayTicket {
    ticket: string;
    /** The push key, as base64url. */
    key: string;
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

const TIMEOUT_MS = 15_000;

/** Signs a push request: an HMAC-SHA256 of "<time>.<body>" with the push key. Returns the signature as base64url. */
export function signPushRequest(key: string, time: number, body: string): string {
    return createHmac('sha256', Buffer.from(key, 'base64url')).update(`${time}.${body}`).digest('base64url');
}

/** Makes the URL of a relay path. The relay URL can have a path, for example "https://example.com/relay". */
export function relayEndpoint(relayUrl: string, path: string): string {
    return `${relayUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Sends a push request to the relay. A 410 answer means that the phone does not accept notifications anymore
 * (`gone`). The Mac then forgets the ticket of the phone.
 */
export async function sendPush(
    relayUrl: string,
    ticket: RelayTicket,
    message: PushMessage,
    options: { fetch?: typeof fetch; now?: () => number } = {}
): Promise<PushResult> {
    const body = JSON.stringify({ ticket: ticket.ticket, ...message });
    const time = Math.floor((options.now ?? Date.now)() / 1000);
    let response: Response;
    try {
        response = await (options.fetch ?? fetch)(relayEndpoint(relayUrl, '/v1/push'), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-shipwarden-time': String(time),
                'x-shipwarden-signature': signPushRequest(ticket.key, time, body)
            },
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (error) {
        return { ok: false, gone: false, error: `The relay does not answer: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (response.ok) return { ok: true };
    const text = await response.text().catch(() => '');
    let detail = '';
    try {
        detail = (JSON.parse(text) as { error?: string }).error ?? '';
    } catch {
        detail = text.slice(0, 200);
    }
    return { ok: false, gone: response.status === 410, error: `The relay answered ${response.status}${detail ? `: ${detail}` : '.'}` };
}
