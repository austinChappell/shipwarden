import { basename } from 'path';
import type { BranchSummary } from '@shared/github';
import type { ProjectsState } from '@shared/projects';
import type { RemoteAgent, RemoteProject, RemoteSnapshot } from '@shared/remote';
import { REPO_COLORS, repoDisplayName, type AppSettings } from '@shared/settings';
import type { TaskLink } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';

/** The pull request summaries of a repository stay for this time, because each load is a GitHub request. */
const PULL_REQUEST_TTL_MS = 60_000;

export interface SnapshotSources {
    projects(): Promise<ProjectsState>;
    worktrees(repo: string): Promise<Worktree[]>;
    settings(): Promise<AppSettings>;
    taskLinks(): Promise<Record<string, TaskLink>>;
    /** The open pull requests of a repository, by branch. */
    pullRequests(repo: string): Promise<Record<string, BranchSummary>>;
    sessions(): Promise<TerminalSession[]>;
}

export function agentOf(session: TerminalSession): RemoteAgent {
    return {
        id: session.id,
        title: session.title,
        worktreePath: session.worktreePath,
        cwd: session.cwd,
        state: session.agentState,
        message: session.agentMessage,
        prompt: session.agentPrompt,
        stateAt: session.agentStateAt,
        exited: session.exited
    };
}

/**
 * Makes the data of the phone's start screen: the projects with their repositories and worktrees, and the agents.
 * A repository that fails (for example a deleted folder) shows with no worktrees. GitHub errors show no pull requests.
 */
export class RemoteSnapshotBuilder {
    private readonly pullRequestCache = new Map<string, { at: number; value: Record<string, BranchSummary> }>();

    constructor(private readonly sources: SnapshotSources, private readonly now: () => number = Date.now) {}

    async build(): Promise<Omit<RemoteSnapshot, 'protocol' | 'mac'>> {
        const [state, settings, links, sessions] = await Promise.all([
            this.sources.projects(),
            this.sources.settings(),
            this.sources.taskLinks().catch(() => ({} as Record<string, TaskLink>)),
            this.sources.sessions().catch(() => [] as TerminalSession[])
        ]);
        const repoPaths = [...new Set(state.projects.flatMap(project => project.repos))];
        const repos = new Map(await Promise.all(repoPaths.map(async repo => {
            const [worktrees, pullRequests] = await Promise.all([
                this.sources.worktrees(repo).catch(() => [] as Worktree[]),
                this.pullRequests(repo)
            ]);
            const color = settings.repos[repo]?.color;
            return [repo, {
                path: repo,
                name: repoDisplayName(settings, repo),
                ...(color ? { color: REPO_COLORS[color] } : {}),
                worktrees: worktrees.filter(worktree => !worktree.isBare).map(worktree => {
                    const link = links[worktree.path];
                    const pr = worktree.branch ? pullRequests[worktree.branch] : undefined;
                    return {
                        path: worktree.path,
                        branch: worktree.branch,
                        name: settings.worktreeNames?.[worktree.path] ?? worktree.branch ?? basename(worktree.path),
                        isMain: worktree.isMain,
                        ...(link ? { task: { title: link.title, key: link.key, url: link.url } } : {}),
                        ...(pr ? {
                            pullRequest: {
                                number: pr.number,
                                title: pr.title,
                                url: pr.url,
                                isDraft: pr.isDraft,
                                reviewDecision: pr.reviewDecision,
                                checks: pr.checks,
                                headSha: pr.headSha
                            }
                        } : {})
                    };
                })
            }] as const;
        })));
        const projects: RemoteProject[] = state.projects.map(project => ({
            id: project.id,
            name: project.name,
            repos: project.repos.map(repo => repos.get(repo)).filter(repo => !!repo).map(repo => ({ ...repo, worktrees: [...repo.worktrees] }))
        }));
        return { projects, agents: sessions.filter(session => session.isAgent).map(agentOf) };
    }

    /** Forgets the pull requests of a repository, for example after an approval. */
    invalidate(repo?: string): void {
        if (repo) this.pullRequestCache.delete(repo);
        else this.pullRequestCache.clear();
    }

    private async pullRequests(repo: string): Promise<Record<string, BranchSummary>> {
        const cached = this.pullRequestCache.get(repo);
        if (cached && this.now() - cached.at < PULL_REQUEST_TTL_MS) return cached.value;
        try {
            const value = await this.sources.pullRequests(repo);
            this.pullRequestCache.set(repo, { at: this.now(), value });
            return value;
        } catch {
            // Without GitHub (no login, no network), the worktrees show without pull requests. Keep old data when it exists.
            return cached?.value ?? {};
        }
    }
}
