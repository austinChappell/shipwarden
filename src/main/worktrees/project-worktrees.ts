import path from 'node:path';
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

    /**
     * Returns the worktree that contains a file, and the absolute path of the file. `root` is the folder of the file
     * view, and `file` is relative to it. When `root` is not a worktree, for example the home folder of the Terminal
     * view, the result is the deepest worktree of a project that contains the file. Else it throws an error.
     */
    async locate(root: unknown, file: unknown): Promise<{ worktree: string; absolute: string }> {
        const folder = String(root);
        const absolute = path.resolve(folder, String(file));
        const inside = (parent: string) => {
            const relative = path.relative(parent, absolute);
            return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        };
        const checked = await this.check(folder).catch(() => undefined);
        if (checked) {
            if (!inside(checked)) throw new Error(`The path "${String(file)}" is outside the worktree.`);
            return { worktree: checked, absolute };
        }
        for (const repo of await this.options.projectRepos()) {
            (await this.options.worktreePaths(repo).catch((): string[] => [])).forEach(known => this.known.add(known));
        }
        const worktree = [...this.known].filter(inside).sort((a, b) => b.length - a.length)[0];
        if (!worktree) throw new Error(`"${absolute}" is not in a worktree of a project.`);
        return { worktree, absolute };
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
