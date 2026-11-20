import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { linesToKeep, type NewStatsEvent, parseStatsLine, STATS_RETENTION_MS, type StatsEvent, statsLine } from '@shared/stats';

/**
 * Keeps the event log of the agent stats in one JSON lines file. An event adds one line to the end of the file.
 * The writes happen one at a time, in order. A failed write logs a warning and never throws, because the log must not
 * stop the app.
 */
export class StatsStore {
    private queue: Promise<void> = Promise.resolve();
    private warned = false;

    constructor(
        private readonly file: string,
        private readonly now: () => number = Date.now
    ) {}

    /** Adds an event to the end of the log. It returns at once. `flush` waits for the write. */
    append(event: NewStatsEvent): void {
        let line: string;
        try {
            line = statsLine(event);
        } catch (error) {
            this.warn(error);
            return;
        }
        this.enqueue(async () => {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            await fs.appendFile(this.file, line, 'utf8');
        });
    }

    /** Reads the events at or after `since` (milliseconds), the oldest first. A line that is not valid is ignored. */
    async read(since = 0): Promise<StatsEvent[]> {
        await this.flush();
        let text: string;
        try {
            text = await fs.readFile(this.file, 'utf8');
        } catch {
            return [];
        }
        return text
            .split('\n')
            .map(parseStatsLine)
            .filter((event): event is StatsEvent => !!event && event.at >= since);
    }

    /**
     * Removes the lines of events that are older than the retention time (90 days), and lines that are not valid.
     * The file changes only when a line goes. A temporary file and a rename keep the file whole after a crash.
     */
    prune(maxAgeMs = STATS_RETENTION_MS): Promise<void> {
        return this.enqueue(async () => {
            let text: string;
            try {
                text = await fs.readFile(this.file, 'utf8');
            } catch {
                return;
            }
            const kept = linesToKeep(text, this.now() - maxAgeMs);
            const all = text.split('\n').filter(line => line.trim()).length;
            if (kept.length === all) return;
            const temp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
            try {
                await fs.writeFile(temp, kept.map(line => `${line}\n`).join(''), 'utf8');
                await fs.rename(temp, this.file);
            } catch (error) {
                await fs.rm(temp, { force: true });
                throw error;
            }
        });
    }

    /** Waits for the writes that started before this call. */
    flush(): Promise<void> {
        return this.queue;
    }

    private enqueue(task: () => Promise<void>): Promise<void> {
        this.queue = this.queue.then(task).catch(error => this.warn(error));
        return this.queue;
    }

    private warn(error: unknown): void {
        // One warning is enough. A full disk or a locked file fails each write.
        if (this.warned) return;
        this.warned = true;
        console.warn(`[stats] The agent stats log failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
