import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { BranchSummary, RepoRef } from '@shared/github';
import type { ViewRoute } from '@shared/nav-history';
import type { ProjectsState, PullRepoTarget } from '@shared/projects';
import type { SplitGroups } from '@shared/panes';
import type { Worktree } from '@shared/worktrees';
import { confirmDialog } from '../components/ConfirmDialog';
import { pruneLayout, readLayout, writeLayout } from '../layout-store';
import { keepOpenFileTabs, type TabKey } from './tabs';
import { startView, viewAfterProjectSwitch, viewToSave, type ContentView, type MainView } from './views';
import { errorText } from './worktree-edits';
import { editorPositions } from '../editor/editor-positions';
import { keyRoots, queryClient } from '../query-client';
import { branchSummariesQuery, summariesByRepo } from '../github/use-branch-status';

const api = window.shipwarden;

interface Options {
    selectedPath: string | undefined;
    setSelectedPath: Dispatch<SetStateAction<string | undefined>>;
    mainView: MainView;
    setMainView: Dispatch<SetStateAction<MainView>>;
    viewBeforeSettings: MutableRefObject<ContentView>;
    /** The page and the query of each view. The project layout saves the route of the main view and restores it at the start. */
    routes: Partial<Record<MainView, ViewRoute>>;
    setRoute: (view: MainView, route: ViewRoute) => void;
    /** The tabs of each worktree. The project layout saves them and restores them. */
    openFiles: Record<string, string[]>;
    setOpenFiles: Dispatch<SetStateAction<Record<string, string[]>>>;
    activeTabs: Record<string, TabKey>;
    setActiveTabs: Dispatch<SetStateAction<Record<string, TabKey>>>;
    panes: Record<string, SplitGroups>;
    setPanes: Dispatch<SetStateAction<Record<string, SplitGroups>>>;
    /** The IDs of the terminal sessions that run now. */
    sessionIds: () => string[];
    repoLabel: (repo: string) => string;
    setError: (error: string | undefined) => void;
}

/**
 * The projects, the worktrees of their repositories and the pull request state of each branch.
 * Each project has a saved layout of its tabs. A project switch restores that layout.
 */
