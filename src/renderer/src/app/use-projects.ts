import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { BranchSummary } from '@shared/github';
import type { ProjectsState } from '@shared/projects';
import type { SplitGroups } from '@shared/panes';
import type { Worktree } from '@shared/worktrees';
import { confirmDialog } from '../components/ConfirmDialog';
import { pruneLayout, readLayout, writeLayout } from '../layout-store';
import { keepOpenFileTabs, type TabKey } from './tabs';
import { viewToSave, type ContentView, type MainView } from './views';
import { errorText } from './worktree-edits';
import { editorPositions } from '../editor/editor-positions';

const api = window.shipwarden;

interface Options {
    selectedPath: string | undefined;
    setSelectedPath: Dispatch<SetStateAction<string | undefined>>;
    mainView: MainView;
    setMainView: Dispatch<SetStateAction<MainView>>;
    viewBeforeSettings: MutableRefObject<ContentView>;
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
    /** The open pull request of each branch, with its CI state, by repository. */
    const [summaries, setSummaries] = useState<Record<string, Record<string, BranchSummary>>>({});
    /** True until the first project shows. The first restore keeps the start view (the Dashboard). */
    const firstRestore = useRef(true);

    // React creates the callback below one time. The callback keeps the label function of the first render.
    const { repoLabel } = options;
    /** Loads the worktrees of one repository. Returns an empty list when the repository cannot be read. */
    const refreshWorktrees = useCallback(async (repo: string): Promise<Worktree[]> => {
        try {
            const list = await api.worktrees.list(repo);
            setWorktreesByRepo(map => ({ ...map, [repo]: list }));
            return list;
        } catch (err) {
            setWorktreesByRepo(map => ({ ...map, [repo]: [] }));
            setError(`${repoLabel(repo)}: ${errorText(err)}`);
            return [];
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** Loads the worktrees of all repositories of a project. Returns all of them, in sidebar order. */
    const refreshAll = useCallback(async (repoList: readonly string[]) => (await Promise.all(repoList.map(refreshWorktrees))).flat(), [refreshWorktrees]);

    /** The layout key of the project whose saved layout is restored. Until then, the layout is not saved. */
    const restoredKey = useRef<string>(undefined);

    const { setOpenFiles, setActiveTabs, setPanes } = options;
    /**
     * Opens the saved tabs of a project again. A file that does not exist now does not get a tab.
     * Terminal sessions that are still running keep their active tab.
     * `fallbackKey` is the key of an older layout (one repository) that a project without its own layout uses.
     */
    const restoreLayout = useCallback(async (key: string, list: Worktree[], sessionIds: string[], fallbackKey?: string) => {
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
        setSelectedPath(saved.selectedPath ?? list[0]?.path);
        if (firstRestore.current) {
            firstRestore.current = false;
        } else {
            setMainView(saved.mainView ?? 'worktree');
        }
        restoredKey.current = key;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** Loads the worktrees of the active project and opens its saved tabs. */
    const showProject = useCallback(
        async (state: ProjectsState, sessionIds: string[]) => {
            const project = state.projects.find(item => item.id === state.activeId);
            if (!project) {
                return;
            }
            restoredKey.current = undefined;
            const list = await refreshAll(project.repos);
            await restoreLayout(`project:${project.id}`, list, sessionIds, project.repos[0]);
        },
        [refreshAll, restoreLayout]
    );

    const { openFiles, activeTabs, panes } = options;
    const layoutKey = activeProject ? `project:${activeProject.id}` : undefined;
    // Save the layout of the project after each change. The first save comes after the restore, so that it does not remove the saved layout.
    useEffect(() => {
        if (layoutKey && restoredKey.current === layoutKey) {
            writeLayout(layoutKey, { selectedPath, mainView: viewToSave(mainView, viewBeforeSettings.current), openFiles, activeTabs, panes });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutKey, selectedPath, mainView, openFiles, activeTabs, panes]);

    // The PR and CI state of each branch for the worktree list. One request covers all worktrees of a repository.
    const repoKey = repos.join('\0');
    useEffect(() => {
        const repoList = repoKey ? repoKey.split('\0') : [];
        const load = () =>
            repoList.forEach(repo => {
                api.github.branchSummaries(repo).then(
                    result => setSummaries(map => ({ ...map, [repo]: result })),
                    () => undefined
                );
            });
        // An agent or a terminal can also add worktrees, so the lists load again when the window gets focus.
        const loadWorktrees = () => refreshAll(repoList);
        window.addEventListener('focus', loadWorktrees);
        load();
        const timer = setInterval(load, 60_000);
        window.addEventListener('focus', load);
        return () => {
            clearInterval(timer);
            window.removeEventListener('focus', load);
            window.removeEventListener('focus', loadWorktrees);
        };
    }, [repoKey, refreshAll]);

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

    /** Shows another project: its repositories, worktrees and saved tabs. */
    const switchProject = async (id: string) => {
        try {
            const state = await api.projects.setActive(id);
            setProjects(state);
            setMainView(view => (view === 'settings' ? viewBeforeSettings.current : view));
            await showProject(state, options.sessionIds());
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
        removeRepo,
        switchProject,
        changeProjects,
        moveProject,
        moveRepo
    };
}
