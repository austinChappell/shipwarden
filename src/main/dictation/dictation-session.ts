import {
    type DictationErrorCode,
    type DictationState,
    type DictationUpdate,
    type HelperEvent,
    isDictationEnded,
    LineSplitter,
    parseHelperLine
} from '@shared/dictation';

/** The parts of a child process that a session uses. A test gives a fake process. */
export interface HelperProcess {
    stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
    stdin: { write(text: string): unknown; end(): unknown; on(event: 'error', listener: (error: Error) => void): unknown } | null;
    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    kill(signal?: NodeJS.Signals): unknown;
}

export interface DictationSessionOptions {
    id: string;
    /** Starts the helper process. It can throw. */
    spawn: () => HelperProcess;
    /** Gets each change of the session. */
    onUpdate: (update: DictationUpdate) => void;
    /** The maximum time from "stop" to the final text. After this time, the newest partial text is the final text. */
    stopTimeoutMs?: number;
}

/** The default maximum time from "stop" to the final text. */
export const STOP_TIMEOUT_MS = 5000;

/**
 * One dictation: one run of the helper. The state goes from "starting" to "listening" to "stopping", and ends in
 * "done", "error", or "cancelled". After the end, the session ignores the helper and sends no update.
 */
export class DictationSession {
    readonly id: string;
    private state: DictationState = 'starting';
    private partial = '';
    private process: HelperProcess | undefined;
    private readonly lines = new LineSplitter();
    private stopTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly options: DictationSessionOptions;

    constructor(options: DictationSessionOptions) {
        this.options = options;
        this.id = options.id;
    }

    /** The current state. */
    current(): DictationUpdate {
        return { id: this.id, state: this.state, partial: this.partial };
    }

    /** True when the session does not change any more. */
    ended(): boolean {
        return isDictationEnded(this.state);
    }

    /** Starts the helper. */
    start(): void {
        if (this.process || this.ended()) return;
        this.send();
        let child: HelperProcess;
        try {
            child = this.options.spawn();
        } catch (error) {
            this.fail(error instanceof DictationStartError ? error.code : 'helperMissing', messageOf(error));
            return;
        }
        this.process = child;
        child.stdout?.on('data', chunk => {
            for (const line of this.lines.push(chunk.toString())) this.onLine(line);
        });
        // A helper that stopped can close stdin before the session writes "stop". The exit event reports the stop.
        child.stdin?.on('error', () => undefined);
        child.on('error', error => this.fail('helperMissing', error.message));
        child.on('exit', (code, signal) => {
            for (const line of this.lines.flush()) this.onLine(line);
            if (this.ended()) return;
            if (this.state === 'stopping') {
                // The helper stopped without a final text. Keep the words until now.
                this.finish(this.partial);
                return;
            }
            this.fail('helperFailed', signal ? `The helper stopped with the signal ${signal}.` : `The helper stopped with the exit code ${code ?? 'unknown'}.`);
        });
    }

    /** Stops the recording. The helper then sends the final text. */
    stop(): void {
        if (this.ended() || this.state === 'stopping') return;
        if (!this.process) {
            this.finish('');
            return;
        }
        this.state = 'stopping';
        this.send();
        this.process.stdin?.write('stop\n');
        this.stopTimer = setTimeout(() => {
            if (this.ended()) return;
            this.finish(this.partial);
            this.process?.kill('SIGTERM');
        }, this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
    }

    /** Stops at once, without a text. */
    cancel(): void {
        if (this.ended()) return;
        this.end('cancelled');
        if (!this.process) return;
        this.process.stdin?.write('cancel\n');
        this.process.stdin?.end();
        this.process.kill('SIGTERM');
    }

    private onLine(line: string): void {
        const event = parseHelperLine(line);
        if (event) this.onEvent(event);
    }

    private onEvent(event: HelperEvent): void {
        if (this.ended()) return;
        switch (event.type) {
            case 'listening':
                if (this.state !== 'starting') return;
                this.state = 'listening';
                this.send();
                return;
            case 'partial':
                if (event.text === this.partial) return;
                this.partial = event.text;
                this.send();
                return;
            case 'final':
                this.finish(event.text);
                return;
            case 'error':
                this.fail(event.code, event.message);
                return;
        }
    }

    private finish(text: string): void {
        this.end('done', { text });
    }

    private fail(code: DictationErrorCode, message: string): void {
        this.end('error', { error: { code, message } });
        this.process?.kill('SIGTERM');
    }

    private end(state: DictationState, extra: Partial<DictationUpdate> = {}): void {
        if (this.ended()) return;
        this.state = state;
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTimer = undefined;
        this.send(extra);
    }

    private send(extra: Partial<DictationUpdate> = {}): void {
        this.options.onUpdate({ ...this.current(), ...extra });
    }
}

/** An error of `spawn` with its code for the page. Other errors of `spawn` get the code "helperMissing". */
export class DictationStartError extends Error {
    readonly code: DictationErrorCode;

    constructor(code: DictationErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
