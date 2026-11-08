import { Worktree } from '@shared/worktrees';

const BRANCH_PREFIX = 'refs/heads/';

/**
 * Parses the output of `git worktree list --porcelain`.
 * Git writes one block for each worktree. A blank line separates the blocks.
 * The first block is the main worktree.
 */
export function parseWorktreePorcelain(output: string): Worktree[] {
    const worktrees: Worktree[] = [];
    const blocks = output.split(/\r?\n\r?\n/).map(block => block.trim()).filter(block => block.length > 0);
    for (const block of blocks) {
        const worktree: Worktree = {
            path: '',
            head: '',
            isMain: worktrees.length === 0,
            isBare: false,
            locked: false,
            prunable: false
        };
        for (const line of block.split(/\r?\n/)) {
            const space = line.indexOf(' ');
            const key = space === -1 ? line : line.slice(0, space);
            const value = space === -1 ? '' : line.slice(space + 1);
            switch (key) {
                case 'worktree':
                    worktree.path = value;
                    break;
                case 'HEAD':
                    worktree.head = value;
                    break;
                case 'branch':
                    worktree.branch = value.startsWith(BRANCH_PREFIX) ? value.slice(BRANCH_PREFIX.length) : value;
                    break;
                case 'bare':
                    worktree.isBare = true;
                    break;
                case 'locked':
                    worktree.locked = true;
                    break;
                case 'prunable':
                    worktree.prunable = true;
                    break;
            }
        }
        if (worktree.path) {
            worktrees.push(worktree);
        }
    }
    return worktrees;
}

/**
 * Converts a branch name to a folder name.
 * Example: `feature/login` becomes `feature-login`.
 */
export function branchToFolderName(branch: string): string {
    const name = branch
        .replace(/[\/\\]+/g, '-')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    return name || 'worktree';
}
