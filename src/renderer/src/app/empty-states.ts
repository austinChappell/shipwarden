/**
 * The action of "Start agent" in the Agents view (the header and the empty state):
 * - worktree: show the selected worktree, where the Agent button is.
 * - newWorktree: open the New worktree dialog for the first repository.
 * - addRepo: the project has no repositories, so add one first.
 */
export type StartAgentAction = 'worktree' | 'newWorktree' | 'addRepo';

export function startAgentAction(selectedWorktree: string | undefined, repoCount: number): StartAgentAction {
    if (selectedWorktree) return 'worktree';
    return repoCount > 0 ? 'newWorktree' : 'addRepo';
}
