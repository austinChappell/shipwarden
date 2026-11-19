import { createContext, useContext } from 'react';
import type { PullRequestRef } from '@shared/item-relations';
import type { TaskLink } from '@shared/tasks';

/** Opens the items of ShipWarden in their views. App gives it to all views. */
export interface Navigator {
    /** Opens a plan in the Plans view. A plan of another project switches the project first. */
    openPlan(id: string): void;
    /** Opens a PR group in the Review view. */
    openGroup(id: string): void;
    /** Opens a pull request in the Review view. Without a review provider, the pull request opens in the browser. */
    openPullRequest(pr: PullRequestRef): void;
    /** Opens a task in the Tasks view. */
    openTask(link: TaskLink): void;
    /** Opens a worktree in the worktree view. */
    openWorktree(path: string): void;
}

export const NavigationContext = createContext<Navigator | undefined>(undefined);

/** The navigator of App. It is undefined outside App, for example in a test. */
export function useNavigation(): Navigator | undefined {
    return useContext(NavigationContext);
}
