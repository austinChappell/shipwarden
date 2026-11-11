import { describe, expect, it } from 'vitest';
import { startAgentAction } from './empty-states';

describe('startAgentAction', () => {
    it('shows the selected worktree', () => {
        expect(startAgentAction('/repo/wt', 1)).toBe('worktree');
    });

    it('opens the New worktree dialog when no worktree is selected', () => {
        expect(startAgentAction(undefined, 2)).toBe('newWorktree');
    });

    it('adds a repository first when the project has none', () => {
        expect(startAgentAction(undefined, 0)).toBe('addRepo');
    });
});
