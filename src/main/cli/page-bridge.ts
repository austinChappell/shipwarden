import type { BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/api';
import type { CliPageRequest, CliPageResult } from '@shared/cli';
import { CliError } from './cli-server';

/** The page must answer in this time. A new worktree with a fetch and a new agent can take a few minutes. */
export const PAGE_TIMEOUT_MS = 5 * 60_000;

/**
 * Sends the CLI commands that need the page to the window that had the focus last, and waits for the answer.
 * Only one window gets a request, so a command runs one time.
 */
export class CliPageBridge {
    private counter = 0;
    private readonly pending = new Map<number, { resolve(result: CliPageResult): void; reject(error: Error): void }>();

    constructor(
        private readonly window: () => BrowserWindow | undefined,
        private readonly timeoutMs = PAGE_TIMEOUT_MS
    ) {}

    request(request: CliPageRequest, signal: AbortSignal): Promise<CliPageResult> {
        const window = this.window();
        if (!window || window.isDestroyed() || window.webContents.isLoading()) {
            return Promise.reject(new CliError('noWindow', 'The ShipWarden window is closed. Open ShipWarden, then try again.'));
        }
        this.counter += 1;
        const id = this.counter;
        return new Promise<CliPageResult>((resolve, reject) => {
            const timer = setTimeout(() => finish(new CliError('timeout', 'The ShipWarden window did not answer in 5 minutes.')), this.timeoutMs);
            const onClosed = () => finish(new CliError('noWindow', 'The ShipWarden window closed before the command finished.'));
            const onAbort = () => finish(new CliError('failed', 'The command was cancelled.'));
            const finish = (outcome: CliPageResult | Error) => {
                clearTimeout(timer);
                this.pending.delete(id);
                window.removeListener('closed', onClosed);
                signal.removeEventListener('abort', onAbort);
                if (outcome instanceof Error) reject(outcome);
                else resolve(outcome);
            };
            if (signal.aborted) return onAbort();
            window.once('closed', onClosed);
            signal.addEventListener('abort', onAbort, { once: true });
            this.pending.set(id, { resolve: finish, reject: finish });
            window.webContents.send(IpcChannels.cliPageRequest, id, request);
        });
    }

    /** Gives the answer of the page to the request with this id. It ignores an unknown id. */
    answer(id: number, result: CliPageResult | undefined, error: string | undefined): void {
        const entry = this.pending.get(id);
        if (!entry) return;
        if (error !== undefined || !result) entry.reject(new CliError('failed', error ?? 'The page gave no answer.'));
        else entry.resolve({ ...result, message: String(result.message ?? '') });
    }
}
