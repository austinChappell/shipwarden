import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Columns2, FileDiff, GitCompareArrows, Globe, ListTodo, PanelRight, ScrollText, SquareArrowOutUpRight, SquareTerminal, X } from 'lucide-react';
import { baseName } from '@shared/files';
import type { BranchSummary, CheckRun, PullRequest, PullRequestFile } from '@shared/github';
import { applyStartStatus, branchNameForTask, taskPrompt, type Task, type TaskLink } from '@shared/tasks';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { EditorView } from './components/EditorView';
import { DiffView } from './components/DiffView';
import { LogView } from './components/LogView';
import { RightPanel } from './components/RightPanel';
import { confirmDialog, dialogOpen, promptDialog } from './components/ConfirmDialog';
import { NewWorktreeDialog, type NewWorktreeRequest } from './components/NewWorktreeDialog';
import { GitGraphView, type GraphWorktreeStart } from './components/GitGraphView';
import { TasksView } from './components/TasksView';
import { Sidebar } from './components/Sidebar';
import { TerminalView } from './components/TerminalView';
import { documents } from './editor/documents';
import { fileIcon } from './files/file-icons';
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
import { dashboardStore, useDashboardCount, useDashboardLoader, type DashboardNews } from './dashboard-store';
import { seenStore } from './seen-store';
import { gitHubSeenKey, isHiddenComment, taskSeenKey } from '@shared/dashboard';
import { ciChanges, type NotificationEvent } from '@shared/notifications';
import type { NotificationTarget } from '@shared/api';
import type { RepoRef } from '@shared/github';
import { useAppearance } from './theme/appearance';
import { terminalTheme } from '@shared/themes';
import { StatusBar } from './components/StatusBar';
import { agentForRepo, DEFAULT_SETTINGS, repoDisplayName, type AgentDefinition, type AppSettings, type RepoScript } from '@shared/settings';
import { setupCommand } from '@shared/worktree-settings';
import type { CreatedWorktree } from '@shared/worktrees';
import type { ProjectsState } from '@shared/projects';
import { pruneLayout, readLayout, writeLayout } from './layout-store';
import { closePane, cycleFocus, findLeaf, focusedTab, groupOf, insertNode, leafOfTab, leaves, pruneGroups, resizeSplit, setGroup, splitPane, tabLayout, type PaneLayout, type PaneNode, type SplitGroups, type SplitSide } from '@shared/panes';
import { SplitDivider } from './components/SplitDivider';
import { shortcutAction, type ShortcutAction } from '@shared/shortcuts';
import { lspBridge } from './lsp/bridge';
import type { LspMissingServer } from '@shared/lsp';
import { terminalPool } from './terminal/terminal-pool';
import { agentStateStore } from './terminal/agent-state-store';
import { ChangeDiffView } from './components/ChangeDiffView';
import type { ChangeSide, FileChange } from '@shared/git';
import { SidebarContext, SidebarToggle } from './components/SidebarToggle';
import { BrowserView } from './components/BrowserView';
import { browserStore, useBrowserStates } from './browser/browser-store';
import { openLink, setAppBrowserOpener } from './links';
import { BLANK_PAGE, browserTabKey, browserTabTitle } from '@shared/browser';

/** The command that starts an agent. A setting will replace this value. */
const EXPLORER_STORAGE_KEY = 'shipwarden.explorerOpen';
const SIDEBAR_COLLAPSED_KEY = 'shipwarden.sidebarCollapsed';

const api = window.shipwarden;

/**
 * A tab is a terminal session ("t:<id>"), a file ("f:<relative path>"),
 * a pull request diff ("d:<relative path>"), a CI job log ("l:<job id>") or an in-app browser tab ("b:<view id>").
 */
type TabKey = string;

/** A diff tab, a log tab or a browser tab. */
type ExtraTab =
    | { key: TabKey; kind: 'diff'; pr: PullRequest; file: PullRequestFile; line?: number; nonce?: number }
    | { key: TabKey; kind: 'log'; check: CheckRun }
    | { key: TabKey; kind: 'change'; change: FileChange; side: ChangeSide }
    | { key: TabKey; kind: 'browser'; id: string };

/** The time that an agent can take to start before ShipWarden sends it a prompt. */
const AGENT_START_TIMEOUT_MS = 15_000;
const AGENT_QUIET_MS = 1200;
/** The smallest width of the center area (tabs, terminal and editor) when the user drags a panel border. */
const MIN_WORKSPACE_WIDTH = 360;
/** The time that ShipWarden waits for the user to answer a dialog of the agent. */
const AGENT_DIALOG_TIMEOUT_MS = 120_000;
/**
 * Text of agent dialogs that wait for a decision of the user, for example Claude Code's folder trust question.
 * The patterns have no spaces, because ShipWarden removes the whitespace from the screen text before the test.
 * ShipWarden must not answer these dialogs. A pasted prompt and Enter would select the default answer.
 */
const AGENT_DIALOG_PATTERN = /trustthisfolder|Entertoconfirm|Doyouwanttoproceed/i;

interface Reveal {
    root: string;
    path: string;
    line: number;
    /** When set, the editor puts the cursor at this column. Without it, the editor selects the full line. */
    column?: number;
    nonce: number;
}

function errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function fileKey(root: string, path: string): string {
    return `${root}\0${path}`;
}

/**
 * Waits until a new terminal session prints output and then is quiet for a short time.
 * An agent such as Claude Code is then ready for input.
 */
function waitForQuietOutput(sessionId: string, timeout = AGENT_START_TIMEOUT_MS): Promise<void> {
    return new Promise(resolve => {
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
            clearTimeout(quietTimer);
            clearTimeout(limit);
            unsubscribe();
            resolve();
        };
        const limit = setTimeout(finish, timeout);
        const unsubscribe = api.terminals.onData(id => {
            if (id === sessionId) {
                clearTimeout(quietTimer);
                quietTimer = setTimeout(finish, AGENT_QUIET_MS);
            }
        });
    });
}

/**
 * Waits until the agent screen shows no dialog. Calls `onDialog` one time when a dialog is visible.
 * Returns false when the dialog is still visible after the time limit.
 */
