import type { NavLocation } from '@shared/nav-history';
import type { ViewAction } from '@shared/shortcuts';

/** A view of the center area. */
export type MainView = 'dashboard' | 'worktree' | 'tasks' | 'agents' | 'review' | 'pipelines' | 'notes' | 'graph' | 'settings';

/** A view that is not the settings page. The settings page goes back to one of these views. */
export type ContentView = Exclude<MainView, 'settings'>;

/** The view that each view key (⌥⌘1 to ⌥⌘6) opens. */
export const VIEW_OF_ACTION: Record<ViewAction, 'dashboard' | 'agents' | 'tasks' | 'review' | 'pipelines' | 'notes'> = {
    viewDashboard: 'dashboard',
    viewAgents: 'agents',
    viewTasks: 'tasks',
    viewReview: 'review',
    viewPipelines: 'pipelines',
    viewNotes: 'notes'
};

/**
 * Returns the view that the saved layout keeps. The settings page saves the view below it.
 * The graph page is not saved, because its repository is not in the layout. The worktree view goes in its place.
 */
export function viewToSave(mainView: MainView, viewBeforeSettings: ContentView): Exclude<ContentView, 'graph'> {
    const view = mainView === 'settings' ? viewBeforeSettings : mainView;
    return view === 'graph' ? 'worktree' : view;
}

/**
 * Returns the history entry of the current place in the app. The settings page has no entry.
 * The worktree view has an entry only when a worktree is selected.
 */
export function navLocationOf(
    mainView: MainView,
    selectedPath: string | undefined,
    activeTab: string | undefined,
    graphRepo: string | undefined
): NavLocation | undefined {
    if (mainView === 'settings') return undefined;
    if (mainView === 'worktree') return selectedPath ? { view: mainView, worktree: selectedPath, tab: activeTab } : undefined;
    if (mainView === 'graph') return { view: mainView, repo: graphRepo };
    return { view: mainView };
}

/**
 * True when a history entry is valid. An entry is not valid when its worktree, its tab or its repository
 * does not exist now. `tabsOf` returns the tab keys of a worktree.
 */
export function isNavValid(location: NavLocation, repos: readonly string[], worktreePaths: readonly string[], tabsOf: (worktree: string) => string[]): boolean {
    if (location.view === 'graph') return !!location.repo && repos.includes(location.repo);
    if (location.view !== 'worktree') return true;
    if (!location.worktree || !worktreePaths.includes(location.worktree)) return false;
    return !location.tab || tabsOf(location.worktree).includes(location.tab);
}
