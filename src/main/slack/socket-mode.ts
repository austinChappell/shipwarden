/**
 * A Socket Mode client for Slack. ShipWarden opens a WebSocket to Slack, so it needs no public URL.
 * - `apps.connections.open` (with the app-level token) gives a new WebSocket address.
 * - Slack sends "hello" when the connection is ready.
 * - Slack sends each event in an envelope. The client must acknowledge the envelope ID in 3 seconds, else Slack sends
 *   the event again.
 * - Slack sends "disconnect" before it closes a connection, for example to refresh it. The client then connects again.
 */

/** The parts of a WebSocket that the client uses. The global `WebSocket` of Node has them. The tests use a fake. */
export interface SocketLike {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** The payload of an "events_api" envelope. */
export interface SlackEventCallback {
    event_id?: string;
    team_id?: string;
    event?: SlackEvent;
}

/** The fields of a Slack event that ShipWarden reads ("message" and "app_mention"). */
export interface SlackEvent {
    type: string;
    subtype?: string;
    channel?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
}

export type SocketState = 'connecting' | 'connected' | 'error';

/** The errors of `apps.connections.open` that do not go away with a new try. The client stops after them. */
export const FATAL_CODES: ReadonlySet<string> = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'not_allowed_token_type']);

export interface SocketModeOptions {
    /** Calls `apps.connections.open` and returns the WebSocket address. */
    openUrl(): Promise<string>;
    socket?: SocketFactory;
    /** An event from the Events API. The client acknowledged its envelope first. */
    onEvent(payload: SlackEventCallback): void;
    onState(state: SocketState, error?: string): void;
    log(message: string): void;
    /** The wait before a new connection, for the number of failed tries. */
    retryDelayMs?(attempt: number): number;
}

/** 1, 2, 4, … seconds, and at most 1 minute. */
function defaultRetryDelay(attempt: number): number {
    return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function errorCode(error: unknown): string | undefined {
    const code = (error as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' ? code : undefined;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Reads an envelope. Returns undefined for a text that is not a JSON object. */
export function parseEnvelope(data: unknown): Record<string, unknown> | undefined {
    const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : undefined;
    if (text === undefined) return undefined;
    try {
        const value = JSON.parse(text) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

export class SocketModeClient {
    private socket: SocketLike | undefined;
    private stopped = true;
    private attempt = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly options: SocketModeOptions) {}

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        this.attempt = 0;
        void this.connect();
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
        this.timer = undefined;
        const socket = this.socket;
        this.socket = undefined;
        socket?.close(1000, 'stop');
    }

    private async connect(): Promise<void> {
        if (this.stopped) return;
        this.options.onState('connecting');
        let url: string;
        try {
            url = await this.options.openUrl();
        } catch (error) {
            if (this.stopped) return;
            const code = errorCode(error);
            this.options.onState('error', errorText(error));
            if (code && FATAL_CODES.has(code)) {
                // A wrong token does not start to work by itself. A new token or a new start of the switch tries again.
                this.stopped = true;
                return;
            }
            this.retry();
            return;
        }
        if (this.stopped) return;
        const factory = this.options.socket ?? ((address: string) => new WebSocket(address) as unknown as SocketLike);
        let socket: SocketLike;
        try {
            socket = factory(url);
        } catch (error) {
            this.options.onState('error', errorText(error));
            this.retry();
            return;
        }
        this.socket = socket;
        socket.addEventListener('message', event => {
            if (this.socket === socket) this.receive(socket, event.data);
        });
        socket.addEventListener('close', () => {
            if (this.socket !== socket) return;
            this.socket = undefined;
            if (this.stopped) return;
            this.options.log('The Slack connection closed.');
            this.options.onState('connecting');
            this.retry();
        });
        socket.addEventListener('error', () => {
            if (this.socket === socket) this.options.log('The Slack connection has an error.');
        });
    }

    /** Connects again after a wait that grows with each failed try. */
    private retry(): void {
        if (this.stopped) return;
        this.attempt += 1;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.connect(), (this.options.retryDelayMs ?? defaultRetryDelay)(this.attempt));
    }

    /** Handles one frame. Each envelope with an ID gets its acknowledgement before the event goes on. */
    private receive(socket: SocketLike, data: unknown): void {
        const envelope = parseEnvelope(data);
        if (!envelope) return;
        const id = envelope.envelope_id;
        if (typeof id === 'string' && id) socket.send(JSON.stringify({ envelope_id: id }));
        switch (envelope.type) {
            case 'hello':
                this.attempt = 0;
                this.options.onState('connected');
                return;
            case 'disconnect':
                this.options.log(`Slack asked for a new connection (${String(envelope.reason ?? 'no reason')}).`);
                if (envelope.reason === 'link_disabled') {
                    this.stop();
                    this.options.onState('error', 'Socket Mode is off for the Slack app. Turn it on in the app settings on api.slack.com.');
                    return;
                }
                // The close event connects again.
                socket.close(1000, 'refresh');
                return;
            case 'events_api': {
                const payload = envelope.payload;
                if (!payload || typeof payload !== 'object') return;
                try {
                    this.options.onEvent(payload as SlackEventCallback);
                } catch (error) {
                    this.options.log(`A Slack event failed: ${errorText(error)}`);
                }
                return;
            }
            default:
                // Slash commands and interactive envelopes need only the acknowledgement.
                return;
        }
    }
}
