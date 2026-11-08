import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
    addRepo,
    createProject,
    deleteProject,
    normalizeProjects,
    removeRepo,
    renameProject,
    setActiveProject,
    type ProjectsState
} from '@shared/projects';
import { JsonStore } from './tasks/json-store';

/**
 * Keeps the projects and their repositories in `projects.json`.
 * At the first start, the repository of the old single-repository state (`state.json`) goes into the "Default" project.
 * The SHIPWARDEN_REPO environment variable adds its repository to the active project.
 */
export class ProjectStore {
    private readonly store: JsonStore<Partial<ProjectsState>>;
    private state: ProjectsState | undefined;

    constructor(private readonly file: string, private readonly legacyStateFile: string) {
        this.store = new JsonStore<Partial<ProjectsState>>(file, () => ({}));
    }

    async load(): Promise<ProjectsState> {
        let exists = true;
        try {
            await fs.access(this.file);
        } catch {
            exists = false;
        }
        let state = normalizeProjects(await this.store.get(), randomUUID);
        if (!exists) {
            const legacy = await readLegacyRepo(this.legacyStateFile);
            const root = legacy ? await mainWorktreeRoot(legacy) : undefined;
            if (root) {
                state = addRepo(state, state.activeId, root);
            }
        }
        const fromEnv = process.env.SHIPWARDEN_REPO ? await mainWorktreeRoot(process.env.SHIPWARDEN_REPO) : undefined;
        if (fromEnv) {
            state = addRepo(state, state.activeId, fromEnv);
        }
        return this.save(state);
    }

    async get(): Promise<ProjectsState> {
        return this.state ?? this.load();
    }

    async create(name: string): Promise<ProjectsState> {
        return this.save(createProject(await this.get(), randomUUID(), name));
    }

    async rename(id: string, name: string): Promise<ProjectsState> {
        return this.save(renameProject(await this.get(), id, name));
    }

    async delete(id: string): Promise<ProjectsState> {
        return this.save(deleteProject(await this.get(), id));
    }

    async setActive(id: string): Promise<ProjectsState> {
        return this.save(setActiveProject(await this.get(), id));
    }

    /** Adds the repository that contains the folder to a project. Throws an error when the folder is not in a git repository. */
    async addRepo(id: string, folder: string): Promise<ProjectsState> {
        const root = await mainWorktreeRoot(folder);
        if (!root) {
            throw new Error(`The folder "${folder}" is not in a git repository.`);
        }
        return this.save(addRepo(await this.get(), id, root));
    }

    async removeRepo(id: string, repo: string): Promise<ProjectsState> {
        return this.save(removeRepo(await this.get(), id, repo));
    }

    private async save(state: ProjectsState): Promise<ProjectsState> {
        this.state = state;
        await this.store.update(() => state);
        return state;
    }
}

async function readLegacyRepo(file: string): Promise<string | undefined> {
    try {
        const value = JSON.parse(await fs.readFile(file, 'utf8')) as { lastRepo?: unknown };
        return typeof value.lastRepo === 'string' ? value.lastRepo : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Returns the root folder of the main worktree of the repository that contains the folder.
 * Returns undefined when the folder is not in a git repository.
 */
export function mainWorktreeRoot(folder: string): Promise<string | undefined> {
    return new Promise(resolve => {
        // The common git directory is the .git folder of the main worktree, also when the folder is in a linked worktree.
        execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: folder }, (error, stdout) => {
            if (error) {
                resolve(undefined);
                return;
            }
            const commonDir = stdout.trim();
            resolve(path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir);
        });
    });
}
