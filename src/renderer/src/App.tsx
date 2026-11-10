import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ListTodo, PanelRight } from 'lucide-react';
import type { CheckRun, PullRequest, PullRequestFile } from '@shared/github';
import type { TaskLink } from '@shared/tasks';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { RightPanel } from './components/RightPanel';
import { requestExplorerFocus } from './files/explorer-focus';
import { dialogOpen } from './components/ConfirmDialog';
import { NewWorktreeDialog } from './components/NewWorktreeDialog';
import { GitGraphView } from './components/GitGraphView';
import { TasksView } from './components/TasksView';
import { Sidebar } from './components/Sidebar';
import { useBranchStatus } from './github/use-branch-status';
import { ResizeHandle, usePanelWidth } from './components/ResizeHandle';
import { SettingsView } from './components/SettingsView';
import { AgentsView } from './components/AgentsView';
import { NewTabMenu } from './components/NewTabMenu';
import { ReviewView, type ReviewOpenRequest } from './components/ReviewView';
import { DashboardView, type ReviewTabRequest } from './components/DashboardView';
import { NotesView } from './components/NotesView';
import { PipelinesView } from './components/PipelinesView';
import { ScriptsMenu } from './components/ScriptsMenu';
import { useDashboardCount, useDashboardLoader } from './dashboard-store';
import { useReviewOverviewLoader, useReviewQueue } from './github/review-overview-store';
import { githubScopeKey, useReviewProviders } from './review-providers-store';
import type { NotificationTarget } from '@shared/api';
import type { RepoRef } from '@shared/github';
import { useAppearance } from './theme/appearance';
import { StatusBar } from './components/StatusBar';
import { ErrorBanner } from './components/ErrorBanner';
import { agentForRepo, DEFAULT_SETTINGS, repoDisplayName, type AppSettings } from '@shared/settings';
import { leafOfTab, resizeSplit } from '@shared/panes';
import type { ShortcutAction, ViewAction } from '@shared/shortcuts';
import { lspBridge } from './lsp/bridge';
import { agentStateStore } from './terminal/agent-state-store';
import { sessionListStore } from './terminal/session-list-store';
import type { ChangeSide, FileChange } from '@shared/git';
import { SidebarContext, SidebarToggle } from './components/SidebarToggle';
import { requestSidebarFocus } from './sidebar-focus';
import { useBrowserStates } from './browser/browser-store';
import { openLink } from './links';
import { BLANK_PAGE } from '@shared/browser';
import { PaneTree } from './app/PaneTree';
import { TabStrip } from './app/TabStrip';
import { tabInfo } from './app/tab-info';
import { renderTabView } from './app/tab-view';
import type { TabKey } from './app/tabs';
import { useAgentActions } from './app/use-agent-actions';
import { useBrowserTabs } from './app/use-browser-tabs';
import { useNavHistory } from './app/use-nav-history';
import { useNotifications } from './app/use-notifications';
import { useProjects } from './app/use-projects';
import { useShortcuts } from './app/use-shortcuts';
import { useStoredFlag } from './app/use-stored-flag';
import { useTerminalColors } from './app/use-terminal-colors';
import { useWorkspaceTabs } from './app/use-workspace-tabs';
import { useWorktreeActions, type NewWorktreeTarget } from './app/use-worktree-actions';
import { isNavValid, navLocationOf, VIEW_OF_ACTION, type ContentView, type MainView } from './app/views';

/** The command that starts an agent. A setting will replace this value. */
const EXPLORER_STORAGE_KEY = 'shipwarden.explorerOpen';
const SIDEBAR_COLLAPSED_KEY = 'shipwarden.sidebarCollapsed';

const api = window.shipwarden;

/** The smallest width of the center area (tabs, terminal and editor) when the user drags a panel border. */
const MIN_WORKSPACE_WIDTH = 360;

/** Returns the width of a panel on the screen, or 0 when the panel is not shown. */
function renderedWidth(selector: string): number {
    return document.querySelector<HTMLElement>(selector)?.offsetWidth ?? 0;
}

