import type { BranchSummary } from '@shared/github';

/** The time between two polls. The page polls the summaries of the active project at the same interval. */
export const SUMMARY_POLL_MS = 60_000;

export interface SummaryPollerOptions {
    /** The repositories to poll now. An empty list sends no request. */
    repos(): Promise<string[]>;
    /** The open pull requests of a repository by head branch. One request covers the repository. */
    fetch(repo: string): Promise<Record<string, BranchSummary>>;
    /** Gets the new summaries of the repositories of a poll. A repository that failed is not in the map. */
    onSummaries(summaries: Record<string, Record<string, BranchSummary>>): void | Promise<void>;
    intervalMs?: number;
    log?: (message: string) => void;
}

/**
 * Polls the branch summaries (the open pull requests and their CI state) for the background helper. Only the process
 * that holds the automation lock polls, so the helper and the app never poll for the automations at the same time.
 * It polls only the repositories that an automation or the queue needs, one request for each repository.
 */
export class SummaryPoller {
    private readonly options: SummaryPollerOptions;
    private timer: ReturnType<typeof setInterval> | undefined;
    private polling: Promise<void> | undefined;
    private latest: Record<string, Record<string, BranchSummary>> = {};

    constructor(options: SummaryPollerOptions) {
        this.options = options;
    }

    /** The newest summaries of each repository. */
    summaries(): Record<string, Record<string, BranchSummary>> {
        return this.latest;
    }

    start(): void {
        if (this.timer) return;
        void this.poll();
        this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? SUMMARY_POLL_MS);
    }

    async stop(): Promise<void> {
        clearInterval(this.timer);
        this.timer = undefined;
        await this.polling;
        this.latest = {};
    }

    /** Runs one poll. A call during a poll waits for that poll. */
    poll(): Promise<void> {
        this.polling ??= this.pollOnce().finally(() => {
            this.polling = undefined;
        });
        return this.polling;
    }

    private async pollOnce(): Promise<void> {
        let repos: string[];
        try {
            repos = await this.options.repos();
        } catch (error) {
            this.options.log?.(`The repositories to poll did not load: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const fresh: Record<string, Record<string, BranchSummary>> = {};
        // One repository after the other, so a poll does not send a burst of requests.
        for (const repo of repos) {
            try {
                fresh[repo] = await this.options.fetch(repo);
            } catch (error) {
                this.options.log?.(`The pull requests of ${repo} did not load: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // Forget the repositories that are not polled anymore. Their next first poll gives no events.
        const kept = Object.fromEntries(Object.entries(this.latest).filter(([repo]) => repos.includes(repo)));
        this.latest = { ...kept, ...fresh };
        if (Object.keys(fresh).length > 0) await this.options.onSummaries(fresh);
    }
}