export function useProjects(options: Options) {
    const { selectedPath, setSelectedPath, mainView, setMainView, viewBeforeSettings, setError } = options;
    /** The projects. The sidebar shows the repositories of the active project. */
    const [projects, setProjects] = useState<ProjectsState>();
    const activeProject = projects?.projects.find(project => project.id === projects.activeId);
    const repos = useMemo(() => activeProject?.repos ?? [], [activeProject]);
    /** The repositories of all projects, in sidebar order. The Review view shows their GitHub repositories first. */
    const allRepos = useMemo(() => [...new Set(projects?.projects.flatMap(project => project.repos) ?? [])], [projects]);
    /** The worktrees of each repository, by the root of its main worktree. */
    const [worktreesByRepo, setWorktreesByRepo] = useState<Record<string, Worktree[]>>({});
    /** All worktrees of the active project. */
    const worktrees = useMemo(() => repos.flatMap(repo => worktreesByRepo[repo] ?? []), [repos, worktreesByRepo]);
    /** True until the first project shows. The first restore shows the saved view and its page, as the user left them. */
    const firstRestore = useRef(true);

    // The ref holds the newest label function. The stable callback below then shows the newest repository name.
    const repoLabelRef = useRef(options.repoLabel);
    repoLabelRef.current = options.repoLabel;
    /** Loads the worktrees of one repository. Returns an empty list when the repository cannot be read. */
    const refreshWorktrees = useCallback(
        async (repo: string): Promise<Worktree[]> => {
            try {
                const list = await api.worktrees.list(repo);
                setWorktreesByRepo(map => ({ ...map, [repo]: list }));
                // The Review view reads the list from the cache. It then shows the worktree of a pull request.
                queryClient.setQueryData([...keyRoots.worktrees, repo], list);
                return list;
            } catch (err) {
                setWorktreesByRepo(map => ({ ...map, [repo]: [] }));
                setError(`${repoLabelRef.current(repo)}: ${errorText(err)}`);
                return [];
            }
        },
        [setError]
    );

    /** Loads the worktrees of all repositories of a project. Returns all of them, in sidebar order. */
    const refreshAll = useCallback(async (repoList: readonly string[]) => (await Promise.all(repoList.map(refreshWorktrees))).flat(), [refreshWorktrees]);

    /** The layout key of the project whose saved layout is restored. Until then, the layout is not saved. */
    const restoredKey = useRef<string>(undefined);

    const { setOpenFiles, setActiveTabs, setPanes } = options;
    // The ref holds the newest route setter, so the stable restore callback does not change on each render.
    const setRouteRef = useRef(options.setRoute);
    setRouteRef.current = options.setRoute;
    /**
     * Opens the saved tabs of a project again. A file that does not exist now does not get a tab.
     * Terminal sessions that are still running keep their active tab.
     * `fallbackKey` is the key of an older layout (one repository) that a project without its own layout uses.
     * At the start, the saved view and its page show (see startView). After a project switch, the main view stays,
     * except the graph page (see viewAfterProjectSwitch). With `keepView`, the main view does not change at all.
     */
    const restoreLayout = useCallback(
        async (key: string, list: Worktree[], sessionIds: string[], fallbackKey?: string, keepView = false) => {
            restoredKey.current = undefined;
            let stored = readLayout(key);
            if (!stored.selectedPath && Object.keys(stored.openFiles).length === 0 && fallbackKey) {
                stored = readLayout(fallbackKey);
            }
            const saved = pruneLayout(
                stored,
                list.map(worktree => worktree.path),
                sessionIds
            );
            const openFiles: Record<string, string[]> = {};
            await Promise.all(
                Object.entries(saved.openFiles).map(async ([root, files]) => {
                    // info and not read: an image or a PDF is not text, but its tab must stay.
                    const exists = await Promise.all(
                        files.map(file =>
                            api.files.info(root, file).then(
                                () => true,
                                () => false
                            )
                        )
                    );
                    const kept = files.filter((_file, index) => exists[index]);
                    if (kept.length > 0) {
                        openFiles[root] = kept;
                    }
                })
            );
            const activeTabs = keepOpenFileTabs(saved.activeTabs, openFiles);
            // The cursor positions of files that did not open again are not necessary.
            editorPositions.prune(
                list.map(worktree => worktree.path),
                openFiles
            );
            // Merge, so that the documents of another repository keep their tabs and can close normally.
            setOpenFiles(map => ({ ...map, ...openFiles }));
            setActiveTabs(map => ({ ...map, ...activeTabs }));
            setPanes(map => ({ ...map, ...saved.panes }));
            const path = saved.selectedPath ?? list[0]?.path;
            setSelectedPath(path);
            if (firstRestore.current) {
                firstRestore.current = false;
                const view = startView(saved.mainView, path);
                if (view === saved.mainView && saved.route) setRouteRef.current(view, saved.route);
                setMainView(view);
            } else if (!keepView) {
                setMainView(viewAfterProjectSwitch);
            }
            restoredKey.current = key;
        },
        [setOpenFiles, setActiveTabs, setPanes, setSelectedPath, setMainView]
    );

    /** Loads the worktrees of the active project and opens its saved tabs. With `keepView`, the main view does not change. */
    const showProject = useCallback(
        async (state: ProjectsState, sessionIds: string[], keepView = false) => {
            const project = state.projects.find(item => item.id === state.activeId);
            if (!project) {
                return;
            }
            restoredKey.current = undefined;
            const list = await refreshAll(project.repos);
            await restoreLayout(`project:${project.id}`, list, sessionIds, project.repos[0], keepView);
        },
        [refreshAll, restoreLayout]
    );

    const { openFiles, activeTabs, panes, routes } = options;
    const layoutKey = activeProject ? `project:${activeProject.id}` : undefined;
    // Save the layout of the project after each change. The first save comes after the restore, so that it does not remove the saved layout.
    // biome-ignore lint/correctness/useExhaustiveDependencies: viewBeforeSettings is a ref. A change of its value must not save the layout.
    useEffect(() => {
        if (layoutKey && restoredKey.current === layoutKey) {
            const view = viewToSave(mainView, viewBeforeSettings.current);
            writeLayout(layoutKey, { selectedPath, mainView: view, route: routes[view], openFiles, activeTabs, panes });
        }
    }, [layoutKey, selectedPath, mainView, routes, openFiles, activeTabs, panes]);

    // An agent or a terminal can also add worktrees, so the lists load again when the window gets focus.
    const repoKey = repos.join('\0');
    useEffect(() => {
        const repoList = repoKey ? repoKey.split('\0') : [];
        const loadWorktrees = () => refreshAll(repoList);
        window.addEventListener('focus', loadWorktrees);
        return () => window.removeEventListener('focus', loadWorktrees);
    }, [repoKey, refreshAll]);

    /**
     * The open pull request of each branch, with its CI state, by repository. One request covers all worktrees of a
     * repository. The query loads again each minute, and when the window gets focus after that time.
     */
    const combineSummaries = useCallback((results: UseQueryResult<Record<string, BranchSummary>>[]) => summariesByRepo(repos, results), [repos]);
    const summaries = useQueries({ queries: repos.map(branchSummariesQuery), combine: combineSummaries });

    /** The repository of the selected worktree. */
    const selectedRepo = repos.find(repo => worktreesByRepo[repo]?.some(worktree => worktree.path === selectedPath));
    /** Returns the repository of a worktree in the active project. */
    const repoOfWorktree = (path: string) => repos.find(repo => worktreesByRepo[repo]?.some(worktree => worktree.path === path));

    /** Shows a folder dialog and adds the repository to the active project. */
    const addRepo = async () => {
        if (!activeProject) {
            return;
        }
        try {
            const state = await api.projects.chooseRepo(activeProject.id);
            const added = (state.projects.find(project => project.id === state.activeId)?.repos ?? []).filter(repo => !repos.includes(repo));
            setProjects(state);
            const list = await refreshAll(added);
            if (!selectedPath && list[0]) {
                setSelectedPath(list[0].path);
            }
        } catch (err) {
            setError(errorText(err));
        }
    };

    /**
     * Adds a GitHub repository to a project, with a clone when no project has one. That project becomes active, and
     * the main view stays the same. The clone goes into the code folder. Resolves false when the main process adds no
     * repository. Throws the error of a failed pull.
     */
    const pullRepo = async (repo: RepoRef, target: PullRepoTarget): Promise<boolean> => {
        const result = await api.projects.pullRepo(repo, target);
        if (!result) {
            return false;
        }
        const switched = result.state.activeId !== projects?.activeId;
        setProjects(result.state);
        if (switched) {
            // The user stays in the view of the pull request.
            await showProject(result.state, options.sessionIds(), true);
        } else {
            await refreshWorktrees(result.repo);
        }
        return true;
    };

    /** Removes a repository from the active project. Its files, worktrees and terminal sessions stay. */
    const removeRepo = async (repo: string) => {
        if (
            !activeProject ||
            !(await confirmDialog({
                title: `Remove "${options.repoLabel(repo)}" from the project "${activeProject.name}"?`,
                message: 'The repository and its worktrees stay on disk. Agents in its worktrees continue to run.',
                confirmLabel: 'Remove'
            }))
        ) {
            return;
        }
        try {
            const state = await api.projects.removeRepo(activeProject.id, repo);
            setProjects(state);
            if (selectedRepo === repo) {
                const rest = (state.projects.find(project => project.id === state.activeId)?.repos ?? []).flatMap(item => worktreesByRepo[item] ?? []);
                setSelectedPath(rest[0]?.path);
            }
        } catch (err) {
            setError(errorText(err));
        }
    };

    /** Shows another project: its repositories, worktrees and saved tabs. With `keepView`, the main view does not change. */
    const switchProject = async (id: string, keepView = false) => {
        try {
            const state = await api.projects.setActive(id);
            setProjects(state);
            setMainView(view => (view === 'settings' ? viewBeforeSettings.current : view));
            await showProject(state, options.sessionIds(), keepView);
        } catch (err) {
            setError(errorText(err));
        }
    };

    /** Runs a project change from the sidebar. A rejected change throws, so the sidebar can show the error. */
    const changeProjects = async (change: Promise<ProjectsState>) => {
        const state = await change;
        const switched = state.activeId !== projects?.activeId;
        setProjects(state);
        if (switched) {
            await showProject(state, options.sessionIds());
        }
    };

    /** Moves a project to another place in the project list. */
    const moveProject = (id: string, toIndex: number) => {
        api.projects.move(id, toIndex).then(setProjects, err => setError(errorText(err)));
    };

    /** Moves a repository of the active project to another place in the sidebar. */
    const moveRepo = (repo: string, toIndex: number) => {
        if (activeProject) {
            api.projects.moveRepo(activeProject.id, repo, toIndex).then(setProjects, err => setError(errorText(err)));
        }
    };

    return {
        projects,
        setProjects,
        activeProject,
        repos,
        allRepos,
        worktreesByRepo,
        worktrees,
        summaries,
        selectedRepo,
        repoOfWorktree,
        refreshWorktrees,
        showProject,
        addRepo,
        pullRepo,
        removeRepo,
        switchProject,
        changeProjects,
        moveProject,
        moveRepo
    };
}