export function App() {
    const [sessions, setSessions] = useState<TerminalSession[]>([]);
    // The note box in the editor is outside this React tree. It reads the sessions from the store.
    useEffect(() => sessionListStore.set(sessions), [sessions]);
    const [settings, setSettings] = useState<TerminalSettings>();
    const [selectedPath, setSelectedPath] = useState<string>();
    const [explorerOpen, toggleExplorer] = useStoredFlag(EXPLORER_STORAGE_KEY, true);
    const [sidebarCollapsed, toggleSidebar] = useStoredFlag(SIDEBAR_COLLAPSED_KEY, false);
    /** The center area shows the selected worktree or the task list of the repository. */
    /** The app starts on the Dashboard. A project switch restores the saved view of the project. */
    const [mainView, setMainView] = useState<MainView>('dashboard');
    /** The repository that the commit graph page shows. */
    const [graphRepo, setGraphRepo] = useState<string>();
    /** The task that the Tasks view opens next, for example from the task link of a worktree. */
    const [taskOpen, setTaskOpen] = useState<{ connectionId: string; taskId: string; nonce: number }>();
    /** The pull request that the Review view opens next, for example from the Dashboard. */
    const [reviewOpen, setReviewOpen] = useState<ReviewOpenRequest>();
    /** The view that the settings page goes back to when it closes. */
    const viewBeforeSettings = useRef<ContentView>('dashboard');
    const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
    /** False until the settings load. The appearance waits for them, so the start does not show the default theme. */
    const [settingsLoaded, setSettingsLoaded] = useState(false);
    const { mode, palette } = useAppearance(settingsLoaded ? appSettings.appearance : undefined);
    /** The task of each worktree, by worktree path. */
    const [links, setLinks] = useState<Record<string, TaskLink>>({});
    const [error, setError] = useState<string>();
    const sidebarWidth = usePanelWidth('shipwarden.width.sidebar', 260, 180, 480);
    const explorerWidth = usePanelWidth('shipwarden.width.explorer', 300, 220, 720);
    /** The section that the settings page opens on, for example the settings of one repository. */
    const [settingsSection, setSettingsSection] = useState<string>();
    /** A new hiding rule from a Dashboard comment, for Settings > Dashboard to fill in. */
    const [rulePrefill, setRulePrefill] = useState<{ author: string; text: string; nonce: number }>();
    /**
     * The New worktree dialog that ⌘N or the commit graph opened, with its repository. The commit graph also gives a
     * start point. Without a start point, the dialog starts from the default branch.
     */
    const [newWorktree, setNewWorktree] = useState<NewWorktreeTarget>();
    /** The name of a repository in the UI: its name from the repository settings, else its folder name. */
    const repoLabel = (repo: string) => repoDisplayName(appSettings, repo);

    const tabs = useWorkspaceTabs({ selectedPath, setSelectedPath, sessions, setSessions, setError });
    const { activeTab, layout, worktreeSessions, worktreeExtras, activate, openExtra, openFile } = tabs;
    const project = useProjects({
        selectedPath,
        setSelectedPath,
        mainView,
        setMainView,
        viewBeforeSettings,
        repoLabel,
        setError,
        openFiles: tabs.openFiles,
        setOpenFiles: tabs.setOpenFiles,
        activeTabs: tabs.activeTabs,
        setActiveTabs: tabs.setActiveTabs,
        panes: tabs.panes,
        setPanes: tabs.setPanes,
        sessionIds: () => sessions.map(session => session.id)
    });
    const { projects, activeProject, repos, worktreesByRepo, worktrees, selectedRepo, showProject } = project;
    const selected = worktrees.find(worktree => worktree.path === selectedPath);
    const agents = useAgentActions({ sessions, setSessions, appSettings, selectedPath, selected, repoOfWorktree: project.repoOfWorktree, activate, setError });
    const { startTerminal, sendToAgent } = agents;
    const worktreeActions = useWorktreeActions({
        appSettings,
        setAppSettings,
        activeProjectId: activeProject?.id,
        repos,
        worktreesByRepo,
        worktrees,
        refreshWorktrees: project.refreshWorktrees,
        sessions,
        setSessions,
        links,
        setLinks,
        openFiles: tabs.openFiles,
        setOpenFiles: tabs.setOpenFiles,
        setExtraTabs: tabs.setExtraTabs,
        selectedPath,
        setSelectedPath,
        setMainView,
        setNewWorktree,
        setTaskOpen,
        startTerminal,
        sendToAgent,
        prepareWorktree: agents.prepareWorktree,
        setError
    });
    const { openLinkedTask, removeWorktree } = worktreeActions;

    /** Shows the settings page, and keeps the view that it goes back to. */
    const showSettingsPage = () =>
        setMainView(view => {
            if (view !== 'settings') {
                viewBeforeSettings.current = view;
            }
            return 'settings';
        });
    const openSettings = (section?: string) => {
        setSettingsSection(section);
        showSettingsPage();
    };
    const closeSettings = useCallback(() => setMainView(viewBeforeSettings.current), []);
    /** Selects a worktree and shows the worktree view. */
    const showWorktree = (path: string) => {
        setSelectedPath(path);
        setMainView('worktree');
    };

    /**
     * Shows the tab of an agent from the Agents view. When the agent runs in another project, the sidebar switches
     * to that project first, so the worktree is in the list.
     */
    const openAgent = async (session: TerminalSession, projectId: string | undefined) => {
        if (projectId && projectId !== projects?.activeId) {
            await project.switchProject(projectId);
        }
        if (session.worktreePath) {
            setSelectedPath(session.worktreePath);
            activate(session.worktreePath, `t:${session.id}`);
        }
        setMainView('worktree');
    };

    const reviewProviders = useReviewProviders();
    const githubKey = githubScopeKey(reviewProviders);
    useDashboardLoader(settingsLoaded, githubKey, activeProject?.id);
    useReviewOverviewLoader(settingsLoaded, githubKey, project.allRepos);
    const reviewCount = useReviewQueue().length;
    const commentFilter = useMemo(
        () => ({ hiddenAuthors: appSettings.dashboardHiddenAuthors, hiddenRules: appSettings.dashboardHiddenRules }),
        [appSettings.dashboardHiddenAuthors, appSettings.dashboardHiddenRules]
    );
    const dashboardCount = useDashboardCount(commentFilter);
    /** Opens a pull request in the Review view. Without a GitHub provider, GitHub opens in the browser. */
    const openPullRequest = (repo: RepoRef, number: number, tab: ReviewTabRequest) => {
        if (!githubKey) {
            openLink(`https://github.com/${repo.owner}/${repo.name}/pull/${number}`);
            return;
        }
        setReviewOpen({ repo: `${repo.owner}/${repo.name}`, number, tab, nonce: Date.now() });
        setMainView('review');
    };

    /** A click on a notification: show the worktree (and the agent tab), or the Dashboard. */
    const openNotificationTarget = (target: NotificationTarget | undefined) => {
        if (!target) return;
        if (target.view === 'dashboard') {
            setMainView('dashboard');
            return;
        }
        showWorktree(target.worktreePath);
        if (target.sessionId) activate(target.worktreePath, `t:${target.sessionId}`);
    };
    const notifyAgent = useNotifications({
        appSettings,
        summaries: project.summaries,
        worktreesByRepo,
        worktrees,
        sessions,
        links,
        commentFilter,
        repoLabel,
        openTarget: openNotificationTarget,
        // A terminal in any pane of the split view is visible, not only the focused one.
        isSessionVisible: session =>
            document.hasFocus() && mainView === 'worktree' && session.worktreePath === selectedPath && !!layout && !!leafOfTab(layout, `t:${session.id}`)
    });

    // The effect below registers the IPC listeners one time. The refs give the listeners the functions of the newest render.
    const sessionExitedRef = useRef(tabs.sessionExited);
    sessionExitedRef.current = tabs.sessionExited;
    const notifyAgentRef = useRef(notifyAgent);
    notifyAgentRef.current = notifyAgent;
    // biome-ignore lint/correctness/useExhaustiveDependencies: The start-up effect runs one time. project.setProjects and showSettingsPage only set state, so old copies are correct.
    useEffect(() => {
        (async () => {
            const [state, terminalSettings, existing] = await Promise.all([api.projects.get(), api.terminals.settings(), api.terminals.list()]);
            setSettings(terminalSettings);
            api.tasks.links().then(setLinks, () => undefined);
            api.settings
                .get()
                .then(setAppSettings, () => undefined)
                .finally(() => setSettingsLoaded(true));
            setSessions(existing);
            project.setProjects(state);
            await showProject(
                state,
                existing.map(session => session.id)
            );
        })();
        const offExit = api.terminals.onExit(id => sessionExitedRef.current(id));
        // The agent state goes to its own store, not to `sessions`: an agent reports it at each tool call, and a
        // render of the full app for each report makes the typing in a terminal slow.
        const offAgentState = api.terminals.onAgentState((id, update) => {
            agentStateStore.set(id, update);
            if (update.state === 'waiting' || update.state === 'done') {
                notifyAgentRef.current(id, update.state, update.message);
            }
        });
        // An agent that the user started in a shell tab, for example with `claude` or `codex`.
        const offAgentProgram = api.terminals.onAgentProgram((id, program) => agentStateStore.setProgram(id, program));
        // The "Settings…" menu item (⌘,) opens the settings page.
        const offOpenSettings = api.app.onOpenSettings(showSettingsPage);
        return () => {
            offOpenSettings();
            offExit();
            offAgentState();
            offAgentProgram();
        };
    }, [showProject]);

    const { terminalSettings, colorsKey: terminalColorsKey } = useTerminalColors(settings, appSettings.appearance.terminalColors === 'theme', palette, mode);

    const rightPanelShown = explorerOpen && !!selectedPath && mainView === 'worktree';

    // The GitHub state of the selected worktree. Diff tabs show the newest review threads from it.
    const github = useBranchStatus(selectedPath, explorerOpen || worktreeExtras.some(tab => tab.kind !== 'browser'));
    /** The address and the title of each browser tab, for the tab strip. */
    const browserStates = useBrowserStates();
    const latestPullRequest = (pr: PullRequest) => (github.status?.pullRequest?.number === pr.number ? github.status.pullRequest : pr);

    /** Opens a tab of the selected worktree: a pull request diff, a local change, all local changes or a CI log. */
    const openExtraHere = (tab: Parameters<typeof openExtra>[1]) => {
        if (selectedPath) {
            openExtra(selectedPath, tab);
        }
    };
    const openDiff = (pr: PullRequest, file: PullRequestFile, line?: number) =>
        openExtraHere({ key: `d:${file.path}`, kind: 'diff', pr, file, line, nonce: Date.now() });
    /** Opens the diff of a local change: staged (HEAD and the index) or unstaged (the index and the working file). */
    const openChange = (change: FileChange, side: ChangeSide) => openExtraHere({ key: `c:${side}:${change.path}`, kind: 'change', change, side });
    /** Opens one tab with the diffs of all local changes of the selected worktree. */
    const openAllChanges = () => openExtraHere({ key: 'c:all', kind: 'changes' });
    const openLog = (check: CheckRun) => openExtraHere({ key: `l:${check.id}`, kind: 'log', check });

    const openBrowser = useBrowserTabs({
        extraTabs: tabs.extraTabs,
        openExtra,
        defaultRoot: selectedPath ?? worktrees[0]?.path,
        selectedPath,
        setSelectedPath,
        setMainView,
        focusBrowserPane: tabs.focusBrowserPane
    });

    /**
     * The back and forward history (⌘[ and ⌘]). Each change of the view, the worktree or the active tab adds an entry.
     * A focus change in a split also adds one, because the tab of the focused pane is the active tab.
     * The settings page has no entry. It has its own close button.
     */
    const stepHistory = useNavHistory(navLocationOf(mainView, selectedPath, activeTab, graphRepo));
    const navigate = (step: 1 | -1) => {
        const location = stepHistory(step, item =>
            isNavValid(
                item,
                repos,
                worktrees.map(worktree => worktree.path),
                tabs.tabKeysOf
            )
        );
        if (!location) return;
        if (location.view === 'worktree' && location.worktree) {
            setSelectedPath(location.worktree);
            if (location.tab) activate(location.worktree, location.tab);
        }
        if (location.view === 'graph') setGraphRepo(location.repo);
        setMainView(location.view as MainView);
    };

    const focusWorkspace = () => tabs.focusWorkspace(mainView === 'worktree');
    /**
     * The workspace shortcuts, as in Ghostty. ⌘T: a new shell tab. ⌘W: close the focused pane, or the tab when it has
     * one pane. ⌘D and ⇧⌘D: a new shell pane at the right of, or below, the focused pane. ⌥⌘ and an arrow key: move the focus
     * to the pane at that side. ⌘[ and ⌘]: back and forward. ⌘1 to ⌘9, ⇧⌘[, ⇧⌘], ⌃Tab and ⌃⇧Tab: select a tab.
     * ⌥⌘1 to ⌥⌘6: open a view. ⇧⌘0: move the focus to the workspace.
     */
    const shortcut = async (action: ShortcutAction) => {
        if (dialogOpen()) return;
        if (action === 'back' || action === 'forward') {
            navigate(action === 'back' ? -1 : 1);
            return;
        }
        if (action === 'toggleSidebar') {
            toggleSidebar();
            return;
        }
        if (action === 'focusSidebar') {
            // A hidden sidebar shows first. The sidebar takes the request when it mounts.
            if (sidebarCollapsed) toggleSidebar();
            requestSidebarFocus();
            return;
        }
        if (action === 'toggleRightPanel') {
            toggleExplorer();
            return;
        }
        if (action === 'focusExplorer') {
            if (mainView !== 'worktree' || !selectedPath) return;
            if (!explorerOpen) toggleExplorer();
            requestExplorerFocus();
            return;
        }
        if (action === 'newWorktree') {
            // The repository on the screen: the commit graph, else the selected worktree, else the first repository.
            const repo = (mainView === 'graph' ? graphRepo : undefined) ?? selectedRepo ?? repos[0];
            if (repo) setNewWorktree({ repo });
            return;
        }
        if (action in VIEW_OF_ACTION) {
            const view = VIEW_OF_ACTION[action as ViewAction];
            // The sidebar shows Tasks only when the project has repositories.
            if (view === 'tasks' && repos.length === 0) return;
            setMainView(view);
            return;
        }
        if (action === 'focusWorkspace') {
            focusWorkspace();
            return;
        }
        if (mainView !== 'worktree' || !selected) return;
        if (action === 'newTab') {
            await startTerminal(selected, 'shell');
            return;
        }
        await tabs.paneShortcut(action, selected);
    };
    useShortcuts(shortcut, focusWorkspace);

    // The language servers need the worktree roots, and "go to definition" opens files through the app.
    useEffect(() => {
        lspBridge.setRoots(worktrees.map(worktree => worktree.path));
    }, [worktrees]);
    lspBridge.setOpener((root, path, line, column) => openFile(path, line, column, root));

    /** The data of the selected worktree for the tab titles and icons. */
    const tabContext = { selectedPath, sessions: worktreeSessions, extras: worktreeExtras, dirtyFiles: tabs.dirtyFiles, browserStates };

    /** The view of one tab. `focused` is false for a pane without the focus. */
    const renderTab = (tab: TabKey, focused: boolean): ReactNode =>
        renderTabView(tab, focused, {
            selectedPath,
            selected,
            sessions: worktreeSessions,
            extras: worktreeExtras,
            dragging: !!tabs.draggingTab,
            reveal: tabs.reveal,
            focusRequest: tabs.focusRequest,
            settings,
            terminalSettings,
            terminalColorsKey,
            agents: appSettings.agents,
            defaultAgentId: agentForRepo(appSettings, selectedPath && project.repoOfWorktree(selectedPath)).id,
            latestPullRequest,
            refreshGitHub: github.refresh,
            closeFromView: tabs.closeFromView,
            openFile: path => openFile(path),
            sendToAgent,
            sendLogToAgent: agents.sendLogToAgent,
            setError
        });

    return (
        <SidebarContext.Provider value={{ collapsed: sidebarCollapsed, toggle: toggleSidebar }}>
            <div className="app-shell">
                <div
                    className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}${mainView === 'worktree' && selectedPath ? ' has-right-toggle' : ''}${rightPanelShown ? ' right-panel-shown' : ''}`}
                    style={{ '--sidebar-width': `${sidebarWidth.width}px`, '--explorer-width': `${explorerWidth.width}px` } as CSSProperties}
                >
                    {!sidebarCollapsed && (
                        <Sidebar
                            projects={projects}
                            repos={repos}
                            worktreesByRepo={worktreesByRepo}
                            sessions={sessions}
                            selectedPath={selectedPath}
                            links={links}
                            summaries={project.summaries}
                            tasksActive={mainView === 'tasks'}
                            settingsActive={mainView === 'settings'}
                            onOpenSettings={() => openSettings()}
                            onOpenRepoSettings={repo => openSettings(`repo:${repo}`)}
                            graphRepo={mainView === 'graph' ? graphRepo : undefined}
                            onOpenGraph={repo => {
                                setGraphRepo(repo);
                                setMainView('graph');
                            }}
                            repoLabel={repoLabel}
                            repoColor={repo => appSettings.repos[repo]?.color}
                            onOpenTasks={() => setMainView('tasks')}
                            agentsActive={mainView === 'agents'}
                            onOpenAgents={() => setMainView('agents')}
                            reviewActive={mainView === 'review'}
                            reviewCount={reviewCount}
                            onOpenReview={() => setMainView('review')}
                            pipelinesActive={mainView === 'pipelines'}
                            onOpenPipelines={() => setMainView('pipelines')}
                            notesActive={mainView === 'notes'}
                            onOpenNotes={() => setMainView('notes')}
                            dashboardActive={mainView === 'dashboard'}
                            dashboardCount={dashboardCount}
                            onOpenDashboard={() => setMainView('dashboard')}
                            onAddRepo={project.addRepo}
                            onRemoveRepo={project.removeRepo}
                            onSwitchProject={project.switchProject}
                            onCreateProject={(name: string) => project.changeProjects(api.projects.create(name))}
                            onRenameProject={(id: string, name: string) => project.changeProjects(api.projects.rename(id, name))}
                            onDeleteProject={(id: string) => project.changeProjects(api.projects.delete(id))}
                            onSelect={worktree => showWorktree(worktree.path)}
                            onCreate={worktreeActions.createWorktree}
                            worktreeNames={appSettings.worktreeNames}
                            onRemove={(repo, worktree) => removeWorktree(repo, worktree)}
                            onWorktreeMenu={worktreeActions.worktreeMenu}
                            onOpenTask={openLinkedTask}
                            worktreeSort={appSettings.worktrees.sort}
                            hiddenWorktrees={appSettings.hiddenWorktrees}
                            onMoveProject={project.moveProject}
                            onMoveRepo={project.moveRepo}
                        />
                    )}
                    {!sidebarCollapsed && (
                        <ResizeHandle
                            panel={sidebarWidth}
                            edge="right"
                            label="Resize the worktree list"
                            maxAvailable={() => window.innerWidth - renderedWidth('.explorer') - MIN_WORKSPACE_WIDTH}
                        />
                    )}
                    {mainView === 'tasks' && activeProject && (
                        <main className="workspace">
                            <TasksView
                                key={activeProject.id}
                                projectId={activeProject.id}
                                repos={repos}
                                links={links}
                                onStartTask={worktreeActions.startTask}
                                onOpenSettings={() => openSettings('tasks')}
                                openTask={taskOpen}
                                repoLabel={repoLabel}
                                onOpenWorktree={showWorktree}
                            />
                        </main>
                    )}
                    {mainView === 'review' && (
                        <main className="workspace">
                            <ReviewView
                                githubKey={githubKey}
                                onOpenSettings={() => openSettings('review')}
                                open={reviewOpen}
                                onNewWorktree={(repo, pr) => void worktreeActions.openPullRequestWorktree(repo, pr)}
                                projects={projects}
                                onPullRepo={project.pullRepo}
                            />
                        </main>
                    )}
                    {mainView === 'pipelines' && (
                        <main className="workspace">
                            <PipelinesView githubKey={githubKey} onOpenSettings={() => openSettings('review')} />
                        </main>
                    )}
                    {mainView === 'graph' && graphRepo && (
                        <main className="workspace">
                            <GitGraphView
                                repo={worktreesByRepo[graphRepo]?.find(worktree => worktree.isMain)?.path ?? graphRepo}
                                repoName={repoLabel(graphRepo)}
                                worktrees={worktreesByRepo[graphRepo] ?? []}
                                onNewWorktree={start => setNewWorktree({ repo: graphRepo, start })}
                                onOpenWorktree={worktree => showWorktree(worktree.path)}
                            />
                        </main>
                    )}
                    {mainView === 'notes' && (
                        <main className="workspace">
                            <NotesView />
                        </main>
                    )}
                    {mainView === 'dashboard' && (
                        <main className="workspace">
                            <DashboardView
                                onOpenPullRequest={openPullRequest}
                                filter={commentFilter}
                                onCreateRule={(author, text) => {
                                    setRulePrefill({ author, text, nonce: Date.now() });
                                    openSettings('dashboard');
                                }}
                                onHideAuthor={author => {
                                    const list = appSettings.dashboardHiddenAuthors ?? [];
                                    void api.settings.update({ dashboardHiddenAuthors: [...list, author] }).then(setAppSettings);
                                }}
                                onOpenSettings={() => openSettings('dashboard')}
                            />
                        </main>
                    )}
                    {mainView === 'agents' && (
                        <main className="workspace">
                            <AgentsView
                                sessions={sessions}
                                projects={projects}
                                links={links}
                                repoLabel={repoLabel}
                                repoColor={repo => appSettings.repos[repo]?.color}
                                onOpen={openAgent}
                            />
                        </main>
                    )}
                    {mainView === 'settings' && (
                        <main className="workspace">
                            <SettingsView
                                settings={appSettings}
                                mode={mode}
                                terminal={settings}
                                repos={repos}
                                initialSection={settingsSection}
                                rulePrefill={rulePrefill}
                                onSave={async change => setAppSettings(await api.settings.update(change))}
                                onClose={closeSettings}
                            />
                        </main>
                    )}
                    <main className="workspace" style={mainView !== 'worktree' ? { display: 'none' } : undefined}>
                        <header className="workspace-header">
                            <TabStrip
                                items={tabs.stripItems}
                                activeTab={activeTab}
                                info={key => tabInfo(key, tabContext)}
                                onSelect={key => selectedPath && activate(selectedPath, key)}
                                onMove={tabs.moveStripItem}
                                onCloseTab={tabs.closeTabView}
                                onCloseGroup={tabs.closeGroup}
                                onDragStart={tabs.setDraggingTab}
                                onDragEnd={() => {
                                    tabs.setDraggingTab(undefined);
                                    tabs.setDropTarget(undefined);
                                }}
                            />
                            {/* The "+" sits right after the last tab. It is outside the tab strip, which scrolls and would cut off the menu. */}
                            {selected && (
                                <div className="tab-strip-actions">
                                    <NewTabMenu
                                        agents={appSettings.agents}
                                        defaultAgentId={agentForRepo(appSettings, selectedRepo).id}
                                        onStart={target =>
                                            target === 'browser' ? void openBrowser(BLANK_PAGE, selected.path) : startTerminal(selected, target)
                                        }
                                    />
                                </div>
                            )}
                            <div className="header-spacer" />
                            {selectedPath && links[selectedPath] && (
                                <button
                                    className="task-chip"
                                    title={`Open the task: ${links[selectedPath].title}`}
                                    onClick={() => openLinkedTask(selectedPath)}
                                >
                                    <ListTodo size={13} strokeWidth={1.7} />
                                    <span>{links[selectedPath].key ?? links[selectedPath].title}</span>
                                </button>
                            )}
                            <div className="header-actions">
                                {selected && selectedRepo && (
                                    <ScriptsMenu
                                        repoName={repoLabel(selectedRepo)}
                                        scripts={appSettings.repos[selectedRepo]?.scripts ?? []}
                                        onRun={script => void agents.runScript(selectedRepo, selected, script)}
                                        onSave={scripts => worktreeActions.saveScripts(selectedRepo, scripts)}
                                    />
                                )}
                            </div>
                        </header>

                        {error && (
                            <ErrorBanner title="Click to close" onClose={() => setError(undefined)}>
                                {error}
                            </ErrorBanner>
                        )}

                        <section className={`terminal-area${tabs.draggingTab ? ' dragging-tab' : ''}`}>
                            {layout ? (
                                <PaneTree
                                    layout={layout}
                                    node={layout.root}
                                    renderTab={renderTab}
                                    tabTitle={key => tabInfo(key, tabContext).title}
                                    draggingTab={tabs.draggingTab}
                                    dropTarget={tabs.dropTarget}
                                    setDropTarget={tabs.setDropTarget}
                                    onFocusPane={tabs.focusPane}
                                    onResize={(splitId, ratio) => activeTab && tabs.commitGroup(activeTab, resizeSplit(layout, splitId, ratio))}
                                    onMoveToTab={tabs.movePaneToTab}
                                    onClosePane={tabs.closePaneView}
                                    onDrop={(dragged, leafId, side) => {
                                        tabs.dropTab(dragged, leafId, side);
                                        tabs.setDraggingTab(undefined);
                                        tabs.setDropTarget(undefined);
                                    }}
                                />
                            ) : (
                                <div className="empty-state">
                                    {repos.length === 0 && (
                                        <>
                                            <div className="empty-title">{activeProject ? `${activeProject.name} has no repositories` : 'Loading…'}</div>
                                            {activeProject && (
                                                <button className="button primary" onClick={project.addRepo}>
                                                    Add a repository
                                                </button>
                                            )}
                                        </>
                                    )}
                                    {repos.length > 0 && selected && (
                                        <>
                                            <div className="empty-title">{selected.branch ?? selected.path}</div>
                                            <div className="empty-detail">{selected.path}</div>
                                            <button className="button primary" onClick={() => startTerminal(selected, 'agent')}>
                                                Start {agentForRepo(appSettings, selectedRepo).name}
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}
                        </section>
                    </main>
                    {rightPanelShown && selectedPath && (
                        <ResizeHandle
                            panel={explorerWidth}
                            edge="left"
                            label="Resize the side panel"
                            maxAvailable={() => window.innerWidth - renderedWidth('.sidebar') - MIN_WORKSPACE_WIDTH}
                        />
                    )}
                    {rightPanelShown && selectedPath && (
                        <RightPanel
                            root={selectedPath}
                            activeFile={tabs.activeFile}
                            github={github}
                            onOpenFile={(path, line) => openFile(path, line)}
                            onOpenDiff={openDiff}
                            onOpenLog={openLog}
                            onSendToAgent={sendToAgent}
                            onSendLogToAgent={agents.sendLogToAgent}
                            onSendChecksToAgent={agents.sendChecksToAgent}
                            onShowTerminal={id => activate(selectedPath, `t:${id}`)}
                            onOpenChange={openChange}
                            onOpenAllChanges={openAllChanges}
                        />
                    )}
                    {newWorktree && (
                        <NewWorktreeDialog
                            // A new key for each repository and start point, so that the dialog starts with empty fields.
                            key={`${newWorktree.repo}\n${JSON.stringify(newWorktree.start ?? null)}`}
                            repoName={repoLabel(newWorktree.repo)}
                            repoPath={newWorktree.repo}
                            {...(!newWorktree.start
                                ? {}
                                : 'remote' in newWorktree.start
                                  ? { initialRemote: newWorktree.start.remote }
                                  : { initialBase: { ref: newWorktree.start.commit, label: newWorktree.start.label } })}
                            onClose={() => setNewWorktree(undefined)}
                            onCreate={async request => {
                                await worktreeActions.createWorktree(newWorktree.repo, request);
                                setNewWorktree(undefined);
                            }}
                        />
                    )}
                </div>
                {/* The two panel buttons have fixed places in the title bar, so they never move when they are clicked: the
                left one after the macOS window buttons, the right one in the top-right corner. They come after the
                top bars in the page: Electron applies the window drag areas in page order, so a later "no-drag" area
                is needed over the drag area of a top bar, or the click moves the window. */}
                <div className="titlebar-controls left">
                    <SidebarToggle />
                </div>
                {mainView === 'worktree' && selectedPath && (
                    <div className="titlebar-controls right">
                        <button
                            className="icon-button panel-toggle"
                            title={explorerOpen ? 'Hide the right panel (⌘E)' : 'Show the right panel (⌘E)'}
                            aria-pressed={explorerOpen}
                            onClick={toggleExplorer}
                        >
                            <PanelRight size={16} strokeWidth={1.5} />
                        </button>
                    </div>
                )}
                <StatusBar />
            </div>
        </SidebarContext.Provider>
    );
}
