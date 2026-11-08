import type { TerminalReplay } from '@shared/terminal';

/**
 * Keeps the most recent output of one terminal session.
 * Each chunk gets a sequence number, so that a view can join the stream without lost or duplicate output.
 */
export class OutputBuffer {
    private chunks: string[] = [];
    private size = 0;
    private lastSeq = 0;

    /** @param limit The maximum number of characters to keep. */
    constructor(private readonly limit = 1024 * 1024) {}

    /** Adds a chunk. Returns the sequence number of the chunk. */
    append(data: string): number {
        this.chunks.push(data);
        this.size += data.length;
        while (this.size > this.limit && this.chunks.length > 1) {
            this.size -= this.chunks.shift()!.length;
        }
        return ++this.lastSeq;
    }

    replay(): TerminalReplay {
        return { data: this.chunks.join(''), seq: this.lastSeq };
    }
}
