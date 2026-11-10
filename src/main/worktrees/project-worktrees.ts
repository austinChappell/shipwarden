import type { RepoRef } from '@shared/github';
import { sameRepo } from '../ipc/args';

/** The parts that `ProjectWorktrees` needs. */
export interface ProjectWorktreesOptions {
    /** Returns the repositories of all projects. A repository can be in more than one project. */
    projectRepos(): Promise<string[]>;
    /** Returns the worktree paths of a repository. */
    worktreePaths(repo: string): Promise<string[]>;
    /** Returns true for the copy of a pull request in the Review view. */
    isReviewCheckout(path: string): Promise<boolean>;
    /** Returns the GitHub or Azure Repos repository of the "origin" remote, or null. */
    repoFor(root: string): Promise<RepoRef | null>;
}

/**
 * Finds the worktrees and the repositories of the projects.
 * The renderer can name only a worktree of the projects, so git does not run in other folders.
 */
export class ProjectWorktrees {
    /** The known worktree paths. The service reads them again only for a path that is not in the list. */
    private readonly known = new Set<string>();

    constructor(private readonly options: ProjectWorktreesOptions) {}

    /** Returns the path when it is a worktree of a project. Else it throws an error. */
    async check(worktree: unknown): Promise<string> {
        const value = String(worktree);
        if (this.known.has(value)) return value;
        // The copy of a pull request in the Review view. It can be in a clone that is not a project.
        if (await this.options.isReviewCheckout(value)) return value;
        for (const repo of await this.options.projectRepos()) {
            (await this.options.worktreePaths(repo).catch((): string[] => [])).forEach(path => this.known.add(path));
        }
        if (this.known.has(value)) return value;
        throw new Error(`"${value}" is not a worktree of a project.`);
    }

    /** Returns the main worktree of a project repository whose "origin" remote is the repository. */
    async localClone(repo: RepoRef): Promise<string | undefined> {
        for (const root of new Set(await this.options.projectRepos())) {
            const ref = await this.options.repoFor(root).catch(() => null);
            if (ref && sameRepo(ref, repo)) {
                return root;
            }
        }
        return undefined;
    }

    /** Returns the project repository of a worktree, or undefined when no project has the worktree. */
    async repoOf(worktree: string): Promise<string | undefined> {
        for (const repo of new Set(await this.options.projectRepos())) {
            if ((await this.options.worktreePaths(repo).catch((): string[] => [])).includes(worktree)) return repo;
        }
        return undefined;
    }
}
