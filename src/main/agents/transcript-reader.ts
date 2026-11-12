import { promises as fs } from 'fs';
import * as path from 'path';
import type { TranscriptChunk } from '@shared/agent-chat';
import { claudeDataRoots } from '../automations/token-counter';

/** The first read of a transcript reads at most this many bytes from the end of the file. */
export const FIRST_READ_BYTES = 2 * 1024 * 1024;

/** A later read reads at most this many bytes. The next read gets the rest. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * Returns the absolute path of a transcript. Throws an error when the file is not a `.jsonl` file in a Claude Code
 * data folder.
 */
export function transcriptPath(file: string, roots: readonly string[] = claudeDataRoots()): string {
    const resolved = path.resolve(file);
    if (!resolved.endsWith('.jsonl') || !roots.some(root => resolved.startsWith(`${root}${path.sep}`))) {
        throw new Error('The transcript is not in the Claude Code data folder.');
    }
    return resolved;
}

/**
 * Reads the complete lines of a Claude Code transcript after `offset`.
 * - Only a `.jsonl` file in a Claude Code data folder can be read.
 * - A missing file gives no lines. Claude Code makes the file at the first prompt.
 * - An offset of -1 is the first read. It reads only the end of a long file.
 * - An incomplete last line stays for the next read.
 */
export async function readTranscript(file: string, offset: number, roots: readonly string[] = claudeDataRoots()): Promise<TranscriptChunk> {
    const resolved = transcriptPath(file, roots);
    const size = await fs.stat(resolved).then(
        stat => stat.size,
        () => -1
    );
    if (size < 0) return { lines: [], offset: Math.max(offset, 0), truncated: false };
    // A file that is shorter than the offset was written again. Then the read is a first read again.
    const start = offset < 0 || offset > size ? Math.max(size - FIRST_READ_BYTES, 0) : offset;
    const truncated = (offset < 0 || offset > size) && start > 0;
    if (start >= size) return { lines: [], offset: start, truncated: false };
    const end = Math.min(size, start + MAX_READ_BYTES);
    const handle = await fs.open(resolved, 'r');
    try {
        const buffer = Buffer.alloc(end - start);
        await handle.read(buffer, 0, buffer.length, start);
        // The read starts in a line after a skip. Then the first complete line starts after the first new line.
        const from = truncated ? buffer.indexOf(0x0a) + 1 : 0;
        const last = buffer.lastIndexOf(0x0a);
        if (last < from) {
            // No complete line. A line that is longer than one read is not useful in the chat, so the next read skips it.
            return { lines: [], offset: end < size ? end : start, truncated };
        }
        const lines = buffer.subarray(from, last).toString('utf8').split('\n').filter(Boolean);
        return { lines, offset: start + last + 1, truncated };
    } finally {
        await handle.close();
    }
}
