/**
 * A project is a named set of repositories. The sidebar shows the repositories of the active project only.
 * A repository can be in more than one project. Projects never change files on disk.
 */
export interface Project {
    id: string;
    name: string;
    /** The root folders of the main worktrees of the repositories, in sidebar order. */
    repos: string[];
}

export interface ProjectsState {
    projects: Project[];
    activeId: string;
}

/** The project that gets a repository from the Review view: a project that exists, or a new project with this name. */
export type PullRepoTarget = { projectId: string } | { newProjectName: string };

/** The result of a pull of a repository into a project. */
export interface PullRepoResult {
    state: ProjectsState;
    /** The root folder of the main worktree of the repository. */
    repo: string;
}

const MAX_NAME_LENGTH = 80;

/** Removes extra spaces from a project name. Throws an error when the name is empty or too long. */
export function cleanProjectName(name: string): string {
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) {
        throw new Error('Type a name for the project.');
    }
    if (clean.length > MAX_NAME_LENGTH) {
        throw new Error(`A project name can have ${MAX_NAME_LENGTH} characters or fewer.`);
    }
    return clean;
}

/** Converts stored JSON to a valid state. There is always at least one project, and the active ID is valid. */
export function normalizeProjects(value: unknown, newId: () => string): ProjectsState {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const projects: Project[] = [];
    if (Array.isArray(raw.projects)) {
        for (const item of raw.projects) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const project = item as Record<string, unknown>;
            if (typeof project.id !== 'string' || !project.id || projects.some(existing => existing.id === project.id)) {
                continue;
            }
            const name = typeof project.name === 'string' && project.name.trim() ? project.name.trim() : 'Untitled';
            const repos = Array.isArray(project.repos) ? project.repos.filter((repo): repo is string => typeof repo === 'string' && repo.startsWith('/')) : [];
            projects.push({ id: project.id, name, repos: [...new Set(repos)] });
        }
    }
    if (projects.length === 0) {
        projects.push({ id: newId(), name: 'Default', repos: [] });
    }
    const activeId = typeof raw.activeId === 'string' && projects.some(project => project.id === raw.activeId) ? raw.activeId : projects[0].id;
    return { projects, activeId };
}

function findProject(state: ProjectsState, id: string): Project {
    const project = state.projects.find(item => item.id === id);
    if (!project) {
        throw new Error('The project does not exist. It was possibly deleted.');
    }
    return project;
}

function replaceProject(state: ProjectsState, project: Project): ProjectsState {
    return { ...state, projects: state.projects.map(item => (item.id === project.id ? project : item)) };
}

/** Adds a project and makes it active. */
export function createProject(state: ProjectsState, id: string, name: string): ProjectsState {
    return { projects: [...state.projects, { id, name: cleanProjectName(name), repos: [] }], activeId: id };
}

export function renameProject(state: ProjectsState, id: string, name: string): ProjectsState {
    return replaceProject(state, { ...findProject(state, id), name: cleanProjectName(name) });
}

/** Removes a project. The last project cannot be removed. When the active project is removed, the first other project becomes active. */
export function deleteProject(state: ProjectsState, id: string): ProjectsState {
    findProject(state, id);
    if (state.projects.length === 1) {
        throw new Error('ShipWarden needs at least one project. Create another project first.');
    }
    const projects = state.projects.filter(project => project.id !== id);
    return { projects, activeId: state.activeId === id ? projects[0].id : state.activeId };
}

export function setActiveProject(state: ProjectsState, id: string): ProjectsState {
    return { ...state, activeId: findProject(state, id).id };
}

/** Adds a repository to the end of a project. A repository that is already in the project stays in its position. */
export function addRepo(state: ProjectsState, id: string, repo: string): ProjectsState {
    const project = findProject(state, id);
    return project.repos.includes(repo) ? state : replaceProject(state, { ...project, repos: [...project.repos, repo] });
}

/** Removes a repository from a project. The repository and its worktrees stay on disk. */
export function removeRepo(state: ProjectsState, id: string, repo: string): ProjectsState {
    const project = findProject(state, id);
    return replaceProject(state, { ...project, repos: project.repos.filter(item => item !== repo) });
}

/** Returns a copy of the list with the item at `from` moved to `to`. An index outside the list goes to the nearest end. */
function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
    const result = [...items];
    const [item] = result.splice(from, 1);
    result.splice(Math.max(0, Math.min(to, result.length)), 0, item);
    return result;
}

/** Moves a project to a new position in the project list. */
export function moveProject(state: ProjectsState, id: string, toIndex: number): ProjectsState {
    findProject(state, id);
    const from = state.projects.findIndex(project => project.id === id);
    return { ...state, projects: moveItem(state.projects, from, toIndex) };
}

/** Moves a repository to a new position in a project. Throws an error when the repository is not in the project. */
export function moveRepo(state: ProjectsState, id: string, repo: string, toIndex: number): ProjectsState {
    const project = findProject(state, id);
    const from = project.repos.indexOf(repo);
    if (from === -1) {
        throw new Error('The repository is not in the project. It was possibly removed.');
    }
    return replaceProject(state, { ...project, repos: moveItem(project.repos, from, toIndex) });
}

/** Returns the name of a repository: the name of its folder. */
export function repoName(repo: string): string {
    return repo.split('/').filter(Boolean).pop() ?? repo;
}
