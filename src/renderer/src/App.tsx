import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderDown, FolderGit2, FolderPlus, GitBranchPlus, ListTodo, PanelRight, Play, SquareTerminal } from 'lucide-react';
import { keyRoots } from './query-client';
import { EmptyState } from './components/EmptyState';
import { CloneRepoDialog } from './components/CloneRepoDialog';
import { startAgentAction } from './app/empty-states';
import type { PullRequest, PullRequestFile } from '@shared/github';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { isPanelTab, readPanelTab, RightPanel, writePanelTab, type PanelTab } from './components/RightPanel';
import { requestExplorerFocus } from './files/explorer-focus';
import { dialogOpen, promptDialog } from './components/ConfirmDialog';
import { AppCommandPalette } from './palette/AppCommandPalette';
import type { PaletteActions } from './palette/palette-commands';
import { newPlan } from '@shared/plans';
import { noteNameError, uniqueNoteName } from '@shared/notes';
import { NewWorktreeDialog } from './components/NewWorktreeDialog';
import { LinkTaskDialog } from './components/LinkTaskDialog';
import { GitGraphView } from './components/GitGraphView';
import { TasksView } from './components/TasksView';
import { Sidebar } from './components/Sidebar';
import { useBranchStatus } from './github/use-branch-status';
import { ResizeHandle, usePanelWidth } from './components/ResizeHandle';
import { readSettingsSection, SETTINGS_SECTIONS, SettingsView } from './components/SettingsView';
import { AgentsView } from './components/AgentsView';
import { NewTabMenu } from './components/NewTabMenu';
import { ReviewView } from './components/ReviewView';
import { groupPage, reviewPage } from './app/review-page';
import { DashboardView, type ReviewTabRequest } from './components/DashboardView';
import { NotesView } from './components/NotesView';
import { AutomationsView, type AutomationRequest } from './automations/AutomationsView';
import { useAutomationRuns } from './automations/automation-queries';
import { automationEngine } from './automations/engine';
import { useAutomationEngine } from './automations/use-automation-engine';
import { PlansView } from './plans/PlansView';
import { createPlan, usePlans } from './plans/plan-queries';
import { planRunner } from './plans/plan-runner';
import { PipelinesView } from './components/PipelinesView';
import { ScriptsMenu } from './components/ScriptsMenu';
import { AutomationButtons } from './automations/AutomationButtons';
import { useDashboardCount, useDashboardLoader } from './dashboard-store';
import { useReviewOverviewLoader, useReviewQueue } from './github/review-overview-store';
import { reviewScopeKey, useReviewProviders } from './review-providers-store';
import type { NotificationTarget } from '@shared/api';
import type { NavLocation, ViewRoute } from '@shared/nav-history';
import { parseRepoId, pullRequestWebUrl, repoId, type RepoRef } from '@shared/github';
import { useAppearance } from './theme/appearance';
import { StatusBar } from './components/StatusBar';
import { ErrorBanner } from './components/ErrorBanner';
import { Button, IconButton } from './components/ui';
import { agentForRepo, DEFAULT_SETTINGS, repoDisplayName, type AppSettings } from '@shared/settings';
import { changeOnboarding, type HelpAction } from '@shared/onboarding';
import { shouldOpenWelcome } from '@shared/welcome';
import { shouldOfferTour, TOUR_STEPS, TOUR_VERSION, type TourStep } from '@shared/tour';
import { shouldShowChecklist, updatedChecklist, type ChecklistStepId } from '@shared/checklist';
import { runsAgent } from '@shared/terminal';
import { ChecklistCard } from './components/ChecklistCard';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { Tour, TourOffer } from './components/Tour';
import { TipNotice, useProvideTips } from './components/Tips';
import { useTips, type OnboardingChange } from './app/use-tips';
import type { TipAction } from '@shared/tips';
import { WelcomeView } from './components/WelcomeView';
import { WorktreeProgressNotices } from './components/WorktreeProgressNotices';
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
import { errorText } from './util';
import { BLANK_PAGE } from '@shared/browser';
import { worktreeLabel, type Worktree } from '@shared/worktrees';
import { worktreeForTask } from './components/tasks/task-view-logic';
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
import { useTaskLinks } from './app/task-links';
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
    /** The app starts on the Dashboard until the saved view of the project loads. Then the saved view shows. */
    const [mainView, setMainView] = useState<MainView>('dashboard');
    /** The repository that the commit graph page shows. */
    const [graphRepo, setGraphRepo] = useState<string>();
    /** The task that the Tasks view opens next, for example from the task link of a worktree. */
    const [taskOpen, setTaskOpen] = useState<{ connectionId: string; taskId: string; nonce: number }>();
    /**
     * The page and the query of each view, as the path and the query of a web address. The history entries keep them,
     * so a step back shows the same page with the same selections. The worktree view keeps the tab of the right panel
     * in its query. The page of the settings page is its section.
     */
    const [routes, setRoutes] = useState<Partial<Record<MainView, ViewRoute>>>({});
    const routeOf = (view: MainView): ViewRoute => routes[view] ?? {};
    /** Sets the page and the query of a view. A different page adds a history entry. A different query replaces the entry. */
    const setRoute = (view: MainView, route: ViewRoute) => setRoutes(current => ({ ...current, [view]: route }));
    /** The tab of the right panel that the user selected last. A worktree page without a tab in its query shows it. */
    const [lastPanelTab, setLastPanelTab] = useState<PanelTab>(readPanelTab);
    const routePanelTab = routes.worktree?.query?.panel;
    const panelTab = isPanelTab(routePanelTab) ? routePanelTab : lastPanelTab;
    const selectPanelTab = (tab: PanelTab) => {
        setLastPanelTab(tab);
        writePanelTab(tab);
        setRoute('worktree', { query: { ...routes.worktree?.query, panel: tab } });
    };
    /** A new value starts the views again on their entry page, for example the pull request list of Review. */
    const [viewEntry, setViewEntry] = useState(0);
    /** The last view before the settings page. The saved layout keeps it in place of the settings page. */
    const viewBeforeSettings = useRef<ContentView>('dashboard');
    useEffect(() => {
        if (mainView !== 'settings') viewBeforeSettings.current = mainView;
    }, [mainView]);
    const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
    /** False until the settings load. The appearance waits for them, so the start does not show the default theme. */
    const [settingsLoaded, setSettingsLoaded] = useState(false);
    /** False until the start-up effect selects the first view. A new user sees the welcome page only after that. */
    const [startupDone, setStartupDone] = useState(false);
    const { mode, palette } = useAppearance(settingsLoaded ? appSettings.appearance : undefined);
    /** The task of each worktree, by worktree path. */
    const links = useTaskLinks();
    const [error, setError] = useState<string>();
    const sidebarWidth = usePanelWidth('shipwarden.width.sidebar', 260, 180, 480);
    const explorerWidth = usePanelWidth('shipwarden.width.explorer', 300, 220, 720);
    /** A new hiding rule from a Dashboard comment, for Settings > Dashboard to fill in. */
    const [rulePrefill, setRulePrefill] = useState<{ author: string; text: string; nonce: number }>();
    /**
     * The New worktree dialog that ⌘N or the commit graph opened, with its repository. The commit graph also gives a
     * start point. Without a start point, the dialog starts from the default branch.
     */
    const [newWorktree, setNewWorktree] = useState<NewWorktreeTarget>();
    /** The worktree of the open "Link to a task" dialog. */
    const [linkTaskFor, setLinkTaskFor] = useState<Worktree>();
    /** True while the clone dialog of the empty worktree area shows. */
    const [cloneOpen, setCloneOpen] = useState(false);
    /** True while the command palette (⇧⌘P) shows. */
    const [paletteOpen, setPaletteOpen] = useState(false);
    /** A request of the command palette for the Automations view: a new automation, or an automation to edit. */
    const [automationRequest, setAutomationRequest] = useState<AutomationRequest>();
    /** True when the Tasks view must open the New task dialog, after "Create a task" in the command palette. */
    const [createTaskOnOpen, setCreateTaskOnOpen] = useState(false);
    // A view reads its request when it opens. The request then clears, so a later open of the view does not repeat it.
    useEffect(() => {
        if (automationRequest) setAutomationRequest(undefined);
    }, [automationRequest]);
    useEffect(() => {
        if (createTaskOnOpen) setCreateTaskOnOpen(false);
    }, [createTaskOnOpen]);
    /** The name of a repository in the UI: its name from the repository settings, else its folder name. */
    const repoLabel = (repo: string) => repoDisplayName(appSettings, repo);

    /** The home folder. The Terminal view keeps its tabs under it, as the worktree view keeps the tabs of a worktree under its path. */
    const homeFolder = useQuery({ queryKey: keyRoots.appInfo, queryFn: () => api.app.info(), staleTime: Number.POSITIVE_INFINITY }).data?.homeFolder;
    const terminalView = mainView === 'terminal';
    /** The folder of the tabs on the screen: the home folder in the Terminal view, else the selected worktree. */
    const workspacePath = terminalView ? homeFolder : selectedPath;
    /** The home folder as a worktree, so the Terminal view can use the actions of the worktree view. It has no repository. */
    const homeWorktree = useMemo<Worktree | undefined>(
        () => (homeFolder ? { path: homeFolder, head: '', isMain: false, isBare: false, locked: false, prunable: false } : undefined),
        [homeFolder]
    );

    const tabs = useWorkspaceTabs({ selectedPath: workspacePath, setSelectedPath, sessions, setSessions, setError });
    const { activeTab, layout, worktreeSessions, worktreeExtras, activate, openExtra, openFile } = tabs;
    const project = useProjects({
        selectedPath,
        setSelectedPath,
        mainView,
        setMainView,
        viewBeforeSettings,
        routes,
        setRoute,
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
    /** The worktree of the tabs on the screen: the home folder in the Terminal view, else the selected worktree. */
    const workspaceWorktree = terminalView ? homeWorktree : selected;
    const agents = useAgentActions({
        sessions,
        setSessions,
        appSettings,
        selectedPath: workspacePath,
        selected: workspaceWorktree,
        repoOfWorktree: project.repoOfWorktree,
        activate,
        setError
    });
    const { startTerminal, sendToAgent } = agents;
    const worktreeActions = useWorktreeActions({
        appSettings,
        setAppSettings,
        activeProjectId: activeProject?.id,
        projects,
        switchProject: project.switchProject,
        repos,
        worktreesByRepo,
        worktrees,
        refreshWorktrees: project.refreshWorktrees,
        sessions,
        setSessions,
        links,
        openFiles: tabs.openFiles,
        setOpenFiles: tabs.setOpenFiles,
        setExtraTabs: tabs.setExtraTabs,
        selectedPath,
        setSelectedPath,
        setMainView,
        setNewWorktree,
        setTaskOpen,
        setLinkTaskOpen: setLinkTaskFor,
        repoLabel,
        startTerminal,
        sendToAgent,
        promptAgent: agents.promptAgent,
        prepareWorktree: agents.prepareWorktree,
        setError
    });
    const { openLinkedTask } = worktreeActions;

    /**
     * Shows the settings page on a section, for example "repo:<path>" for the settings of one repository. Each section is
     * a page of the history. Without a section, the page shows the section that the user selected last. When the
     * settings page shows already, it stays on its section.
     */
    const openSettings = (section?: string) => {
        if (!section && mainView === 'settings') return;
        setRoute('settings', { page: section ?? readSettingsSection() });
        setMainView('settings');
    };
    // The IPC listener registers one time. The ref gives it the function of the newest render.
    const openSettingsRef = useRef(openSettings);
    openSettingsRef.current = openSettings;
    /** The close button and Escape go back past the settings pages, to the page before them. See `navigate`. */
    const closeSettingsRef = useRef<() => void>(() => undefined);
    const closeSettings = useCallback(() => closeSettingsRef.current(), []);
    /**
     * Shows a view on its entry page. The sidebar and the view shortcuts use it. An open pull request or task closes, also
     * when the view shows already.
     */
    const enterView = (view: ContentView) => openViewAt(view, {});
    /** Shows a view on a page, for example a plan or a note, as a new entry of the view. */
    const openViewAt = (view: ContentView, route: ViewRoute) => {
        setRoute(view, route);
        setTaskOpen(undefined);
        setAutomationRequest(undefined);
        setCreateTaskOnOpen(false);
        setViewEntry(value => value + 1);
        setMainView(view);
    };
    /** Selects a worktree and shows the worktree view. */
    const showWorktree = (path: string) => {
        setSelectedPath(path);
        setMainView('worktree');
    };
    /** Shows the tabs of a session folder: the Terminal view for the home folder, else the worktree view. Then selects the tab of the session. */
    const showSessionTab = (worktreePath: string, sessionId?: string) => {
        if (worktreePath === homeFolder) setMainView('terminal');
        else showWorktree(worktreePath);
        if (sessionId) activate(worktreePath, `t:${sessionId}`);
    };

    /**
     * Shows the tab of an agent from the Agents view. When the agent runs in another project, the sidebar switches
     * to that project first, so the worktree is in the list.
     */
    const openAgent = async (session: TerminalSession, projectId: string | undefined) => {
        if (projectId && projectId !== projects?.activeId) {
            await project.switchProject(projectId);
        }
        if (session.worktreePath) showSessionTab(session.worktreePath, session.id);
        else setMainView('worktree');
    };

    const reviewProviders = useReviewProviders();
    const reviewKey = reviewScopeKey(reviewProviders);
    useDashboardLoader(settingsLoaded, reviewKey);
    useReviewOverviewLoader(settingsLoaded, reviewKey, project.allRepos);
    const reviewCount = useReviewQueue().length;
    const commentFilter = useMemo(
        () => ({ hiddenAuthors: appSettings.dashboardHiddenAuthors, hiddenRules: appSettings.dashboardHiddenRules }),
        [appSettings.dashboardHiddenAuthors, appSettings.dashboardHiddenRules]
    );
    const dashboardCount = useDashboardCount(commentFilter);
    /** Opens a pull request in the Review view. Without a provider, the pull request opens in the browser. */
    const openPullRequest = (repo: RepoRef, number: number, tab: ReviewTabRequest) => {
        if (!reviewKey) {
            openLink(pullRequestWebUrl(repo, number));
            return;
        }
        setRoute('review', { page: reviewPage(repoId(repo), number), query: { tab } });
        setMainView('review');
    };

    /** Opens the page of a PR group in the Review view. */
    const openPrGroup = (id: string) => {
        setRoute('review', { page: groupPage(id) });
        setMainView('review');
    };

    /** A click on a notification: show the worktree (and the agent tab), or the Dashboard. */
    const openNotificationTarget = (target: NotificationTarget | undefined) => {
        if (!target) return;
        if (target.view === 'dashboard' || target.view === 'automations') {
            setMainView(target.view);
            return;
        }
        showSessionTab(target.worktreePath, target.sessionId);
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
            document.hasFocus() &&
            (mainView === 'worktree' || terminalView) &&
            session.worktreePath === workspacePath &&
            !!layout &&
            !!leafOfTab(layout, `t:${session.id}`)
    });

    // The automations run while the app is open. The engine gets the state of the app and its events here.
    useAutomationEngine({
        settingsLoaded,
        appSettings,
        sessions,
        allRepos: project.allRepos,
        activeRepos: repos,
        worktreesByRepo,
        summaries: project.summaries,
        links,
        actions: {
            promptAgent: agents.promptAgent,
            startTaskQuietly: worktreeActions.startTaskQuietly,
            startInNewWorktree: worktreeActions.startInNewWorktree,
            removeWorktreeQuietly: worktreeActions.removeWorktreeQuietly,
            moveTaskToStatus: worktreeActions.moveTaskToStatus
        }
    });
    const automationsCount = useAutomationRuns().state.runs.filter(run => run.status === 'pending').length;

    // The plans execute their steps while the app is open. The runner gets the state of the app here.
    const { plans, loaded: plansLoaded } = usePlans();
    planRunner.setContext({
        ready: settingsLoaded && plansLoaded,
        sessions,
        notifications: appSettings.notifications,
        repoLabel,
        actions: {
            promptAgent: agents.promptAgent,
            prepareWorktree: agents.prepareWorktree,
            refreshWorktrees: project.refreshWorktrees,
            moveTaskToStatus: worktreeActions.moveTaskToStatus
        }
    });
    const plansCount = plans.reduce((count, plan) => count + plan.steps.filter(step => step.status === 'attention' || step.status === 'failed').length, 0);

    /** Saves a change of the onboarding state. The other values of the state stay. */
    const onboardingSaves = useRef<Promise<unknown>>(Promise.resolve());
    const saveOnboarding = (change: OnboardingChange): Promise<void> => {
        // The saves run one after the other, and each one reads the newest state first. Two saves at the same time (for
        // example "No thanks" and a checklist step) then both stay.
        const save = onboardingSaves.current.then(async () => {
            const current = (await api.settings.get()).onboarding;
            const values = typeof change === 'function' ? change(current) : change;
            setAppSettings(await api.settings.update({ onboarding: changeOnboarding(current, values) }));
        });
        onboardingSaves.current = save.catch(() => undefined);
        return save;
    };
    /** True while the guided tour shows. */
    const [tourOpen, setTourOpen] = useState(false);
    /** The panels and the view before the tour. The tour opens panels for its steps, and puts them back at its end. */
    const beforeTour = useRef<{ sidebarCollapsed: boolean; explorerOpen: boolean; mainView: MainView } | undefined>(undefined);
    const startTour = () => {
        if (tourOpen) return;
        beforeTour.current = { sidebarCollapsed, explorerOpen, mainView };
        // The tour points at the workspace. The welcome page and the settings page do not have its parts.
        if (mainView === 'welcome' || mainView === 'settings') setMainView(selectedPath ? 'worktree' : 'dashboard');
        setTourOpen(true);
    };
    /** Opens the part of the window that a step needs. A step without its part shows its callout in the center. */
    const prepareTourStep = (step: TourStep) => {
        if (step.needs === 'sidebar' && sidebarCollapsed) toggleSidebar();
        if ((step.needs === 'worktree' || step.needs === 'rightPanel') && selectedPath) setMainView('worktree');
        if (step.needs === 'rightPanel' && selectedPath && !explorerOpen) toggleExplorer();
    };
    /** Ends the tour, puts the panels back and saves that the user saw this tour version. */
    const endTour = () => {
        setTourOpen(false);
        const before = beforeTour.current;
        beforeTour.current = undefined;
        if (before) {
            if (before.sidebarCollapsed && !sidebarCollapsed) toggleSidebar();
            if (!before.explorerOpen && explorerOpen) toggleExplorer();
            setMainView(before.mainView === 'welcome' || before.mainView === 'settings' ? mainView : before.mainView);
        }
        void saveOnboarding({ tourSeen: TOUR_VERSION }).catch(err => setError(errorText(err)));
    };
    /** True while the Keyboard Shortcuts dialog shows. */
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    /** Runs an item of the Help menu. */
    const help = (action: HelpAction) => {
        if (action === 'welcome') setMainView('welcome');
        else if (action === 'tour') startTour();
        else if (action === 'shortcuts') setShortcutsOpen(true);
    };

    // The getting started checklist marks a step done when the user does its action.
    const checklistShows = settingsLoaded && shouldShowChecklist(appSettings.onboarding);
    const checklistFacts = {
        hasRepository: project.allRepos.length > 0,
        hasWorktree: worktrees.some(worktree => !worktree.isMain),
        hasAgent: sessions.some(runsAgent),
        agentsViewOpen: mainView === 'agents',
        hasPullRequest: repos.some(repo =>
            (worktreesByRepo[repo] ?? []).some(worktree => !worktree.isMain && !!worktree.branch && !!project.summaries[repo]?.[worktree.branch])
        )
    };
    const checklistChange = checklistShows ? updatedChecklist(appSettings.onboarding?.checklist, checklistFacts) : undefined;
    const checklistKey = checklistChange ? JSON.stringify(checklistChange) : undefined;
    // biome-ignore lint/correctness/useExhaustiveDependencies: checklistKey holds the content of checklistChange.
    useEffect(() => {
        if (checklistChange) void saveOnboarding({ checklist: checklistChange }).catch(err => setError(errorText(err)));
    }, [checklistKey]);
    /** The button of a checklist step that is not done. */
    const checklistAction = (step: ChecklistStepId): { label: string; run(): void } | undefined => {
        if (step === 'addRepository') return { label: 'Add a repository', run: () => void project.addRepo() };
        if (step === 'createWorktree' && repos.length > 0) return { label: 'Create a worktree', run: () => setNewWorktree({ repo: selectedRepo ?? repos[0] }) };
        if (step === 'startAgent' && selected) return { label: 'Show the worktree', run: () => setMainView('worktree') };
        if (step === 'openAgents') return { label: 'Open Agents', run: () => enterView('agents') };
        return undefined;
    };
    // The tips: one tip in the corner at each start (and 12 hours after a close), and the inline tips in the views. They wait while the welcome page, the
    // tour, the tour offer, or a dialog shows. The tip notice stacks above the update notice.
    const tourOffered = settingsLoaded && shouldOfferTour(appSettings.onboarding, mainView === 'welcome');
    const runTipAction = (action: TipAction) => {
        if (action.kind === 'view') enterView(action.view);
        else if (action.kind === 'settings') openSettings(action.section);
        else if (action.kind === 'shortcuts') setShortcutsOpen(true);
        else if (action.kind === 'commandPalette') setPaletteOpen(true);
        else if (repos.length > 0) setNewWorktree({ repo: selectedRepo ?? repos[0] });
        else void project.addRepo();
    };
    const tips = useTips({
        onboarding: appSettings.onboarding,
        settingsLoaded,
        blocked: mainView === 'welcome' || tourOpen || tourOffered || shortcutsOpen || paletteOpen || !!newWorktree,
        saveOnboarding,
        runAction: runTipAction,
        onError: err => setError(errorText(err))
    });
    useProvideTips(tips.inline);
    const helpRef = useRef(help);
    helpRef.current = help;

    // The effect below registers the IPC listeners one time. The refs give the listeners the functions of the newest render.
    const sessionExitedRef = useRef(tabs.sessionExited);
    sessionExitedRef.current = tabs.sessionExited;
    const notifyAgentRef = useRef(notifyAgent);
    notifyAgentRef.current = notifyAgent;
    // biome-ignore lint/correctness/useExhaustiveDependencies: The start-up effect runs one time. project.setProjects only sets state, so an old copy is correct.
    useEffect(() => {
        (async () => {
            try {
                const [state, terminalSettings, existing] = await Promise.all([api.projects.get(), api.terminals.settings(), api.terminals.list()]);
                setSettings(terminalSettings);
                const loaded = api.settings
                    .get()
                    .then(
                        value => {
                            setAppSettings(value);
                            return value;
                        },
                        () => undefined
                    )
                    .finally(() => setSettingsLoaded(true));
                setSessions(existing);
                project.setProjects(state);
                await showProject(
                    state,
                    existing.map(session => session.id)
                );
                // A new user sees the welcome page. It comes after the saved view of the project, so the saved view does not replace it.
                if (shouldOpenWelcome((await loaded)?.onboarding)) setMainView('welcome');
            } finally {
                setStartupDone(true);
            }
        })();
        const offExit = api.terminals.onExit(id => sessionExitedRef.current(id));
        // The agent state goes to its own store, not to `sessions`: an agent reports it at each tool call, and a
        // render of the full app for each report makes the typing in a terminal slow.
        const offAgentState = api.terminals.onAgentState((id, update) => {
            agentStateStore.set(id, update);
            automationEngine.onAgentState(id, update);
            planRunner.onAgentState(id, update);
            if (update.state === 'waiting' || update.state === 'done') {
                notifyAgentRef.current(id, update.state, update.message);
            }
        });
        // An agent that the user started in a shell tab, for example with `claude` or `codex`.
        const offAgentProgram = api.terminals.onAgentProgram((id, program) => agentStateStore.setProgram(id, program));
        // The "Settings…" menu item (⌘,) opens the settings page.
        const offOpenSettings = api.app.onOpenSettings(section => openSettingsRef.current(section));
        // The items of the Help menu.
        const offHelp = api.app.onHelp(action => helpRef.current(action));
        return () => {
            offOpenSettings();
            offHelp();
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

    const openBrowser = useBrowserTabs({
        extraTabs: tabs.extraTabs,
        openExtra,
        defaultRoot: workspacePath ?? worktrees[0]?.path,
        selectedPath,
        setSelectedPath,
        setMainView,
        homeFolder,
        focusBrowserPane: tabs.focusBrowserPane
    });

    /**
     * The back and forward history (⌘[ and ⌘]). Each change of the view, the worktree, the active tab or the page of a
     * view adds an entry. A focus change in a split also adds one, because the tab of the focused pane is the active tab.
     * A change of the selections in a page (the query), for example the tab of the right panel, replaces the current entry.
     * Each section of the settings page is a page.
     */
    const currentRoute: ViewRoute = mainView === 'worktree' ? { query: { panel: panelTab } } : routeOf(mainView);
    const stepHistory = useNavHistory(navLocationOf(mainView, workspacePath, activeTab, graphRepo, currentRoute));
    /**
     * Moves one step back (-1) or forward (1) in the history. `skip` rejects more entries. Returns false when no entry
     * is in that direction.
     */
    const navigate = (step: 1 | -1, skip?: (location: NavLocation) => boolean): boolean => {
        const location = stepHistory(
            step,
            item =>
                !skip?.(item) &&
                isNavValid(
                    item,
                    repos,
                    worktrees.map(worktree => worktree.path),
                    tabs.tabKeysOf
                )
        );
        if (!location) return false;
        const view = location.view as MainView;
        // The entry has the page and the selections. An old open request must not change them when the view opens.
        setTaskOpen(undefined);
        if (view !== 'graph') setRoute(view, { page: location.page, query: location.query });
        if (view === 'worktree' && isPanelTab(location.query?.panel)) setLastPanelTab(location.query.panel);
        if (location.view === 'worktree' && location.worktree) {
            setSelectedPath(location.worktree);
            if (location.tab) activate(location.worktree, location.tab);
        }
        if (location.view === 'terminal' && location.worktree && location.tab) activate(location.worktree, location.tab);
        if (location.view === 'graph') setGraphRepo(location.repo);
        setMainView(view);
        return true;
    };
    // The close button of the settings page goes back to the last page before the settings pages. Without one, it
    // shows the last view before the settings page.
    closeSettingsRef.current = () => {
        if (!navigate(-1, item => item.view === 'settings')) setMainView(viewBeforeSettings.current);
    };

    const focusWorkspace = () => tabs.focusWorkspace(mainView === 'worktree' || terminalView);
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
        if (action === 'commandPalette') {
            setPaletteOpen(true);
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
            selectPanelTab('files');
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
            enterView(view);
            return;
        }
        if (action === 'focusWorkspace') {
            focusWorkspace();
            return;
        }
        // The tab and pane shortcuts work the same in the worktree view and in the Terminal view.
        const target = mainView === 'worktree' ? selected : terminalView ? homeWorktree : undefined;
        if (!target) return;
        if (action === 'newTab') {
            await startTerminal(target, 'shell');
            return;
        }
        await tabs.paneShortcut(action, target);
    };
    useShortcuts(shortcut, focusWorkspace);

    /** The actions of the command palette. */
    const paletteActions: PaletteActions = {
        newWorktree: repo => setNewWorktree({ repo }),
        showWorktree,
        removeWorktree: (repo, worktree) => worktreeActions.removeWorktree(repo, worktree),
        enterView,
        openPullRequest: (repo, number) => openPullRequest(parseRepoId(repo), number, 'overview'),
        openLinkedTask: worktreeActions.openLinkedTask,
        createTask: () => {
            enterView('tasks');
            setCreateTaskOnOpen(true);
        },
        createPlan: async () => {
            if (!activeProject) return;
            const plan = newPlan(activeProject.id, Date.now());
            // createPlan puts the plan in the cache at once, so the page can show it.
            const saving = createPlan(plan);
            openViewAt('plans', { page: plan.id });
            await saving;
        },
        openPlan: id => openViewAt('plans', { page: id }),
        createNote: async () => {
            const name = await promptDialog({
                title: 'New note',
                message: 'Type a file name. A name without an extension gets ".md".',
                placeholder: 'scratch.md',
                confirmLabel: 'Create'
            });
            if (!name) return;
            const problem = noteNameError(name);
            if (problem) throw new Error(problem);
            const fileName = name.includes('.') ? name : `${name}.md`;
            const existing = (await api.notes.list()).filter(note => !note.folder).map(note => note.fileName);
            const note = await api.notes.create(uniqueNoteName(fileName, existing));
            openViewAt('notes', { query: { note: note.name } });
        },
        openNote: name => openViewAt('notes', { query: { note: name } }),
        newAutomation: templateId => {
            enterView('automations');
            setAutomationRequest({ kind: 'new', templateId });
        },
        editAutomation: id => {
            enterView('automations');
            setAutomationRequest({ kind: 'edit', id });
        },
        openSettings,
        setAppearance: async change => setAppSettings(await api.settings.update({ appearance: { ...appSettings.appearance, ...change } })),
        // The same check as ⇧⌘U. The page shows the result in a notice.
        checkForUpdates: async () => api.app.runKey('checkForUpdates'),
        help
    };

    // The language servers need the worktree roots, and "go to definition" opens files through the app.
    useEffect(() => {
        lspBridge.setRoots(worktrees.map(worktree => worktree.path));
    }, [worktrees]);
    lspBridge.setOpener((root, path, line, column) => openFile(path, line, column, root));

    /** The data of the selected worktree for the tab titles and icons. */
    const tabContext = { selectedPath: workspacePath, sessions: worktreeSessions, extras: worktreeExtras, dirtyFiles: tabs.dirtyFiles, browserStates };

    /** The view of one tab. `focused` is false for a pane without the focus. */
    const renderTab = (tab: TabKey, focused: boolean): ReactNode =>
        renderTabView(tab, focused, {
            selectedPath: workspacePath,
            selected: workspaceWorktree,
            sessions: worktreeSessions,
            extras: worktreeExtras,
            dragging: !!tabs.draggingTab,
            reveal: tabs.reveal,
            focusRequest: tabs.focusRequest,
            settings,
            terminalSettings,
            terminalColorsKey,
            agents: appSettings.agents,
            agentChat: appSettings.agentChat,
            defaultAgentId: agentForRepo(appSettings, workspacePath && project.repoOfWorktree(workspacePath)).id,
            latestPullRequest,
            refreshGitHub: github.refresh,
            closeFromView: tabs.closeFromView,
            openFile: path => openFile(path),
            sendToAgent,
            setError
        });

    // The cover hides the app layout until the first view is known. Without it, a new user sees the layout for a moment
    // before the welcome page opens. A current user sees the cover only until the settings load.
    const startCover = !startupDone && (!settingsLoaded || shouldOpenWelcome(appSettings.onboarding));

    return (
        <SidebarContext.Provider value={{ collapsed: sidebarCollapsed, toggle: toggleSidebar }}>
            <div className="app-shell">
                {startCover && <div className="welcome-cover" aria-hidden="true" />}
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
                            onOpenTasks={() => enterView('tasks')}
                            agentsActive={mainView === 'agents'}
                            onOpenAgents={() => enterView('agents')}
                            reviewActive={mainView === 'review'}
                            reviewCount={reviewCount}
                            onOpenReview={() => enterView('review')}
                            pipelinesActive={mainView === 'pipelines'}
                            onOpenPipelines={() => enterView('pipelines')}
                            notesActive={mainView === 'notes'}
                            onOpenNotes={() => enterView('notes')}
                            automationsActive={mainView === 'automations'}
                            automationsCount={automationsCount}
                            onOpenAutomations={() => enterView('automations')}
                            plansActive={mainView === 'plans'}
                            plansCount={plansCount}
                            onOpenPlans={() => enterView('plans')}
                            terminalActive={terminalView}
                            onOpenTerminal={() => enterView('terminal')}
                            dashboardActive={mainView === 'dashboard'}
                            dashboardCount={dashboardCount}
                            onOpenDashboard={() => enterView('dashboard')}
                            onAddRepo={project.addRepo}
                            onRemoveRepo={project.removeRepo}
                            onSwitchProject={project.switchProject}
                            onCreateProject={(name: string) => project.changeProjects(api.projects.create(name))}
                            onRenameProject={(id: string, name: string) => project.changeProjects(api.projects.rename(id, name))}
                            onDeleteProject={(id: string) => project.changeProjects(api.projects.delete(id))}
                            onSelect={worktree => showWorktree(worktree.path)}
                            onCreate={worktreeActions.createWorktree}
                            worktreeNames={appSettings.worktreeNames}
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
                                key={`${activeProject.id}:${viewEntry}`}
                                projectId={activeProject.id}
                                repos={repos}
                                links={links}
                                onStartTask={worktreeActions.startTask}
                                onLinkWorktree={worktreeActions.chooseWorktreeForTask}
                                onUnlinkWorktree={worktreeActions.unlinkTask}
                                onOpenSettings={() => openSettings('tasks')}
                                openTask={taskOpen}
                                route={routeOf('tasks')}
                                onRoute={route => setRoute('tasks', route)}
                                createOnOpen={createTaskOnOpen}
                                repoLabel={repoLabel}
                                onOpenWorktree={path => void worktreeActions.showTaskWorktree(path).catch(err => setError(errorText(err)))}
                            />
                        </main>
                    )}
                    {mainView === 'review' && (
                        <main className="workspace">
                            <ReviewView
                                key={viewEntry}
                                reviewKey={reviewKey}
                                onOpenSettings={() => openSettings('review')}
                                route={routeOf('review')}
                                onRoute={route => setRoute('review', route)}
                                onNewWorktree={(repo, pr) => void worktreeActions.openPullRequestWorktree(repo, pr)}
                                onSendToAgent={(repo, pr, prompt) => void worktreeActions.openPullRequestWorktree(repo, pr, prompt)}
                                onSendLogToAgent={(repo, pr, check) =>
                                    void agents.sendLogToAgent(check, repo, prompt => worktreeActions.openPullRequestWorktree(repo, pr, prompt))
                                }
                                onSendChecksToAgent={(repo, pr, checks) =>
                                    void agents.sendChecksToAgent(checks, repo, prompt => worktreeActions.openPullRequestWorktree(repo, pr, prompt))
                                }
                                projects={projects}
                                onPullRepo={project.pullRepo}
                            />
                        </main>
                    )}
                    {mainView === 'pipelines' && (
                        <main className="workspace">
                            <PipelinesView
                                key={viewEntry}
                                reviewKey={reviewKey}
                                onOpenSettings={() => openSettings('review')}
                                route={routeOf('pipelines')}
                                onRoute={route => setRoute('pipelines', route)}
                            />
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
                            <NotesView key={viewEntry} route={routeOf('notes')} onRoute={route => setRoute('notes', route)} />
                        </main>
                    )}
                    {mainView === 'automations' && (
                        <main className="workspace">
                            <AutomationsView
                                key={viewEntry}
                                settings={appSettings}
                                onSaveSettings={async change => setAppSettings(await api.settings.update(change))}
                                repos={project.allRepos}
                                repoLabel={repoLabel}
                                onOpenWorktree={(path, sessionId) => openNotificationTarget({ view: 'worktree', worktreePath: path, sessionId })}
                                onOpenNotes={() => enterView('notes')}
                                request={automationRequest}
                            />
                        </main>
                    )}
                    {mainView === 'plans' && activeProject && (
                        <main className="workspace">
                            <PlansView
                                key={`${activeProject.id}:${viewEntry}`}
                                project={activeProject}
                                repoLabel={repoLabel}
                                route={routeOf('plans')}
                                onRoute={route => setRoute('plans', route)}
                                onOpenWorktree={(path, sessionId) => openNotificationTarget({ view: 'worktree', worktreePath: path, sessionId })}
                                onOpenGroup={openPrGroup}
                            />
                        </main>
                    )}
                    {mainView === 'dashboard' && (
                        <main className="workspace">
                            <DashboardView
                                reviewKey={reviewKey}
                                onOpenReviewSettings={() => openSettings('review')}
                                checklist={
                                    checklistShows ? (
                                        <ChecklistCard
                                            checklist={appSettings.onboarding?.checklist}
                                            actionOf={checklistAction}
                                            onClose={() => void saveOnboarding({ checklistClosed: true }).catch(err => setError(errorText(err)))}
                                        />
                                    ) : undefined
                                }
                                key={viewEntry}
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
                                key={viewEntry}
                                sessions={sessions}
                                projects={projects}
                                links={links}
                                repoLabel={repoLabel}
                                repoColor={repo => appSettings.repos[repo]?.color}
                                onOpen={openAgent}
                                onStartAgent={() => {
                                    const action = startAgentAction(selectedPath, repos.length);
                                    if (action === 'worktree') setMainView('worktree');
                                    else if (action === 'newWorktree') setNewWorktree({ repo: selectedRepo ?? repos[0] });
                                    else {
                                        setMainView('worktree');
                                        void project.addRepo();
                                    }
                                }}
                            />
                        </main>
                    )}
                    {mainView === 'welcome' && (
                        <main className="workspace">
                            <WelcomeView
                                settings={appSettings}
                                mode={mode}
                                repos={repos}
                                projectName={activeProject?.name}
                                onSave={async change => setAppSettings(await api.settings.update(change))}
                                onOpenSettings={section => openSettings(section)}
                                onAddRepo={() => void project.addRepo()}
                                onCloneRepo={repo => (activeProject ? project.pullRepo(repo, { projectId: activeProject.id }) : Promise.resolve(false))}
                                onStart={() => {
                                    void saveOnboarding({ welcome: 'done' }).catch(err => setError(errorText(err)));
                                    const repo = repos[0];
                                    setMainView(worktrees.length > 0 ? 'worktree' : 'dashboard');
                                    if (repo) setNewWorktree({ repo });
                                }}
                                onLater={() => {
                                    void saveOnboarding({ welcome: 'done' }).catch(err => setError(errorText(err)));
                                    setMainView(worktrees.length > 0 ? 'worktree' : 'dashboard');
                                }}
                                onSkip={() => {
                                    void saveOnboarding({ welcome: 'skipped' }).catch(err => setError(errorText(err)));
                                    setMainView('dashboard');
                                }}
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
                                section={routeOf('settings').page ?? readSettingsSection()}
                                onSelectSection={section => setRoute('settings', { page: section })}
                                rulePrefill={rulePrefill}
                                onSave={async change => setAppSettings(await api.settings.update(change))}
                                onClose={closeSettings}
                            />
                        </main>
                    )}
                    <main className="workspace" style={mainView !== 'worktree' && !terminalView ? { display: 'none' } : undefined}>
                        <header className="workspace-header" data-tour="tabs">
                            <TabStrip
                                items={tabs.stripItems}
                                activeTab={activeTab}
                                info={key => tabInfo(key, tabContext)}
                                onSelect={key => workspacePath && activate(workspacePath, key)}
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
                            {workspaceWorktree && (
                                <div className="tab-strip-actions" data-tour="agent">
                                    <NewTabMenu
                                        agents={appSettings.agents}
                                        defaultAgentId={agentForRepo(appSettings, terminalView ? undefined : selectedRepo).id}
                                        onStart={target =>
                                            target === 'browser'
                                                ? void openBrowser(BLANK_PAGE, workspaceWorktree.path)
                                                : startTerminal(workspaceWorktree, target)
                                        }
                                    />
                                </div>
                            )}
                            <div className="header-spacer" />
                            {/* The Terminal view has no repository, so it has no task, no automations and no scripts. */}
                            {!terminalView && selectedPath && links[selectedPath] && (
                                <Button
                                    className="task-chip"
                                    title={`Open the task: ${links[selectedPath].title}`}
                                    icon={<ListTodo size={14} strokeWidth={1.7} />}
                                    onClick={() => openLinkedTask(selectedPath)}
                                >
                                    <span>{links[selectedPath].key ?? links[selectedPath].title}</span>
                                </Button>
                            )}
                            <div className="header-actions">
                                {!terminalView && selected && selectedRepo && (
                                    <AutomationButtons
                                        variant="menu"
                                        target={{ entity: 'worktree', repoPath: selectedRepo, worktree: selected, link: links[selected.path] }}
                                        onError={setError}
                                    />
                                )}
                                {!terminalView && selected && selectedRepo && (
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
                            ) : terminalView ? (
                                <div className="empty-state">
                                    <EmptyState
                                        icon={SquareTerminal}
                                        title="No tabs are open"
                                        actions={
                                            <Button
                                                variant="primary"
                                                size="lg"
                                                icon={<SquareTerminal size={14} strokeWidth={1.8} aria-hidden="true" />}
                                                disabled={!homeWorktree}
                                                onClick={() => homeWorktree && void startTerminal(homeWorktree, 'shell')}
                                            >
                                                Open a shell
                                            </Button>
                                        }
                                        hint={
                                            <>
                                                Press <kbd>⌘T</kbd> for a shell tab.
                                            </>
                                        }
                                    >
                                        Shells and agents on this page start in your home folder.
                                    </EmptyState>
                                </div>
                            ) : (
                                <div className="empty-state">
                                    {!activeProject && <div className="empty-title">Loading…</div>}
                                    {activeProject && repos.length === 0 && (
                                        <EmptyState
                                            icon={FolderGit2}
                                            title={`${activeProject.name} has no repositories`}
                                            actions={
                                                <>
                                                    <Button
                                                        variant="primary"
                                                        size="lg"
                                                        icon={<FolderPlus size={14} strokeWidth={1.8} aria-hidden="true" />}
                                                        onClick={project.addRepo}
                                                    >
                                                        Add a repository
                                                    </Button>
                                                    <Button
                                                        size="lg"
                                                        icon={<FolderDown size={14} strokeWidth={1.8} aria-hidden="true" />}
                                                        onClick={() => setCloneOpen(true)}
                                                    >
                                                        Clone a repository
                                                    </Button>
                                                </>
                                            }
                                        >
                                            Add a git repository from your Mac, or clone one from GitHub. Then create worktrees and start agents in them.
                                        </EmptyState>
                                    )}
                                    {repos.length > 0 && selected && (
                                        <EmptyState
                                            icon={SquareTerminal}
                                            title={selected.branch ?? selected.path}
                                            actions={
                                                <Button
                                                    variant="primary"
                                                    size="lg"
                                                    data-tour="agent"
                                                    icon={<Play size={14} strokeWidth={1.8} aria-hidden="true" />}
                                                    onClick={() => startTerminal(selected, 'agent')}
                                                >
                                                    Start {agentForRepo(appSettings, selectedRepo).name}
                                                </Button>
                                            }
                                            hint={
                                                <>
                                                    Press <kbd>⌘T</kbd> for a shell tab. Press <kbd>⌘N</kbd> for a new worktree.
                                                </>
                                            }
                                        >
                                            <span className="empty-view-path" title={selected.path}>
                                                {selected.path}
                                            </span>
                                        </EmptyState>
                                    )}
                                    {repos.length > 0 && !selected && (
                                        <EmptyState
                                            icon={GitBranchPlus}
                                            title="No worktree is selected"
                                            actions={
                                                <Button
                                                    variant="primary"
                                                    size="lg"
                                                    icon={<GitBranchPlus size={14} strokeWidth={1.8} aria-hidden="true" />}
                                                    onClick={() => setNewWorktree({ repo: selectedRepo ?? repos[0] })}
                                                >
                                                    Create a worktree
                                                </Button>
                                            }
                                            hint={
                                                <>
                                                    Press <kbd>⌘N</kbd> for a new worktree.
                                                </>
                                            }
                                        >
                                            Select a worktree in the sidebar, or create a worktree for a new branch.
                                        </EmptyState>
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
                            tab={panelTab}
                            onSelectTab={selectPanelTab}
                            activeFile={tabs.activeFile}
                            github={github}
                            onOpenFile={(path, line) => openFile(path, line)}
                            onFileMoved={(from, to) => tabs.filesMoved(selectedPath, from, to)}
                            onFilesDeleted={paths => tabs.filesDeleted(selectedPath, paths)}
                            onOpenDiff={openDiff}
                            renderPrAutomations={
                                selected && selectedRepo
                                    ? pr => (
                                          <AutomationButtons
                                              target={{ entity: 'pullRequest', repoPath: selectedRepo, worktree: selected, pr, link: links[selected.path] }}
                                          />
                                      )
                                    : undefined
                            }
                            onSendToAgent={sendToAgent}
                            onSendLogToAgent={check => void agents.sendLogToAgent(check)}
                            onSendChecksToAgent={agents.sendChecksToAgent}
                            onShowTerminal={id => activate(selectedPath, `t:${id}`)}
                            onOpenChange={openChange}
                            onOpenAllChanges={openAllChanges}
                            // The Review view needs a provider that is on, so the button needs one.
                            onOpenInReview={reviewKey ? (repo, pr) => openPullRequest(repo, pr.number, 'overview') : undefined}
                        />
                    )}
                    {cloneOpen && activeProject && (
                        <CloneRepoDialog
                            projectName={activeProject.name}
                            onClose={() => setCloneOpen(false)}
                            onClone={repo => project.pullRepo(repo, { projectId: activeProject.id })}
                        />
                    )}
                    {linkTaskFor && (
                        <LinkTaskDialog
                            key={linkTaskFor.path}
                            worktreeName={worktreeLabel(linkTaskFor, appSettings.worktreeNames)}
                            current={links[linkTaskFor.path]}
                            otherWorktreeOf={(connectionId, task) => {
                                const path = worktreeForTask(links, connectionId, task);
                                if (!path || path === linkTaskFor.path) return undefined;
                                const other = worktrees.find(item => item.path === path);
                                // A worktree of another project is not in the list. Its folder name shows then.
                                return other ? worktreeLabel(other, appSettings.worktreeNames) : path.split('/').pop();
                            }}
                            onClose={() => setLinkTaskFor(undefined)}
                            onLink={(task, connectionId, pluginId) => worktreeActions.linkTask(linkTaskFor.path, task, connectionId, pluginId)}
                            onUnlink={() => worktreeActions.unlinkTask(linkTaskFor.path)}
                        />
                    )}
                    {newWorktree && (
                        <NewWorktreeDialog
                            // A new key for each repository and start point, so that the dialog starts with empty fields.
                            key={`${newWorktree.repo}\n${JSON.stringify(newWorktree.start ?? null)}\n${newWorktree.task?.task.id ?? ''}`}
                            repoName={repoLabel(newWorktree.repo)}
                            repoPath={newWorktree.repo}
                            {...(newWorktree.task
                                ? {
                                      title: `Start ${newWorktree.task.task.key ?? newWorktree.task.task.title} in ${repoLabel(newWorktree.repo)}`,
                                      suggestBranch: () => worktreeActions.suggestTaskBranch(newWorktree.task!.task, newWorktree.repo)
                                  }
                                : {})}
                            {...(!newWorktree.start
                                ? {}
                                : 'remote' in newWorktree.start
                                  ? { initialRemote: newWorktree.start.remote }
                                  : { initialBase: { ref: newWorktree.start.commit, label: newWorktree.start.label } })}
                            onClose={() => setNewWorktree(undefined)}
                            onCreate={async request => {
                                await worktreeActions.createWorktree(newWorktree.repo, request, newWorktree.prompt, newWorktree.task);
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
                        <IconButton
                            className="panel-toggle"
                            icon={<PanelRight size={16} strokeWidth={1.5} />}
                            label={explorerOpen ? 'Hide the right panel (⌘E)' : 'Show the right panel (⌘E)'}
                            aria-pressed={explorerOpen}
                            onClick={toggleExplorer}
                        />
                    </div>
                )}
                <StatusBar />
                {tourOpen && <Tour steps={TOUR_STEPS} onPrepare={prepareTourStep} onClose={endTour} />}
                {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
                {paletteOpen && (
                    <AppCommandPalette
                        context={{
                            repos,
                            worktreesByRepo,
                            worktreeNames: appSettings.worktreeNames,
                            repoLabel,
                            selectedRepo,
                            selectedPath,
                            links,
                            tasksAvailable: repos.length > 0 && !!activeProject,
                            hasProject: !!activeProject,
                            plans: plans.filter(plan => plan.projectId === activeProject?.id),
                            reviewAvailable: !!reviewKey,
                            appearance: appSettings.appearance,
                            mode,
                            settingsSections: SETTINGS_SECTIONS,
                            actions: paletteActions
                        }}
                        onClose={() => setPaletteOpen(false)}
                        onError={setError}
                    />
                )}
                <WorktreeProgressNotices repoLabel={repoLabel} openTarget={openNotificationTarget} />
                {tips.notice && <TipNotice tip={tips.notice.tip} onRun={runTipAction} onClose={tips.notice.close} onTurnOff={tips.notice.turnOff} />}
                {!tourOpen && tourOffered && (
                    <TourOffer onStart={startTour} onDecline={() => void saveOnboarding({ tourSeen: TOUR_VERSION }).catch(err => setError(errorText(err)))} />
                )}
            </div>
        </SidebarContext.Provider>
    );
}
