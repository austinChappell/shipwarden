/** The part of the terminal API that the tracker uses. */
interface DataSource {
    onData(listener: (id: string, data: string, seq: number) => void): () => void;
}

/**
 * Keeps the time of the last terminal output of each session.
 * The Agents view uses it to show the time since the last output of an agent.
 * The tracker does not notify listeners, because output arrives many times each second. A view reads it on a timer.
 */
export class OutputActivity {
    private readonly times = new Map<string, number>();
    private stop: (() => void) | undefined;

    /** Starts to record the output of all sessions. A second call does nothing. */
    start(source: DataSource, clock: () => number = Date.now): void {
        if (this.stop) return;
        this.stop = source.onData(id => this.record(id, clock()));
    }

    /** Records output of a session at a time in milliseconds. */
    record(id: string, at: number): void {
        this.times.set(id, at);
    }

    /** The time of the last output of a session. Undefined when no output arrived after the app started. */
    get(id: string): number | undefined {
        return this.times.get(id);
    }

    /** Forgets a session that closed. */
    delete(id: string): void {
        this.times.delete(id);
    }
}

export const outputActivity = new OutputActivity();