async function waitForNoDialog(sessionId: string, onDialog: () => void): Promise<boolean> {
    const deadline = Date.now() + AGENT_DIALOG_TIMEOUT_MS;
    let notified = false;
    while (Date.now() < deadline) {
        const screen = terminalPool.screenText(sessionId);
        // ghostty-web 0.4 can return the text without its spaces. Compare the text without any whitespace.
        if (screen !== undefined && !AGENT_DIALOG_PATTERN.test(screen.replace(/\s+/g, ''))) {
            return true;
        }
        if (!notified) {
            notified = true;
            onDialog();
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        // After the user answers, the agent redraws. Wait until its output is quiet again.
        await waitForQuietOutput(sessionId, 3000);
    }
    return false;
}

/** Returns the width of a panel on the screen, or 0 when the panel is not shown. */
function renderedWidth(selector: string): number {
    return document.querySelector<HTMLElement>(selector)?.offsetWidth ?? 0;
}

function readExplorerOpen(): boolean {
    try {
        return localStorage.getItem(EXPLORER_STORAGE_KEY) !== 'false';
    } catch {
        return true;
    }
}

export function App() {
    /** The projects. The sidebar shows the repositories of the active project. */
    const [projects, setProjects] = useState<ProjectsState>();
    const activeProject = projects?.projects.find(project => project.id === projects.activeId);
    const repos = useMemo(() => activeProject?.repos ?? [], [activeProject]);
    /** The worktrees of each repository, by the root of its main worktree. */
    const [worktreesByRepo, setWorktreesByRepo] = useState<Record<string, Worktree[]>>({});
    /** All worktrees of the active project. */
    const worktrees = useMemo(() => repos.flatMap(repo => worktreesByRepo[repo] ?? []), [repos, worktreesByRepo]);
    const [sessions, setSessions] = useState<TerminalSession[]>([]);
    const [settings, setSettings] = useState<TerminalSettings>();
    const [selectedPath, setSelectedPath] = useState<string>();
    /** The open files of each worktree, as paths relative to the worktree. */
    const [openFiles, setOpenFiles] = useState<Record<string, string[]>>({});
    /** The active tab of each worktree. */
    const [activeTabs, setActiveTabs] = useState<Record<string, TabKey>>({});
    /**
     * The split tabs of each worktree. A split tab is one tab in the tab strip with two or more panes, like a tab
     * of Ghostty with splits. A tab that is in no split shows its view alone.
     */
    const [panes, setPanes] = useState<Record<string, SplitGroups>>({});
    /** The tab that the user drags, and the pane side under the pointer, for the drop zones of the split view. */
    const [draggingTab, setDraggingTab] = useState<TabKey>();
    const [dropTarget, setDropTarget] = useState<{ leafId: string; side: SplitSide }>();
    const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
    const [reveal, setReveal] = useState<Reveal>();
    const [explorerOpen, setExplorerOpen] = useState(readExplorerOpen);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        try {
            return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
        } catch {
            return false;
        }
    });
    const toggleSidebar = () => setSidebarCollapsed(value => {
        try {
            localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(!value));
        } catch {
            // The state stays for this session only.
        }
        return !value;
    });
    /** The diff and log tabs of each worktree. */
    const [extraTabs, setExtraTabs] = useState<Record<string, ExtraTab[]>>({});
    /** The center area shows the selected worktree or the task list of the repository. */
    /** The app starts on the Dashboard. A project switch restores the saved view of the project. */
    const [mainView, setMainView] = useState<'dashboard' | 'worktree' | 'tasks' | 'agents' | 'review' | 'pipelines' | 'notes' | 'graph' | 'settings'>('dashboard');
    /** The repository that the commit graph page shows. */
    const [graphRepo, setGraphRepo] = useState<string>();
    const firstRestore = useRef(true);
    /** The task that the Tasks view opens next, for example from the task link of a worktree. */
    const [taskOpen, setTaskOpen] = useState<{ connectionId: string; taskId: string; nonce: number }>();
    /** The pull request that the Review view opens next, for example from the Dashboard. */
    const [reviewOpen, setReviewOpen] = useState<ReviewOpenRequest>();
    /** The view that the settings page goes back to when it closes. */
    const viewBeforeSettings = useRef<'dashboard' | 'worktree' | 'tasks' | 'agents' | 'review' | 'pipelines' | 'notes' | 'graph'>('dashboard');
    const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
    /** False until the settings load. The appearance waits for them, so the start does not show the default theme. */
    const [settingsLoaded, setSettingsLoaded] = useState(false);
    const { mode, palette } = useAppearance(settingsLoaded ? appSettings.appearance : undefined);
    /** The task of each worktree, by worktree path. */
    const [links, setLinks] = useState<Record<string, TaskLink>>({});
    /** The open pull request of each branch, with its CI state, by repository. */
    const [summaries, setSummaries] = useState<Record<string, Record<string, BranchSummary>>>({});
    const [error, setError] = useState<string>();
    const sidebarWidth = usePanelWidth('shipwarden.width.sidebar', 260, 180, 480);
    const explorerWidth = usePanelWidth('shipwarden.width.explorer', 300, 220, 720);

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
    }, []);

    /** Loads the worktrees of all repositories of a project. Returns all of them, in sidebar order. */
    const refreshAll = useCallback(async (repoList: readonly string[]) => (await Promise.all(repoList.map(refreshWorktrees))).flat(), [refreshWorktrees]);

    /** The layout key of the project whose saved layout is restored. Until then, the layout is not saved. */
    const restoredKey = useRef<string>(undefined);

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
        const saved = pruneLayout(stored, list.map(worktree => worktree.path), sessionIds);
        const openFiles: Record<string, string[]> = {};
        await Promise.all(Object.entries(saved.openFiles).map(async ([root, files]) => {
            const exists = await Promise.all(files.map(file => api.files.read(root, file).then(() => true, () => false)));
            const kept = files.filter((_file, index) => exists[index]);
            if (kept.length > 0) {
                openFiles[root] = kept;
            }
        }));
        const activeTabs = Object.fromEntries(Object.entries(saved.activeTabs)
            .filter(([root, tab]) => !tab.startsWith('f:') || openFiles[root]?.includes(tab.slice(2))));
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
    }, []);

    /** Loads the worktrees of the active project and opens its saved tabs. */
    const showProject = useCallback(async (state: ProjectsState, sessionIds: string[]) => {
        const project = state.projects.find(item => item.id === state.activeId);
        if (!project) {
            return;
        }
        restoredKey.current = undefined;
        const list = await refreshAll(project.repos);
        await restoreLayout(`project:${project.id}`, list, sessionIds, project.repos[0]);
    }, [refreshAll, restoreLayout]);

    useEffect(() => {
        (async () => {
            const [state, terminalSettings, existing] = await Promise.all([
                api.projects.get(),
                api.terminals.settings(),
                api.terminals.list()
            ]);
            setSettings(terminalSettings);
            api.tasks.links().then(setLinks, () => undefined);
            api.settings.get().then(setAppSettings, () => undefined).finally(() => setSettingsLoaded(true));
            setSessions(existing);
            setProjects(state);
            await showProject(state, existing.map(session => session.id));
        })();
        const offExit = api.terminals.onExit(id => sessionExitedRef.current(id));
        // The agent state goes to its own store, not to `sessions`: an agent reports it at each tool call, and a
        // render of the full app for each report makes the typing in a terminal slow.
        const offAgentState = api.terminals.onAgentState((id, update) => {
            agentStateStore.set(id, update);
            if (update.state === 'waiting' || update.state === 'done') {
                notifyRef.current(id, update.state, update.message);
            }
        });
        // An agent that the user started in a shell tab, for example with `claude` or `codex`.
        const offAgentProgram = api.terminals.onAgentProgram((id, program) => agentStateStore.setProgram(id, program));
        const offDirty = documents.onDirtyChange((root, path, dirty) => {
            setDirtyFiles(set => {
                const next = new Set(set);
                if (dirty) {
                    next.add(fileKey(root, path));
                } else {
                    next.delete(fileKey(root, path));
                }
                return next;
            });
        });
        // The "Settings…" menu item (⌘,) opens the settings page.
        const offOpenSettings = api.app.onOpenSettings(() => setMainView(view => {
            if (view !== 'settings') {
                viewBeforeSettings.current = view;
            }
            return 'settings';
        }));
        return () => {
            offOpenSettings();
            offExit();
            offAgentState();
            offAgentProgram();
            offDirty();
        };
    }, [showProject]);

    const layoutKey = activeProject ? `project:${activeProject.id}` : undefined;
    // Save the layout of the project after each change. The first save comes after the restore, so that it does not remove the saved layout.
    useEffect(() => {
        if (layoutKey && restoredKey.current === layoutKey) {
            // The graph page is not saved: its repository is not in the layout. The worktree view opens in its place.
            const savedView = mainView === 'settings' ? viewBeforeSettings.current : mainView;
            writeLayout(layoutKey, { selectedPath, mainView: savedView === 'graph' ? 'worktree' : savedView, openFiles, activeTabs, panes });
        }
    }, [layoutKey, selectedPath, mainView, openFiles, activeTabs, panes]);

    // The PR and CI state of each branch for the worktree list. One request covers all worktrees of a repository.
    const repoKey = repos.join('\0');
    useEffect(() => {
        const repoList = repoKey ? repoKey.split('\0') : [];
        const load = () => repoList.forEach(repo => {
            api.github.branchSummaries(repo).then(result => setSummaries(map => ({ ...map, [repo]: result })), () => undefined);
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

    /**
     * Shows a macOS notification when an agent needs input or finishes, unless the user looks at that agent now.
     * A ref keeps the newest state, because the IPC listener above is registered only one time.
     */
    const notifyRef = useRef<(id: string, state: 'waiting' | 'done', message?: string) => void>(() => undefined);
    notifyRef.current = (id, state, message) => {
        const session = sessions.find(item => item.id === id);
        // A terminal in any pane of the split view is visible, not only the focused one.
        const visible = document.hasFocus() && mainView === 'worktree' && session?.worktreePath === selectedPath && !!layout && !!leafOfTab(layout, `t:${id}`);
        if (!session || visible) {
            return;
        }
        const worktree = worktrees.find(item => item.path === session.worktreePath);
        const name = (session.worktreePath && links[session.worktreePath]?.key) || worktree?.branch || session.title;
        notify(
            state === 'waiting' ? 'agentWaiting' : 'agentDone',
            state === 'waiting' ? `${name} needs your input` : `${name} is done`,
            message ? message.slice(0, 180) : state === 'waiting' ? 'The agent waits for you.' : 'The agent finished its turn.',
            session.worktreePath ? { view: 'worktree', worktreePath: session.worktreePath, sessionId: session.id } : undefined
        );
    };

    /**
     * Shows a macOS notification for an event, when Settings › Notifications allows it.
     * The main process shows it, because only Electron can play a named macOS sound with it.
     */
    const notify = (event: NotificationEvent, title: string, body: string, target?: NotificationTarget) => {
        const settings = appSettings.notifications;
        if (!settings.enabled || !settings.events[event].enabled) return;
        if (!settings.whenFocused && document.hasFocus()) return;
        api.notifications.show({ title, body, sound: settings.events[event].sound, target });
    };

    /** A click on a notification: show the worktree (and the agent tab), or the Dashboard. */
    const openNotificationTarget = (target: NotificationTarget | undefined) => {
        if (!target) return;
        if (target.view === 'dashboard') {
            setMainView('dashboard');
            return;
        }
        setSelectedPath(target.worktreePath);
        setMainView('worktree');
        if (target.sessionId) setActiveTabs(map => ({ ...map, [target.worktreePath]: `t:${target.sessionId}` }));
    };
    const openNotificationRef = useRef(openNotificationTarget);
    openNotificationRef.current = openNotificationTarget;
    useEffect(() => api.notifications.onClick(target => openNotificationRef.current(target)), []);

    // CI finished: the checks of a pull request of a worktree went from waiting to a result.
    const previousSummaries = useRef<Record<string, Record<string, BranchSummary>>>({});
    useEffect(() => {
        for (const [repo, list] of Object.entries(summaries)) {
            for (const change of ciChanges(previousSummaries.current[repo], list)) {
                const worktree = worktreesByRepo[repo]?.find(item => item.branch === change.branch);
                notify(
                    'ciFinished',
                    `CI ${change.passed ? 'passed' : 'failed'}: ${change.branch}`,
                    `Pull request #${change.summary.number} in ${repoLabel(repo)}`,
                    worktree ? { view: 'worktree', worktreePath: worktree.path } : undefined
                );
            }
        }
        previousSummaries.current = summaries;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [summaries]);

    // New Dashboard items: one notification for each refresh, without hidden authors and seen comments.
    const dashboardNews = (news: DashboardNews) => {
        const comments = news.prComments.filter(item => !isHiddenComment(item.author, item.text, commentFilter) && !seenStore.has(gitHubSeenKey(item.id))).length
            + news.taskComments.filter(({ connectionId, comment }) => !isHiddenComment(comment.author, comment.body, commentFilter) && !seenStore.has(taskSeenKey(connectionId, comment.id))).length;
        const parts = [
            news.reviewRequests.length ? `${news.reviewRequests.length} review request${news.reviewRequests.length === 1 ? '' : 's'}` : '',
            news.myPullRequests.length ? `${news.myPullRequests.length} of your pull requests need${news.myPullRequests.length === 1 ? 's' : ''} you` : '',
            comments ? `${comments} new comment${comments === 1 ? '' : 's'}` : ''
        ].filter(Boolean);
        if (parts.length === 0) return;
        const first = news.reviewRequests[0]?.title ?? news.myPullRequests[0]?.title;
        notify('dashboard', `Dashboard: ${parts.join(', ')}`, first ?? 'Open the Dashboard to see them.', { view: 'dashboard' });
    };
    const dashboardNewsRef = useRef(dashboardNews);
    dashboardNewsRef.current = dashboardNews;
    useEffect(() => dashboardStore.onNews(news => dashboardNewsRef.current(news)), []);

    /** The section that the settings page opens on, for example the settings of one repository. */
    const [settingsSection, setSettingsSection] = useState<string>();
    const openSettings = (section?: string) => {
        setSettingsSection(section);
        setMainView(view => {
            if (view !== 'settings') {
                viewBeforeSettings.current = view;
            }
            return 'settings';
        });
    };
    const closeSettings = useCallback(() => setMainView(viewBeforeSettings.current), []);

    useDashboardLoader(settingsLoaded, appSettings.reviewOwners, activeProject?.id);
    const commentFilter = useMemo(
        () => ({ hiddenAuthors: appSettings.dashboardHiddenAuthors, hiddenRules: appSettings.dashboardHiddenRules }),
        [appSettings.dashboardHiddenAuthors, appSettings.dashboardHiddenRules]
    );
    const dashboardCount = useDashboardCount(commentFilter);
    /** A new hiding rule from a Dashboard comment, for Settings > Dashboard to fill in. */
    const [rulePrefill, setRulePrefill] = useState<{ author: string; text: string; nonce: number }>();
    /** Opens a pull request in the Review view. Without organizations for the Review view, GitHub opens in the browser. */
    const openPullRequest = (repo: RepoRef, number: number, tab: ReviewTabRequest) => {
        if (!appSettings.reviewOwners) {
            openLink(`https://github.com/${repo.owner}/${repo.name}/pull/${number}`);
            return;
        }
        setReviewOpen({ repo: `${repo.owner}/${repo.name}`, number, tab, nonce: Date.now() });
        setMainView('review');
    };

    const toggleExplorer = () => {
        setExplorerOpen(open => {
            try {
                localStorage.setItem(EXPLORER_STORAGE_KEY, String(!open));
            } catch {
                // The setting stays for this session only.
            }
            return !open;
        });
    };

    /** The terminal settings with the colors of the theme, when the user selected "Match theme". */
    const terminalSettings = useMemo(() => (settings && appSettings.appearance.terminalColors === 'theme'
        ? { ...settings, colors: { ...settings.colors, ...terminalTheme(palette, mode) } }
        : settings), [settings, appSettings.appearance.terminalColors, palette, mode]);
    /** Changes when the terminal colors change. The terminal view then opens again with the new colors. */
    const terminalColorsKey = useMemo(() => JSON.stringify(terminalSettings?.colors ?? {}), [terminalSettings]);
    const shownColorsKey = useRef(terminalColorsKey);
    if (shownColorsKey.current !== terminalColorsKey) {
        // Close the old views before the new view attaches in this render.
        if (shownColorsKey.current !== '{}') {
            terminalPool.resetAll();
        }
        shownColorsKey.current = terminalColorsKey;
    }

    const selected = worktrees.find(worktree => worktree.path === selectedPath);
    /** The repository of the selected worktree. */
    /** The New worktree dialog that the commit graph opened, with its repository and start point. */
    const [graphWorktree, setGraphWorktree] = useState<{ repo: string; start: GraphWorktreeStart }>();
    const selectedRepo = repos.find(repo => worktreesByRepo[repo]?.some(worktree => worktree.path === selectedPath));
    const rightPanelShown = explorerOpen && !!selectedPath && mainView === 'worktree';
    const worktreeSessions = useMemo(
        () => sessions.filter(session => session.worktreePath === selectedPath),
        [sessions, selectedPath]
    );
    const worktreeFiles = (selectedPath && openFiles[selectedPath]) || [];
    const worktreeExtras = (selectedPath && extraTabs[selectedPath]) || [];
    const tabKeys: TabKey[] = [
        ...worktreeSessions.map(session => `t:${session.id}`),
        ...worktreeFiles.map(path => `f:${path}`),
        ...worktreeExtras.map(tab => tab.key)
    ];
    const requestedTab = selectedPath ? activeTabs[selectedPath] : undefined;
    const activeTab = requestedTab && tabKeys.includes(requestedTab) ? requestedTab : tabKeys[0];
    const tabKeysKey = tabKeys.join('\n');
    /** The split tabs of the selected worktree, without the panes of closed tabs. */
    const groups = useMemo(
        () => (selectedPath ? pruneGroups(panes[selectedPath] ?? [], tabKeys) : []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [selectedPath, panes, tabKeysKey]
    );
    /**
     * The panes of the active tab: its split, with the focus on the pane of the active tab, or one pane.
     * The single pane has a fixed ID, so a change of the tab does not make a new pane.
     */
    const layout = useMemo((): PaneLayout | undefined => {
        if (!activeTab) return undefined;
        const group = groupOf(groups, activeTab);
        return group ? { ...group, focused: leafOfTab(group, activeTab)!.id } : { root: { kind: 'leaf', id: 'main', tab: activeTab }, focused: 'main' };
    }, [groups, activeTab]);
    const split = !!layout && layout.root.kind === 'split';
    const activeFile = activeTab?.startsWith('f:') ? activeTab.slice(2) : undefined;

    // The GitHub state of the selected worktree. Diff tabs show the newest review threads from it.
    const github = useBranchStatus(selectedPath, explorerOpen || worktreeExtras.some(tab => tab.kind !== 'browser'));
    /** The address and the title of each browser tab, for the tab strip. */
    const browserStates = useBrowserStates();
    const latestPullRequest = (pr: PullRequest) =>
        github.status?.pullRequest?.number === pr.number ? github.status.pullRequest : pr;

    const openExtra = (root: string, tab: ExtraTab) => {
        setExtraTabs(map => {
            const list = map[root] ?? [];
            const index = list.findIndex(item => item.key === tab.key);
            const next = index === -1 ? [...list, tab] : list.map(item => (item.key === tab.key ? tab : item));
            return { ...map, [root]: next };
        });
        setActiveTabs(map => ({ ...map, [root]: tab.key }));
    };

    const closeExtra = (root: string, key: TabKey) => {
        setExtraTabs(map => ({ ...map, [root]: (map[root] ?? []).filter(item => item.key !== key) }));
    };

    const openDiff = (pr: PullRequest, file: PullRequestFile, line?: number) => {
        if (selectedPath) {
            openExtra(selectedPath, { key: `d:${file.path}`, kind: 'diff', pr, file, line, nonce: Date.now() });
        }
    };

    /** Opens the diff of a local change: staged (HEAD and the index) or unstaged (the index and the working file). */
    const openChange = (change: FileChange, side: ChangeSide) => {
        if (selectedPath) {
            openExtra(selectedPath, { key: `c:${side}:${change.path}`, kind: 'change', change, side });
        }
    };

    const openLog = (check: CheckRun) => {
        if (selectedPath) {
            openExtra(selectedPath, { key: `l:${check.id}`, kind: 'log', check });
        }
    };

    /**
     * Opens an address in a new browser tab of a worktree: `root`, else the selected worktree, else the first worktree
     * of the project. The worktree view then shows. Returns false when the project has no worktree.
     */
    const openBrowser = (url: string, root?: string): boolean => {
        const target = root ?? selectedPath ?? worktrees[0]?.path;
        if (!target) return false;
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        browserStore.set({ id, url, title: '', canGoBack: false, canGoForward: false, loading: url !== BLANK_PAGE });
        api.browser.create(id, url);
        openExtra(target, { key: browserTabKey(id), kind: 'browser', id });
        if (target !== selectedPath) setSelectedPath(target);
        setMainView('worktree');
        return true;
    };
    const openBrowserRef = useRef(openBrowser);
    openBrowserRef.current = openBrowser;
    const extraTabsRef = useRef(extraTabs);
    extraTabsRef.current = extraTabs;
    useEffect(() => {
        const removeOpener = setAppBrowserOpener(url => openBrowserRef.current(url));
        // A page asked for a new window: a new browser tab in the worktree of the page.
        const removeOpenTab = api.browser.onOpenTab((url, openerId) => {
            const root = Object.entries(extraTabsRef.current).find(([, tabs]) => tabs.some(tab => tab.kind === 'browser' && tab.id === openerId))?.[0];
            openBrowserRef.current(url, root);
        });
        return () => {
            removeOpener();
            removeOpenTab();
        };
    }, []);
    // The main process keeps a view for each browser tab. Close the views of the tabs that closed.
    const shownBrowsers = useRef(new Set<string>());
    useEffect(() => {
        const ids = new Set(Object.values(extraTabs).flat().flatMap(tab => (tab.kind === 'browser' ? [tab.id] : [])));
        for (const id of shownBrowsers.current) {
            if (!ids.has(id)) {
                api.browser.destroy(id);
                browserStore.remove(id);
            }
        }
        shownBrowsers.current = ids;
    }, [extraTabs]);

    const activate = (worktreePath: string, tab: TabKey) => setActiveTabs(map => ({ ...map, [worktreePath]: tab }));

    /**
     * Saves the split of the tab `anchor` (the layout of its tab, or undefined when the split ends).
     * The tab of the focused pane becomes the active tab.
     */
    const commitGroup = (anchor: TabKey, next: PaneLayout | undefined) => {
        if (!selectedPath) return;
        setPanes(map => {
            const groups = setGroup(map[selectedPath] ?? [], anchor, next);
            const copy = { ...map };
            if (groups.length > 0) copy[selectedPath] = groups;
            else delete copy[selectedPath];
            return copy;
        });
        const tab = next && focusedTab(next);
        if (tab) setActiveTabs(map => ({ ...map, [selectedPath]: tab }));
    };
    /** The layout of the active tab for a change: a new layout with a new pane ID for a tab that is in no split yet. */
    const editableLayout = (): PaneLayout | undefined => (layout && split ? layout : activeTab ? tabLayout([], activeTab) : undefined);

    const focusPane = (leafId: string) => {
        if (layout && split && layout.focused !== leafId && activeTab) commitGroup(activeTab, { ...layout, focused: leafId });
    };
    // A click in a browser page does not reach the pane, because the page is a native view. Its focus event moves the focus.
    const focusBrowserPane = (id: string) => {
        const leaf = layout && leafOfTab(layout, browserTabKey(id));
        if (leaf) focusPane(leaf.id);
    };
    const focusBrowserPaneRef = useRef(focusBrowserPane);
    focusBrowserPaneRef.current = focusBrowserPane;
    useEffect(() => api.browser.onFocus(id => focusBrowserPaneRef.current(id)), []);

    /**
     * Drops a dragged tab at a side of a pane of the active tab. The dragged tab, with all its panes when it is a split,
     * joins the split of the active tab, and leaves the tab strip.
     */
    const dropTab = (dragged: TabKey, leafId: string, side: SplitSide) => {
        const base = editableLayout();
        if (!base || leafOfTab(base, dragged)) return;
        const target = split ? leafId : base.focused;
        const draggedGroup = groupOf(groups, dragged);
        const source = draggedGroup ? draggedGroup.root : tabLayout([], dragged).root;
        commitGroup(activeTab!, insertNode(base, target, source, side, draggedGroup?.focused));
    };

    /** Closes the view of a tab: a terminal stops, a file closes (it asks about unsaved changes), a diff or log closes. */
    const closeTabView = (tab: TabKey) => {
        if (!selectedPath) return;
        if (tab.startsWith('t:')) {
            const session = worktreeSessions.find(item => `t:${item.id}` === tab);
            if (session) void closeSession(session);
        } else if (tab.startsWith('f:')) {
            closeFile(selectedPath, tab.slice(2));
        } else {
            closeExtra(selectedPath, tab);
        }
    };
    /** Closes one pane of a split. The focus goes to another pane of the split first, so the tab stays. */
    const closePaneView = (leafId: string) => {
        const leaf = layout && findLeaf(layout, leafId);
        if (!layout || !leaf || !activeTab) return;
        commitGroup(activeTab, closePane(layout, leafId));
        closeTabView(leaf.tab);
    };
    /** Takes a pane out of the split. Its view becomes a tab of its own, and the active tab. */
    const movePaneToTab = (leafId: string) => {
        const leaf = layout && findLeaf(layout, leafId);
        if (!layout || !leaf || !selectedPath) return;
        commitGroup(leaf.tab, closePane(layout, leafId));
        activate(selectedPath, leaf.tab);
    };
    /** Closes a tab from a button in its view: its pane when it is in a split, else the tab. */
    const closeFromView = (tab: TabKey) => {
        const leaf = layout && split ? leafOfTab(layout, tab) : undefined;
        if (leaf) closePaneView(leaf.id);
        else closeTabView(tab);
    };
    /** Closes a split tab with all its panes. */
    const closeGroup = (group: PaneLayout) => {
        const tabs = leaves(group.root).map(leaf => leaf.tab);
        void confirmDialog({ title: `Close this tab with its ${tabs.length} panes?`, message: 'Its terminals stop.', confirmLabel: 'Close tab', danger: true })
            .then(ok => ok && tabs.forEach(closeTabView));
    };

    /** True when the tab can close: a running agent stops only after the user agrees. */
    const confirmClose = async (tab: TabKey): Promise<boolean> => {
        const session = tab.startsWith('t:') ? worktreeSessions.find(item => `t:${item.id}` === tab) : undefined;
        if (!session?.isAgent || session.exited) return true;
        return confirmDialog({ title: `Close "${session.title}"?`, message: 'The agent stops.', confirmLabel: 'Close', danger: true });
    };

    /**
     * The workspace shortcuts, as in Ghostty. ⌘T: a new shell tab. ⌘W: close the focused pane, or the tab when it has
     * one pane. ⌘D and ⇧⌘D: a new shell pane at the right of, or below, the focused pane. ⌘[ and ⌘]: move the focus.
     */
    const shortcut = async (action: ShortcutAction) => {
        if (dialogOpen()) return;
        if (action === 'toggleSidebar') {
            toggleSidebar();
            return;
        }
        if (action === 'toggleRightPanel') {
            toggleExplorer();
            return;
        }
        if (mainView !== 'worktree' || !selected) return;
        if (action === 'newTab') {
            await startTerminal(selected, 'shell');
            return;
        }
        if (action === 'close') {
            if (!layout || !activeTab || !(await confirmClose(activeTab))) return;
            if (split) closePaneView(layout.focused);
            else closeTabView(activeTab);
            return;
        }
        if (action === 'next' || action === 'previous') {
            if (layout && split && activeTab) commitGroup(activeTab, cycleFocus(layout, action === 'next' ? 1 : -1));
            return;
        }
        try {
            const session = await api.terminals.create({ cwd: selected.path, worktreePath: selected.path, title: 'shell', cols: 120, rows: 32 });
            setSessions(list => [...list, session]);
            const tab = `t:${session.id}`;
            const base = editableLayout();
            if (base && activeTab) {
                commitGroup(activeTab, splitPane(base, base.focused, tab, action));
            } else {
                activate(selected.path, tab);
            }
        } catch (err) {
            setError(errorText(err));
        }
    };
    const shortcutRef = useRef(shortcut);
    shortcutRef.current = shortcut;
    useEffect(() => api.app.onShortcut(action => void shortcutRef.current(action)), []);
    // The same keys in the page, in the capture phase, before a terminal or an editor gets them. The main process
    // normally takes these keys first (before-input-event). This is the second way, when it does not.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const action = shortcutAction({ type: 'keyDown', meta: event.metaKey, shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, key: event.key, code: event.code });
            if (action) {
                event.preventDefault();
                event.stopPropagation();
                void shortcutRef.current(action);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    /**
     * A terminal process ended, for example after "exit". Its pane closes, and the tab when it was its only pane,
     * as in Ghostty. In a split, the focus goes to another pane of the same tab.
     */
    const sessionExited = (id: string) => {
        const session = sessions.find(item => item.id === id);
        if (!session) return;
        const tab = `t:${id}`;
        const leaf = layout && split ? leafOfTab(layout, tab) : undefined;
        if (layout && leaf && activeTab) {
            commitGroup(activeTab, closePane(layout, leaf.id));
        }
        terminalPool.dispose(id);
        agentStateStore.delete(id);
        setSessions(list => list.filter(item => item.id !== id));
        // The host keeps an ended session for its output. The tab is gone, so the host can forget it.
        void api.terminals.kill(id).catch(() => undefined);
    };
    const sessionExitedRef = useRef(sessionExited);
    sessionExitedRef.current = sessionExited;

    // A new active tab can be outside the visible part of the tab strip.
    useEffect(() => {
        document.querySelector('.tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [activeTab]);

    const showSession = (session: TerminalSession) => {
        setSessions(list => list.some(item => item.id === session.id) ? list : [...list, session]);
        if (session.worktreePath) {
            activate(session.worktreePath, `t:${session.id}`);
        }
    };

    /** Returns the repository of a worktree in the active project. */
    const repoOfWorktree = (path: string) => repos.find(repo => worktreesByRepo[repo]?.some(worktree => worktree.path === path));
    /** The name of a repository in the UI: its name from the repository settings, else its folder name. */
    const repoLabel = (repo: string) => repoDisplayName(appSettings, repo);

    /**
     * Starts a session in a worktree. "shell" starts a shell. "agent" shows the agent that runs in the worktree, or
     * starts the repository's agent (its own choice, else the default agent). An agent definition from the "+" menu
     * always starts a new session of that agent.
     */
    const startTerminal = async (worktree: Worktree, target: 'shell' | 'agent' | AgentDefinition): Promise<TerminalSession | undefined> => {
        const agent = target !== 'shell';
        const definition = typeof target === 'object' ? target : agentForRepo(appSettings, repoOfWorktree(worktree.path));
        if (target === 'agent') {
            const running = sessions.find(session => session.worktreePath === worktree.path && session.isAgent && !session.exited);
            if (running) {
                showSession(running);
                return running;
            }
        }
        try {
            const session = await api.terminals.create({
                cwd: worktree.path,
                worktreePath: worktree.path,
                title: agent ? definition.name : 'shell',
                command: agent ? definition.command : undefined,
                isAgent: agent,
                cols: 120,
                rows: 32
            });
            showSession(session);
            return session;
        } catch (err) {
            setError(errorText(err));
            return undefined;
        }
    };

    /**
     * Sends a prompt to the agent of the selected worktree. Starts the agent first if necessary.
     * The prompt goes in as a bracketed paste, so that new lines do not submit it early. Then Enter submits it.
     */
    const sendToAgent = async (prompt: string, worktree: Worktree | undefined = selected) => {
        if (!worktree) {
            return;
        }
        const running = sessions.find(session => session.worktreePath === worktree.path && session.isAgent && !session.exited);
        const session = running ?? await startTerminal(worktree, 'agent');
        if (!session) {
            return;
        }
        showSession(session);
        if (!running) {
            await waitForQuietOutput(session.id);
        }
        if (!await waitForNoDialog(session.id, () => setError('The agent asks a question. Answer it in the agent tab. ShipWarden sends the prompt after that.'))) {
            setError('ShipWarden did not send the prompt, because the agent still shows a question. Answer it and try again.');
            return;
        }
        setError(undefined);
        api.terminals.write(session.id, `\x1b[200~${prompt}\x1b[201~`);
        setTimeout(() => api.terminals.write(session.id, '\r'), 200);
    };

    /**
     * Starts work on a task: creates a worktree with a branch for the task, links the worktree to the task
     * and sends the task to a new agent in the worktree.
     */
    const startTask = async (task: Task, connectionId: string, pluginId: string, repoPath: string) => {
        const branch = branchNameForTask(task);
        const worktree = await api.worktrees.create({ repoPath, branch });
        await prepareWorktree(repoPath, worktree);
        const link: TaskLink = { connectionId, pluginId, taskId: task.id, key: task.key, title: task.title, url: task.url };
        await api.tasks.setLink(worktree.path, link);
        setLinks(map => ({ ...map, [worktree.path]: link }));
        await refreshWorktrees(repoPath);
        setSelectedPath(worktree.path);
        setMainView('worktree');
        void moveTaskToStartStatus(task, connectionId);
        await sendToAgent(taskPrompt(task, branch), worktree);
    };

    /**
     * Moves a task to the start status of its connection (Settings › Task managers), for example "in progress".
     * The worktree and the agent do not wait for it. A failure shows as an error, and the task keeps its status.
     */
    const moveTaskToStartStatus = async (task: Task, connectionId: string) => {
        const projectId = activeProject?.id;
        if (!projectId) return;
        let wanted: string | undefined;
        try {
            wanted = (await api.tasks.connections()).find(item => item.id === connectionId)?.startStatus;
            if (!wanted) return;
            const source = await api.tasks.source(connectionId, projectId);
            await applyStartStatus(task, wanted, source.capabilities,
                <T,>(method: string, params: unknown) => api.tasks.request(connectionId, projectId, method, params) as Promise<T>);
        } catch (err) {
            setError(`${task.key ?? task.title} did not move to "${wanted}": ${errorText(err)}`);
        }
    };

    const sendLogToAgent = async (check: CheckRun) => {
        if (!selectedPath) {
            return;
        }
        try {
            const logPath = await api.github.saveJobLog(selectedPath, check.id);
            await sendToAgent(`The CI job "${check.name}" failed on this branch. The full log is in ${logPath}. Find the cause of the failure and fix it.`);
        } catch (err) {
            setError(errorText(err));
        }
    };

    const closeSession = async (session: TerminalSession) => {
        await api.terminals.kill(session.id);
        terminalPool.dispose(session.id);
        agentStateStore.delete(session.id);
        setSessions(list => list.filter(item => item.id !== session.id));
    };

    const openFile = (path: string, line?: number, column?: number, inRoot?: string) => {
        const root = inRoot ?? selectedPath;
        if (!root) {
            return;
        }
        if (root !== selectedPath) {
            setSelectedPath(root);
        }
        setOpenFiles(map => {
            const list = map[root] ?? [];
            return list.includes(path) ? map : { ...map, [root]: [...list, path] };
        });
        activate(root, `f:${path}`);
        if (line) {
            setReveal({ root, path, line, column, nonce: Date.now() });
        }
    };

    // The language servers need the worktree roots, and "go to definition" opens files through the app.
    useEffect(() => {
        lspBridge.setRoots(worktrees.map(worktree => worktree.path));
    }, [worktrees]);
    lspBridge.setOpener((root, path, line, column) => openFile(path, line, column, root));

    const closeFile = async (root: string, path: string) => {
        if (documents.isDirty(root, path) && !(await confirmDialog({
            title: `"${baseName(path)}" has unsaved changes.`,
            message: 'Close it and lose the changes?',
            confirmLabel: 'Close without saving',
            danger: true
        }))) {
            return;
        }
        documents.close(root, path);
        setDirtyFiles(set => {
            const next = new Set(set);
            next.delete(fileKey(root, path));
            return next;
        });
        setOpenFiles(map => ({ ...map, [root]: (map[root] ?? []).filter(item => item !== path) }));
    };

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
        if (!activeProject || !(await confirmDialog({
            title: `Remove "${repoLabel(repo)}" from the project "${activeProject.name}"?`,
            message: 'The repository and its worktrees stay on disk. Agents in its worktrees continue to run.',
            confirmLabel: 'Remove'
        }))) {
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
            await showProject(state, sessions.map(session => session.id));
        } catch (err) {
            setError(errorText(err));
        }
    };

    /**
     * Shows the tab of an agent from the Agents view. When the agent runs in another project, the sidebar switches
     * to that project first, so the worktree is in the list.
     */
    const openAgent = async (session: TerminalSession, projectId: string | undefined) => {
        if (projectId && projectId !== projects?.activeId) {
            await switchProject(projectId);
        }
        if (session.worktreePath) {
            setSelectedPath(session.worktreePath);
            setActiveTabs(map => ({ ...map, [session.worktreePath!]: `t:${session.id}` }));
        }
        setMainView('worktree');
    };

    /** Runs a project change from the sidebar. A rejected change throws, so the sidebar can show the error. */
    const changeProjects = async (change: Promise<ProjectsState>) => {
        const state = await change;
        const switched = state.activeId !== projects?.activeId;
        setProjects(state);
        if (switched) {
            await showProject(state, sessions.map(session => session.id));
        }
    };

    /**
     * Runs after ShipWarden creates a worktree: reports a failed copy of the ignored files, and starts the setup script
     * of the repository in a "Setup" terminal tab, so the user sees its output.
     */
    const prepareWorktree = async (repoPath: string, worktree: CreatedWorktree) => {
        if (worktree.copyError) {
            setError(`ShipWarden did not copy the ignored files into the new worktree: ${worktree.copyError}`);
        }
        const script = appSettings.repos[repoPath]?.worktrees?.setupScript;
        if (!script) return;
        try {
            const session = await api.terminals.create({
                cwd: worktree.path,
                worktreePath: worktree.path,
                title: 'Setup',
                command: setupCommand(script, { rootPath: repoPath, worktreePath: worktree.path, branch: worktree.branch, repoName: repoPath.split('/').filter(Boolean).pop() ?? repoPath }),
                cols: 120,
                rows: 32
            });
            showSession(session);
        } catch (err) {
            setError(`The setup script did not start: ${errorText(err)}`);
        }
    };

    /** Sets or removes (with an empty name) the display name of a worktree. */
    const setWorktreeName = async (path: string, name: string | undefined) => {
        const names = { ...(appSettings.worktreeNames ?? {}) };
        if (name) names[path] = name;
        else delete names[path];
        setAppSettings(await api.settings.update({ worktreeNames: names }));
    };

    /** Creates a worktree from the New worktree dialog: its branch, start point, display name and agent. */
    const createWorktree = async (repoPath: string, request: NewWorktreeRequest) => {
        const worktree = await api.worktrees.create({
            repoPath,
            branch: request.branch,
            ...(request.baseRef ? { baseRef: request.baseRef } : {}),
            ...(request.trackRef ? { trackRef: request.trackRef } : {})
        });
        if (request.name) await setWorktreeName(worktree.path, request.name);
        await refreshWorktrees(repoPath);
        setSelectedPath(worktree.path);
        await prepareWorktree(repoPath, worktree);
        if (request.startAgent) await startTerminal(worktree, 'agent');
    };

    const renameWorktree = async (worktree: Worktree) => {
        const name = await promptDialog({
            title: 'Rename the worktree',
            message: `The sidebar shows this name. The branch "${worktree.branch ?? worktree.head.slice(0, 7)}" does not change. An empty name shows the branch again.`,
            value: appSettings.worktreeNames?.[worktree.path] ?? '',
            placeholder: worktree.branch ?? 'Name',
            confirmLabel: 'Rename'
        });
        if (name === undefined) return;
        try {
            await setWorktreeName(worktree.path, name);
        } catch (err) {
            setError(errorText(err));
        }
    };

    /**
     * Removes a worktree. With `deleteBranch`, the local branch is deleted after the worktree. Git refuses a branch with
     * commits that are not merged, so ShipWarden asks before it forces the delete. The remote branch stays.
     */
    const removeWorktree = async (repoPath: string, worktree: Worktree, options: { deleteBranch?: boolean } = {}) => {
        const name = appSettings.worktreeNames?.[worktree.path] ?? worktree.branch ?? worktree.path;
        const branch = options.deleteBranch ? worktree.branch : undefined;
        const teardown = appSettings.repos[repoPath]?.worktrees?.teardownScript ? ' The teardown script of the repository runs first.' : '';
        const branchText = branch ? `Git then deletes the local branch "${branch}". The remote branch stays.` : 'Git keeps the branch.';
        if (!(await confirmDialog({
            title: `Remove the worktree "${name}"?`,
            message: `${branchText} Uncommitted changes stop the removal. The terminals, editors and running processes of this worktree stop.${teardown}`,
            confirmLabel: branch ? 'Remove and delete branch' : 'Remove worktree',
            danger: true
        }))) {
            return;
        }
        try {
            const result = await api.worktrees.remove(repoPath, worktree.path);
            if (result.teardownFailed) {
                const failure = result.teardownFailed;
                const reason = failure.timedOut ? 'did not finish in 5 minutes' : `failed with exit code ${failure.code}`;
                const tail = failure.output.split('\n').slice(-15).join('\n');
                if (!(await confirmDialog({
                    title: `The teardown script ${reason}.`,
                    message: 'Remove the worktree anyway?',
                    detail: tail,
                    confirmLabel: 'Remove anyway',
                    danger: true
                }))) {
                    return;
                }
                await api.worktrees.remove(repoPath, worktree.path, { skipTeardown: true });
            }
            sessions.filter(session => session.worktreePath === worktree.path).forEach(session => {
                terminalPool.dispose(session.id);
                agentStateStore.delete(session.id);
            });
            setSessions(list => list.filter(session => session.worktreePath !== worktree.path));
            (openFiles[worktree.path] ?? []).forEach(path => documents.close(worktree.path, path));
            setExtraTabs(map => {
                const next = { ...map };
                delete next[worktree.path];
                return next;
            });
            if (links[worktree.path]) {
                await api.tasks.setLink(worktree.path, null);
                setLinks(map => {
                    const next = { ...map };
                    delete next[worktree.path];
                    return next;
                });
            }
            setOpenFiles(map => {
                const next = { ...map };
                delete next[worktree.path];
                return next;
            });
            if (appSettings.worktreeNames?.[worktree.path]) await setWorktreeName(worktree.path, undefined);
            const list = await refreshWorktrees(repoPath);
            if (selectedPath === worktree.path) {
                setSelectedPath(list[0]?.path ?? worktrees.find(item => item.path !== worktree.path)?.path);
            }
            if (branch) {
                const deleted = await api.worktrees.deleteBranch(repoPath, branch);
                if (deleted.notMerged && await confirmDialog({
                    title: `The branch "${branch}" has commits that are not merged into another branch.`,
                    message: 'Delete the branch anyway? The commits are then lost, unless the remote branch has them.',
                    confirmLabel: 'Delete branch',
                    danger: true
                })) {
                    await api.worktrees.deleteBranch(repoPath, branch, true);
                }
            }
        } catch (err) {
            setError(errorText(err));
        }
    };

    /** Runs a saved script of a repository in a new terminal tab of a worktree, with the variables of the setup script. */
    const runScript = async (repoPath: string, worktree: Worktree, script: RepoScript) => {
        try {
            const session = await api.terminals.create({
                cwd: worktree.path,
                worktreePath: worktree.path,
                title: script.name,
                command: setupCommand(script.command, { rootPath: repoPath, worktreePath: worktree.path, branch: worktree.branch, repoName: repoPath.split('/').filter(Boolean).pop() ?? repoPath }),
                cols: 120,
                rows: 32
            });
            showSession(session);
        } catch (err) {
            setError(`The script "${script.name}" did not start: ${errorText(err)}`);
        }
    };
    /**
     * Runs the install command of a missing language server in a new terminal tab of the worktree.
     * ShipWarden then looks for the server, and starts it when the install completes.
     */
    const installServer = async (worktreePath: string, server: LspMissingServer) => {
        if (!server.installCommand) return;
        try {
            const session = await api.terminals.create({
                cwd: worktreePath,
                worktreePath,
                title: `Install ${server.name}`,
                command: server.installCommand,
                cols: 120,
                rows: 32
            });
            showSession(session);
            void lspBridge.watchInstall(server.serverId);
        } catch (err) {
            setError(`The install of ${server.name} did not start: ${errorText(err)}`);
        }
    };
    /** Saves the scripts of a repository. An empty list removes the scripts from its settings. */
    const saveScripts = async (repoPath: string, scripts: RepoScript[]) => {
        const { scripts: _old, ...rest } = appSettings.repos[repoPath] ?? {};
        const next = scripts.length > 0 ? { ...rest, scripts } : rest;
        const repos = { ...appSettings.repos };
        if (Object.keys(next).length > 0) repos[repoPath] = next;
        else delete repos[repoPath];
        setAppSettings(await api.settings.update({ repos }));
    };

    /** Opens the task of a worktree in the Tasks view, with the task manager of the task selected. */
    const openLinkedTask = (worktreePath: string) => {
        const link = links[worktreePath];
        if (!link) return;
        setTaskOpen({ connectionId: link.connectionId ?? link.pluginId, taskId: link.taskId, nonce: Date.now() });
        setMainView('tasks');
    };

    /** The context menu of a worktree in the sidebar. */
    const worktreeMenu = async (repoPath: string, worktree: Worktree) => {
        const link = links[worktree.path];
        const choice = await api.app.contextMenu([
            ...(link ? [{ id: 'task', label: `Open Task${link.key ? ` ${link.key}` : ''}` }, { type: 'separator' as const }] : []),
            { id: 'rename', label: 'Rename…' },
            { type: 'separator' as const },
            { id: 'remove', label: 'Remove Worktree…', enabled: !worktree.isMain },
            { id: 'removeBranch', label: worktree.branch ? `Remove Worktree and Delete Branch "${worktree.branch}"…` : 'Remove Worktree and Delete Branch…', enabled: !worktree.isMain && !!worktree.branch }
        ]);
        if (choice === 'task') openLinkedTask(worktree.path);
        if (choice === 'rename') await renameWorktree(worktree);
        if (choice === 'remove') await removeWorktree(repoPath, worktree);
        if (choice === 'removeBranch') await removeWorktree(repoPath, worktree, { deleteBranch: true });
    };

    /** The view of one tab: a diff, a CI log, a file or a terminal. `focused` is false for a pane without the focus. */
    const renderTab = (tab: TabKey, focused: boolean): ReactNode => {
        if (!selectedPath) return null;
        const extra = worktreeExtras.find(item => item.key === tab);
        if (extra?.kind === 'browser') {
            return <BrowserView key={extra.id} id={extra.id} hidden={!!draggingTab} focused={focused} onClose={() => closeFromView(extra.key)} />;
        }
        if (extra?.kind === 'change') {
            return (
                <ChangeDiffView
                    key={`${selectedPath}\0${extra.key}`}
                    worktree={selectedPath}
                    change={extra.change}
                    side={extra.side}
                    onOpenFile={path => openFile(path)}
                />
            );
        }
        if (extra) {
            return extra.kind === 'diff' ? (
                <DiffView
                    key={`${selectedPath}\0${extra.key}`}
                    target={selectedPath}
                    pr={latestPullRequest(extra.pr)}
                    file={extra.file}
                    revealLine={extra.line}
                    revealNonce={extra.nonce}
                    onRefresh={github.refresh}
                    onSendToAgent={sendToAgent}
                />
            ) : (
                <LogView key={`${selectedPath}\0${extra.key}`} target={selectedPath} check={extra.check} onSendToAgent={sendLogToAgent} />
            );
        }
        if (tab.startsWith('f:')) {
            const path = tab.slice(2);
            const revealHere = reveal && reveal.root === selectedPath && reveal.path === path;
            return (
                <EditorView
                    key={`${selectedPath}\0${path}`}
                    root={selectedPath}
                    path={path}
                    revealLine={revealHere ? reveal.line : undefined}
                    revealColumn={revealHere ? reveal.column : undefined}
                    revealNonce={reveal?.nonce}
                    onError={setError}
                    onInstallServer={server => void installServer(selectedPath, server)}
                />
            );
        }
        const session = worktreeSessions.find(item => `t:${item.id}` === tab);
        return session && settings
            ? <TerminalView key={`${session.id}:${terminalColorsKey}`} session={session} settings={terminalSettings ?? settings} focused={focused} />
            : null;
    };

    /** The pane side that is nearest to the pointer. The dropped tab goes to that side. */
    const dropSide = (event: React.DragEvent<HTMLElement>): SplitSide => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        const edges: [SplitSide, number][] = [['left', x], ['right', 1 - x], ['up', y], ['down', 1 - y]];
        return edges.reduce((best, item) => (item[1] < best[1] ? item : best))[0];
    };

    /** Shows a node of the split view: a pane with its tab, or a split with a divider between its two parts. */
    const renderPane = (node: PaneNode): ReactNode => {
        if (node.kind === 'split') {
            return (
                <div key={node.id} className={`pane-split ${node.direction}`}>
                    <div className="pane-slot" style={{ flexBasis: `${node.ratio * 100}%` }}>{renderPane(node.first)}</div>
                    <SplitDivider direction={node.direction} onResize={ratio => layout && activeTab && commitGroup(activeTab, resizeSplit(layout, node.id, ratio))} />
                    <div className="pane-slot" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>{renderPane(node.second)}</div>
                </div>
            );
        }
        const focused = !split || layout?.focused === node.id;
        const target = dropTarget?.leafId === node.id ? dropTarget.side : undefined;
        return (
            <div key={node.id} className={`pane${split ? (focused ? ' focused' : ' unfocused') : ''}`} onMouseDownCapture={() => focusPane(node.id)}>
                {renderTab(node.tab, focused)}
                {split && (
                    <div className="pane-actions">
                        <span className="pane-title">{tabInfo(node.tab).title}</span>
                        <button className="icon-button" title="Move to its own tab" onClick={() => movePaneToTab(node.id)}>
                            <SquareArrowOutUpRight size={13} strokeWidth={1.7} />
                        </button>
                        <button className="icon-button" title="Close this pane" onClick={() => closePaneView(node.id)}>
                            <X size={13} strokeWidth={1.8} />
                        </button>
                    </div>
                )}
                {draggingTab && layout && !leafOfTab(layout, draggingTab) && (
                    // A layer over the pane takes the drag events, so the editor or the terminal below does not take the drop.
                    <div
                        className="pane-drop-layer"
                        onDragOver={event => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            const side = dropSide(event);
                            if (target !== side) setDropTarget({ leafId: node.id, side });
                        }}
                        onDragLeave={() => setDropTarget(current => (current?.leafId === node.id ? undefined : current))}
                        onDrop={event => {
                            event.preventDefault();
                            dropTab(draggingTab, node.id, dropSide(event));
                            setDraggingTab(undefined);
                            setDropTarget(undefined);
                        }}
                    >
                        {target && <div className={`pane-drop-zone ${target}`} />}
                    </div>
                )}
            </div>
        );
    };

    /** The drag start of a tab. The tab can go to a side of a pane (a split) or into a pane. */
    const tabDragProps = (key: TabKey) => ({
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
            event.dataTransfer.setData('text/plain', key);
            event.dataTransfer.effectAllowed = 'move';
            setDraggingTab(key);
        },
        onDragEnd: () => {
            setDraggingTab(undefined);
            setDropTarget(undefined);
        }
    });
    /** The icon, the title and the state of a tab, for the tab strip and the pane buttons. */
    const tabInfo = (key: TabKey): { icon: ReactNode; title: string; tooltip?: string; dirty?: boolean; exited?: boolean } => {
        if (key.startsWith('t:')) {
            const session = worktreeSessions.find(item => `t:${item.id}` === key);
            return { icon: <SquareTerminal className="tab-icon" size={14} strokeWidth={1.5} />, title: session?.title ?? 'terminal', exited: session?.exited };
        }
        if (key.startsWith('f:')) {
            const path = key.slice(2);
            const Icon = fileIcon(baseName(path));
            return { icon: <Icon className="tab-icon" size={14} strokeWidth={1.5} />, title: baseName(path), tooltip: path, dirty: !!selectedPath && dirtyFiles.has(fileKey(selectedPath, path)) };
        }
        const extra = worktreeExtras.find(item => item.key === key);
        if (extra?.kind === 'browser') {
            const state = browserStates.get(extra.id);
            return { icon: <Globe className="tab-icon" size={14} strokeWidth={1.5} />, title: browserTabTitle(state), tooltip: state?.url && state.url !== BLANK_PAGE ? state.url : undefined };
        }
        if (extra?.kind === 'change') {
            return {
                icon: <GitCompareArrows className="tab-icon" size={14} strokeWidth={1.5} />,
                title: baseName(extra.change.path),
                tooltip: `${extra.side === 'staged' ? 'Staged changes' : 'Changes'} in ${extra.change.path}`
            };
        }
        return extra?.kind === 'diff'
            ? { icon: <FileDiff className="tab-icon" size={14} strokeWidth={1.5} />, title: baseName(extra.file.path), tooltip: `Changes in ${extra.file.path}` }
            : { icon: <ScrollText className="tab-icon" size={14} strokeWidth={1.5} />, title: extra?.check.name ?? 'log', tooltip: extra ? `Log of ${extra.check.name}` : undefined };
    };

    /**
     * The entries of the tab strip, in the order of the tabs: a tab, or a split tab at the place of its first pane.
     * A split tab shows the title of its focused pane.
     */
    const stripItems: { key: TabKey; group?: PaneLayout }[] = [];
    for (const key of tabKeys) {
        const group = groupOf(groups, key);
        if (!group) {
            stripItems.push({ key });
        } else if (!stripItems.some(item => item.group === group)) {
            const shown = leafOfTab(group, activeTab ?? '') ? activeTab! : focusedTab(group) ?? key;
            stripItems.push({ key: shown, group });
        }
    }

    return (
        <SidebarContext.Provider value={{ collapsed: sidebarCollapsed, toggle: toggleSidebar }}>
        <div className="app-shell">
            <div
                className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}${mainView === 'worktree' && selectedPath ? ' has-right-toggle' : ''}${rightPanelShown ? ' right-panel-shown' : ''}`}
                style={{ '--sidebar-width': `${sidebarWidth.width}px`, '--explorer-width': `${explorerWidth.width}px` } as CSSProperties}
            >
                {!sidebarCollapsed && <Sidebar
                    projects={projects}
                    repos={repos}
                    worktreesByRepo={worktreesByRepo}
                    sessions={sessions}
                    selectedPath={selectedPath}
                    links={links}
                    summaries={summaries}
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
                    onOpenReview={() => setMainView('review')}
                    pipelinesActive={mainView === 'pipelines'}
                    onOpenPipelines={() => setMainView('pipelines')}
                    notesActive={mainView === 'notes'}
                    onOpenNotes={() => setMainView('notes')}
                    dashboardActive={mainView === 'dashboard'}
                    dashboardCount={dashboardCount}
                    onOpenDashboard={() => setMainView('dashboard')}
                    onAddRepo={addRepo}
                    onRemoveRepo={removeRepo}
                    onSwitchProject={switchProject}
                    onCreateProject={(name: string) => changeProjects(api.projects.create(name))}
                    onRenameProject={(id: string, name: string) => changeProjects(api.projects.rename(id, name))}
                    onDeleteProject={(id: string) => changeProjects(api.projects.delete(id))}
                    onSelect={worktree => {
                        setSelectedPath(worktree.path);
                        setMainView('worktree');
                    }}
                    onCreate={createWorktree}
                    worktreeNames={appSettings.worktreeNames}
                    onRemove={(repo, worktree) => removeWorktree(repo, worktree)}
                    onWorktreeMenu={worktreeMenu}
                    onOpenTask={openLinkedTask}
                    worktreeSort={appSettings.worktreeSort}
                    onChangeWorktreeSort={sort => {
                        setAppSettings(current => ({ ...current, worktreeSort: sort }));
                        api.settings.update({ worktreeSort: sort }).then(setAppSettings, err => setError(errorText(err)));
                    }}
                    onMoveProject={(id, toIndex) => {
                        api.projects.move(id, toIndex).then(setProjects, err => setError(errorText(err)));
                    }}
                    onMoveRepo={(repo, toIndex) => {
                        if (activeProject) {
                            api.projects.moveRepo(activeProject.id, repo, toIndex).then(setProjects, err => setError(errorText(err)));
                        }
                    }}
                />}
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
                            onStartTask={startTask}
                            onOpenSettings={() => openSettings('tasks')}
                            openTask={taskOpen}
                            repoLabel={repoLabel}
                            onOpenWorktree={path => {
                                setSelectedPath(path);
                                setMainView('worktree');
                            }}
                        />
                    </main>
                )}
                {mainView === 'review' && (
                    <main className="workspace">
                        <ReviewView owners={appSettings.reviewOwners} onOpenSettings={() => openSettings('review')} open={reviewOpen} />
                    </main>
                )}
                {mainView === 'pipelines' && (
                    <main className="workspace">
                        <PipelinesView owners={appSettings.reviewOwners} onOpenSettings={() => openSettings('review')} />
                    </main>
                )}
                {mainView === 'graph' && graphRepo && (
                    <main className="workspace">
                        <GitGraphView
                            repo={worktreesByRepo[graphRepo]?.find(worktree => worktree.isMain)?.path ?? graphRepo}
                            repoName={repoLabel(graphRepo)}
                            worktrees={worktreesByRepo[graphRepo] ?? []}
                            onNewWorktree={start => setGraphWorktree({ repo: graphRepo, start })}
                            onOpenWorktree={worktree => {
                                setSelectedPath(worktree.path);
                                setMainView('worktree');
                            }}
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
                        <AgentsView sessions={sessions} projects={projects} links={links} repoLabel={repoLabel} repoColor={repo => appSettings.repos[repo]?.color} onOpen={openAgent} />
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
                        <div
                            className="tabs"
                            onWheel={event => {
                                // The strip has no scroll bar. A mouse wheel scrolls vertically, so turn that into a sideways scroll.
                                if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                                    event.currentTarget.scrollLeft += event.deltaY;
                                }
                            }}
                        >
                            {stripItems.map(({ key, group }) => {
                                const info = tabInfo(key);
                                const count = group ? leaves(group.root).length : 1;
                                const active = group ? !!activeTab && !!leafOfTab(group, activeTab) : key === activeTab;
                                return (
                                    <div
                                        key={group ? group.root.id : key}
                                        className={`tab${active ? ' active' : ''}${info.dirty ? ' dirty' : ''}${info.exited ? ' exited' : ''}${group ? ' split-tab' : ''}`}
                                        title={group ? `${count} panes: ${leaves(group.root).map(leaf => tabInfo(leaf.tab).title).join(', ')}` : info.tooltip}
                                        onClick={() => selectedPath && activate(selectedPath, key)}
                                        {...tabDragProps(key)}
                                    >
                                        {group ? <Columns2 className="tab-icon" size={14} strokeWidth={1.5} /> : info.icon}
                                        <span className="tab-title">{info.title}</span>
                                        {group && <span className="tab-count">{count}</span>}
                                        <button
                                            className="tab-close"
                                            title={group ? 'Close the tab and all its panes' : info.dirty ? 'Unsaved changes. Close file.' : 'Close'}
                                            onClick={event => {
                                                event.stopPropagation();
                                                if (group) closeGroup(group);
                                                else closeTabView(key);
                                            }}
                                        >
                                            <span className="tab-dirty-dot" />
                                            <X size={13} strokeWidth={1.75} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                        {/* The "+" sits right after the last tab. It is outside the tab strip, which scrolls and would cut off the menu. */}
                        {selected && (
                            <div className="tab-strip-actions">
                                <NewTabMenu
                                    agents={appSettings.agents}
                                    defaultAgentId={agentForRepo(appSettings, selectedRepo).id}
                                    onStart={target => (target === 'browser' ? void openBrowser(BLANK_PAGE, selected.path) : startTerminal(selected, target))}
                                />
                            </div>
                        )}
                        <div className="header-spacer" />
                        {selectedPath && links[selectedPath] && (
                            <button className="task-chip" title={`Open the task: ${links[selectedPath].title}`} onClick={() => openLinkedTask(selectedPath)}>
                                <ListTodo size={13} strokeWidth={1.7} />
                                <span>{links[selectedPath].key ?? links[selectedPath].title}</span>
                            </button>
                        )}
                        <div className="header-actions">
                            {selected && selectedRepo && (
                                <ScriptsMenu
                                    repoName={repoLabel(selectedRepo)}
                                    scripts={appSettings.repos[selectedRepo]?.scripts ?? []}
                                    onRun={script => void runScript(selectedRepo, selected, script)}
                                    onSave={scripts => saveScripts(selectedRepo, scripts)}
                                />
                            )}
                        </div>
                    </header>

                    {error && (
                        <div className="error-banner" onClick={() => setError(undefined)} title="Click to close">{error}</div>
                    )}

                    <section className={`terminal-area${draggingTab ? ' dragging-tab' : ''}`}>
                        {layout ? renderPane(layout.root) : (
                            <div className="empty-state">
                                {repos.length === 0 && (
                                    <>
                                        <div className="empty-title">{activeProject ? `${activeProject.name} has no repositories` : 'Loading…'}</div>
                                        {activeProject && <button className="button primary" onClick={addRepo}>Add a repository</button>}
                                    </>
                                )}
                                {repos.length > 0 && selected && (
                                    <>
                                        <div className="empty-title">{selected.branch ?? selected.path}</div>
                                        <div className="empty-detail">{selected.path}</div>
                                        <button className="button primary" onClick={() => startTerminal(selected, 'agent')}>Start {agentForRepo(appSettings, selectedRepo).name}</button>
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
                        activeFile={activeFile}
                        github={github}
                        onOpenFile={(path, line) => openFile(path, line)}
                        onOpenDiff={openDiff}
                        onOpenLog={openLog}
                        onSendToAgent={sendToAgent}
                        onSendLogToAgent={sendLogToAgent}
                        onShowTerminal={id => activate(selectedPath, `t:${id}`)}
                        onOpenChange={openChange}
                    />
                )}
                {graphWorktree && (
                    <NewWorktreeDialog
                        repoName={repoLabel(graphWorktree.repo)}
                        repoPath={graphWorktree.repo}
                        {...('remote' in graphWorktree.start
                            ? { initialRemote: graphWorktree.start.remote }
                            : { initialBase: { ref: graphWorktree.start.commit, label: graphWorktree.start.label } })}
                        onClose={() => setGraphWorktree(undefined)}
                        onCreate={async request => {
                            await createWorktree(graphWorktree.repo, request);
                            setGraphWorktree(undefined);
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
                        title={explorerOpen ? 'Hide the right panel (⌥⌘B)' : 'Show the right panel (⌥⌘B)'}
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
