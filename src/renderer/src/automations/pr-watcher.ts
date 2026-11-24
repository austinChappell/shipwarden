import type { AutomationEvent } from '@shared/automations';
import type { McpWatch, WatchEvent } from '@shared/mcp';
import { watchEndedMessage, watchesFor, watchMessage } from '@shared/pr-watch';

/** The error of `promptAgent` when the session of the watch does not run anymore. */
export const TAB_CLOSED_ERROR = 'The agent tab closed.';
/** The time between two tries of a message that did not go to the agent, for example while the agent asks a question. */
export const WATCH_RETRY_MS = 60_000;
/** The most tries of one message. */
export const WATCH_MAX_TRIES = 10;

export interface PullRequestWatcherDeps {
    /** Types the message into the session of the watch. Rejects with TAB_CLOSED_ERROR when the session does not run. */
    send(watch: McpWatch, message: string): Promise<void>;
    /** Ends a watch in the main process. */
    end(watch: McpWatch): Promise<void>;
}

/**
 * Sends the messages of watch_pull_request. The automation engine gives it the events that it finds and the pull
 * requests that left the open list. Each event goes to each watch one time only.
 */
export class PullRequestWatcher {
    private watches: McpWatch[] = [];
    private readonly sent = new Set<string>();

    constructor(
        private readonly deps: PullRequestWatcherDeps,
        private readonly retryMs = WATCH_RETRY_MS
    ) {}

    setWatches(watches: McpWatch[]): void {
        this.watches = watches;
    }

    /** True when a watch needs the events of the trigger. The engine then finds those events also without an automation. */
    wants(trigger: WatchEvent): boolean {
        return this.watches.some(watch => watch.events.includes(trigger));
    }

    /** True when a watch exists. The engine then watches the open pull requests of the worktrees. */
    active(): boolean {
        return this.watches.length > 0;
    }

    onEvent(event: AutomationEvent): void {
        for (const watch of watchesFor(this.watches, event)) {
            const key = `${watch.id}\0${event.key}`;
            if (this.sent.has(key)) continue;
            this.sent.add(key);
            this.deliver(watch, watchMessage(event), 1);
        }
    }

    /** A pull request of a worktree left the open list. Its watches end, and their agents get a last message. */
    onClosed(worktree: string, number: number): void {
        for (const watch of this.watches.filter(item => item.worktree === worktree && item.number === number)) {
            this.watches = this.watches.filter(item => item.id !== watch.id);
            this.deliver(watch, watchEndedMessage(number), WATCH_MAX_TRIES);
            this.deps.end(watch).catch(error => console.warn(`[mcp] The watch of #${number} did not end: ${errorText(error)}`));
        }
    }

    private deliver(watch: McpWatch, message: string, attempt: number): void {
        this.deps.send(watch, message).catch(error => {
            if (errorText(error) === TAB_CLOSED_ERROR) {
                this.watches = this.watches.filter(item => item.id !== watch.id);
                this.deps.end(watch).catch(() => undefined);
                return;
            }
            if (attempt >= WATCH_MAX_TRIES || !this.watches.some(item => item.id === watch.id)) {
                console.warn(`[mcp] A watch message did not go to the agent: ${errorText(error)}`);
                return;
            }
            setTimeout(() => this.deliver(watch, message, attempt + 1), this.retryMs);
        });
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
