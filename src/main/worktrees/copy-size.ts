import { promises as fs } from 'fs';
import * as path from 'path';
import type { LargeCopyEntry } from '@shared/worktree-settings';

/** The count of files that the size check reads in one folder. A larger folder gets no size, so the preview stays fast. */
const MAX_FILES = 20_000;

/**
 * Returns the copy entries (paths from `root`, a folder with "/" at the end) of `limit` bytes or more, with their size.
 * The check stops in a folder when the size gets to the limit. A folder with more than MAX_FILES files is not reported.
 * Symbolic links count as links. An entry that ShipWarden cannot read is not reported.
 */
export async function largeCopyEntries(root: string, entries: string[], limit: number): Promise<LargeCopyEntry[]> {
    const large: LargeCopyEntry[] = [];
    for (const entry of entries) {
        const size = await sizeOf(path.join(root, entry.replace(/\/+$/, '')), limit).catch(() => undefined);
        if (size !== undefined && size.bytes >= limit) {
            large.push({ path: entry, bytes: size.bytes, ...(size.atLeast ? { atLeast: true } : {}) });
        }
    }
    return large.sort((a, b) => b.bytes - a.bytes);
}

interface Size {
    bytes: number;
    /** True when the check stopped at the limit. The real size is larger. */
    atLeast?: boolean;
}

async function sizeOf(target: string, limit: number): Promise<Size | undefined> {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) return { bytes: stat.size };
    let bytes = 0;
    let files = 0;
    const folders = [target];
    while (folders.length > 0) {
        const folder = folders.pop() as string;
        for (const item of await fs.readdir(folder, { withFileTypes: true })) {
            const full = path.join(folder, item.name);
            if (item.isDirectory()) {
                folders.push(full);
                continue;
            }
            files++;
            if (files > MAX_FILES) return undefined;
            bytes += (await fs.lstat(full)).size;
            if (bytes >= limit) return { bytes, atLeast: true };
        }
    }
    return { bytes };
}
