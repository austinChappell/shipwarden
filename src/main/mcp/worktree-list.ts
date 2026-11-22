import type { RemoteSnapshot } from '@shared/remote';
import type { McpWorktree } from './tools';

/**
 * Returns the worktrees for list_worktrees from the phone snapshot. The snapshot has the worktrees, the task links,
 * the pull requests, and the agents. Without `all`, only the repository of the caller counts. A repository in two
 * projects shows one time.
 */
export function worktreesFromSnapshot(snapshot: Pick<RemoteSnapshot, 'projects' | 'agents'>, caller: string, all: boolean): McpWorktree[] {
    const repos = new Map(snapshot.projects.flatMap(project => project.repos).map(repo => [repo.path, repo]));
    const selected = all ? [...repos.values()] : [...repos.values()].filter(repo => repo.worktrees.some(worktree => worktree.path === caller));
    return selected.flatMap(repo =>
        repo.worktrees.map(worktree => ({
            path: worktree.path,
            ...(worktree.branch ? { branch: worktree.branch } : {}),
            name: worktree.name,
            repo: repo.path,
            isMain: worktree.isMain,
            ...(worktree.task ? { task: worktree.task } : {}),
            ...(worktree.pullRequest
                ? {
                      pullRequest: {
                          number: worktree.pullRequest.number,
                          ...(worktree.pullRequest.title ? { title: worktree.pullRequest.title } : {}),
                          url: worktree.pullRequest.url,
                          isDraft: worktree.pullRequest.isDraft,
                          reviewDecision: worktree.pullRequest.reviewDecision,
                          checks: worktree.pullRequest.checks
                      }
                  }
                : {}),
            agents: snapshot.agents
                .filter(agent => !agent.exited && agent.worktreePath === worktree.path)
                .map(agent => ({
                    title: agent.title,
                    ...(agent.state ? { state: agent.state } : {}),
                    ...(agent.reason ? { message: agent.reason } : agent.message ? { message: agent.message } : {})
                }))
        }))
    );
}
