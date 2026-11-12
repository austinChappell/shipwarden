import type { NavLocation, ViewRoute } from '@shared/nav-history';
import type { ViewAction } from '@shared/shortcuts';

/** A view of the center area. */
export type MainView =
    | 'dashboard'
    | 'worktree'
    | 'tasks'
    | 'agents'
    | 'review'
    | 'pipelines'
    | 'notes'
    | 'automations'
    | 'plans'
    | 'terminal'
    | 'graph'
    | 'settings'
    | 'welcome';

/** A view that is not the settings page. The settings page goes back to one of these views. */
export type ContentView = Exclude<MainView, 'settings'>;

/** The view that each view key (⌥⌘1 to ⌥⌘7) opens. */
export const VIEW_OF_ACTION: Record<ViewAction, 'dashboard' | 'agents' | 'tasks' | 'review' | 'pipelines' | 'notes' | 'automations'> = {
    viewDashboard: 'dashboard',
    viewAgents: 'agents',
    viewTasks: 'tasks',
    viewReview: 'review',
    viewPipelines: 'pipelines',
    viewNotes: 'notes',
    viewAutomations: 'automations'
};

/**
 * Returns the view that the saved layout keeps. The settings page saves the view below it.
 * The graph page is not saved, because its repository is not in the layout. The worktree view goes in its place.
 * The welcome page is not saved. The onboarding state decides if it shows at the start. The Dashboard goes in its place.
 */
export function viewToSave(mainView: MainView, viewBeforeSettings: ContentView): Exclude<ContentView, 'graph' | 'welcome'> {
    const view = mainView === 'settings' ? viewBeforeSettings : mainView;
    if (view === 'welcome') return 'dashboard';
    return view === 'graph' ? 'worktree' : view;
}

/**
 * Returns the view after a switch to another project. The current view stays.
 * The graph page shows a repository of the old project. Thus the worktree view of the new project goes in its place.
 */
export function viewAfterProjectSwitch(view: MainView): MainView {
    return view === 'graph' ? 'worktree' : view;
}

/**
 * Returns the history entry of the current place in the app. Each section of the settings page is a page. The worktree view has an entry only when a worktree is selected. `route` is the page and the query of the current view.
 * In the Terminal view, `selectedPath` is the home folder, because the Terminal view keeps its tabs under the home folder.
 */
export function navLocationOf(
    mainView: MainView,
    selectedPath: string | undefined,
    activeTab: string | undefined,
    graphRepo: string | undefined,
    route: ViewRoute = {}
): NavLocation | undefined {
    if (mainView === 'settings') return { view: mainView, page: route.page };
    if (mainView === 'worktree') return selectedPath ? { view: mainView, worktree: selectedPath, tab: activeTab, query: route.query } : undefined;
    if (mainView === 'terminal') return selectedPath ? { view: mainView, worktree: selectedPath, tab: activeTab } : { view: mainView };
    if (mainView === 'graph') return { view: mainView, repo: graphRepo };
    return { view: mainView, page: route.page, query: route.query };
}

/**
 * True when a history entry is valid. An entry is not valid when its worktree, its tab or its repository
 * does not exist now. `tabsOf` returns the tab keys of a worktree. An entry of the Terminal view is not valid when its tab closed.
 */
export function isNavValid(location: NavLocation, repos: readonly string[], worktreePaths: readonly string[], tabsOf: (worktree: string) => string[]): boolean {
    if (location.view === 'graph') return !!location.repo && repos.includes(location.repo);
    if (location.view === 'terminal') return !location.tab || !location.worktree || tabsOf(location.worktree).includes(location.tab);
    if (location.view !== 'worktree') return true;
    if (!location.worktree || !worktreePaths.includes(location.worktree)) return false;
    return !location.tab || tabsOf(location.worktree).includes(location.tab);
}
