/**
 * The overlap of the changes of worktrees. Two worktrees overlap when they change the same file. Then their branches
 * can get a merge conflict later. ShipWarden shows the overlap before GitHub reports a conflict.
 *
 * The functions of this module use no Electron API and no browser API. The main process and the page both use them.
 */

import type { GitChanges } from './git';

/** The changed files of one worktree. */
export interface WorktreeFiles {
    /** The absolute path of the worktree folder. */
    path: string;
    /** The branch. Undefined for a detached HEAD. */
    branch?: string;
    /**
     * The files that the worktree changes, from the worktree root, with "/". The list contains the files of the commits
     * since the merge base with the default branch, the staged files, the unstaged files, and the untracked files.
     */
    files: string[];
}

/** A different worktree that changes some of the same files. */
export interface OverlapPeer {
    path: string;
    branch?: string;
    /** The files that both worktrees change, sorted. */
    files: string[];
}

/** The overlap of one worktree with the other worktrees of its repository. */
export interface WorktreeOverlap {
    path: string;
    branch?: string;
    /** The files that one or more peers also change, sorted. Each file shows one time. */
    files: string[];
    /** The other worktrees, sorted by name. */
    peers: OverlapPeer[];
}

/** The most files of a worktree that the main process sends. A larger change gives only the first files. */
export const MAX_WORKTREE_FILES = 5000;

/**
 * Returns the files of a worktree: the files of its commits since the merge base and the files of its git status.
 * The old path of a rename counts too. The list is sorted, each file shows one time, and it has at most
 * `MAX_WORKTREE_FILES` files.
 */
export function worktreeFileList(committed: readonly string[], status: Pick<GitChanges, 'staged' | 'unstaged' | 'conflicted'>): string[] {
    const files = new Set(committed.filter(Boolean));
    for (const change of [...status.staged, ...status.unstaged, ...status.conflicted]) {
        files.add(change.path);
        if (change.oldPath) files.add(change.oldPath);
    }
    return [...files].sort().slice(0, MAX_WORKTREE_FILES);
}

/** Returns the name of a worktree: its branch, else the name of its folder. */
export function worktreeName(item: { path: string; branch?: string }): string {
    return item.branch ?? item.path.split('/').filter(Boolean).pop() ?? item.path;
}

/**
 * Finds the files that two or more worktrees change. Returns the overlap of each worktree that has one, by its path.
 * A worktree without an overlap is not in the result.
 */
export function findOverlaps(list: readonly WorktreeFiles[]): Record<string, WorktreeOverlap> {
    /** The worktrees that change each file, by file. */
    const owners = new Map<string, WorktreeFiles[]>();
    for (const item of list) {
        for (const file of new Set(item.files)) {
            const found = owners.get(file);
            if (found) found.push(item);
            else owners.set(file, [item]);
        }
    }
    /** The shared files of each pair, by the path of the worktree and then by the path of the peer. */
    const shared = new Map<string, Map<string, { peer: WorktreeFiles; files: string[] }>>();
    for (const [file, items] of owners) {
        if (items.length < 2) continue;
        for (const item of items) {
            let peers = shared.get(item.path);
            if (!peers) {
                peers = new Map();
                shared.set(item.path, peers);
            }
            for (const peer of items) {
                if (peer.path === item.path) continue;
                const entry = peers.get(peer.path);
                if (entry) entry.files.push(file);
                else peers.set(peer.path, { peer, files: [file] });
            }
        }
    }
    const result: Record<string, WorktreeOverlap> = {};
    for (const item of list) {
        const peers = shared.get(item.path);
        if (!peers || peers.size === 0) continue;
        const peerList = [...peers.values()]
            .map(({ peer, files }) => ({ path: peer.path, ...(peer.branch ? { branch: peer.branch } : {}), files: files.sort() }))
            .sort((a, b) => worktreeName(a).localeCompare(worktreeName(b)) || a.path.localeCompare(b.path));
        result[item.path] = {
            path: item.path,
            ...(item.branch ? { branch: item.branch } : {}),
            files: [...new Set(peerList.flatMap(peer => peer.files))].sort(),
            peers: peerList
        };
    }
    return result;
}

/**
 * Returns a short hash of the overlap: the peers and their shared files. The same overlap always gives the same hash.
 * A new file or a new peer gives a new hash. The order of the lists does not change the hash.
 */
export function overlapHash(overlap: Pick<WorktreeOverlap, 'peers'>): string {
    const text = overlap.peers
        .map(peer => `${peer.path}\n${[...peer.files].sort().join('\n')}`)
        .sort()
        .join('\0');
    // FNV-1a, 32 bits.
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/** Returns the text of the overlap chip, for example "Also changed in feat-a" or "Also changed in feat-a and 2 more". */
export function overlapChipText(overlap: Pick<WorktreeOverlap, 'peers'>): string {
    const [first, ...rest] = overlap.peers;
    if (!first) return '';
    return rest.length > 0 ? `Also changed in ${worktreeName(first)} and ${rest.length} more` : `Also changed in ${worktreeName(first)}`;
}

/** Returns the text of a tooltip: one line for each peer with its files. A peer shows at most `maxFiles` files. */
export function overlapTooltip(overlap: Pick<WorktreeOverlap, 'peers'>, maxFiles = 12): string {
    return overlap.peers
        .map(peer => {
            const shown = peer.files.slice(0, maxFiles);
            const more = peer.files.length - shown.length;
            return `${worktreeName(peer)}:\n${shown.map(file => `  ${file}`).join('\n')}${more > 0 ? `\n  and ${more} more` : ''}`;
        })
        .join('\n');
}
