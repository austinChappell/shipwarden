import type { OnboardingSettings } from './onboarding';

/**
 * The version of the tour. Change it when the steps change a lot. A user whose `tourSeen` is lower gets the offer
 * again.
 */
export const TOUR_VERSION = 1;

/** The part of the window that a step needs on the screen. The tour opens it before the step shows. */
export type TourNeed = 'sidebar' | 'worktree' | 'rightPanel';

export interface TourStep {
    id: string;
    title: string;
    body: string;
    /** The value of the `data-tour` attribute of the element that the callout points at. */
    target?: string;
    /** The part of the window that the tour opens first. */
    needs?: TourNeed;
}

/** The steps of the tour, in order. Each target is an element with `data-tour="<target>"`. */
export const TOUR_STEPS: readonly TourStep[] = [
    {
        id: 'sidebar',
        title: 'Projects, repositories and worktrees',
        body: 'The sidebar shows the repositories of the active project and their worktrees. Each worktree has its own folder and branch. Press ⌘N to create a worktree. Press ⌘B to show or hide the sidebar.',
        target: 'sidebar',
        needs: 'sidebar'
    },
    {
        id: 'agent',
        title: 'Start an agent',
        body: 'The + button starts your default agent or a shell in the selected worktree. A worktree without tabs also shows a button that starts the agent.',
        target: 'agent',
        needs: 'worktree'
    },
    {
        id: 'tabs',
        title: 'Tabs and splits',
        body: 'Each worktree has its own tabs for agents, shells, files and web pages. Press ⌘T for a new shell tab. Press ⌘D or ⇧⌘D to split a pane, as in Ghostty.',
        target: 'tabs',
        needs: 'worktree'
    },
    {
        id: 'rightPanel',
        title: 'The right panel',
        body: 'Press ⌘E to show or hide the right panel. It shows the files, the local changes, the pull request, the CI checks and the processes of the worktree.',
        target: 'rightPanel',
        needs: 'rightPanel'
    },
    {
        id: 'agents',
        title: 'All your agents',
        body: 'The Agents view (⌥⌘2) shows all agents and their state. “Needs input” means that the agent waits for you.',
        target: 'agents',
        needs: 'sidebar'
    },
    {
        id: 'tasks',
        title: 'Tasks',
        body: 'The Tasks view (⌥⌘3) shows the tasks of your task tracker. “Start in worktree” creates a branch for a task and gives the task to a new agent. Connect a tracker in Settings › Task managers.',
        target: 'tasks',
        needs: 'sidebar'
    },
    {
        id: 'review',
        title: 'Review and Dashboard',
        body: 'The Review view (⌥⌘4) shows the pull requests that wait for your review. The Dashboard (⌥⌘1) shows your pull requests, the review requests and new comments.',
        target: 'review',
        needs: 'sidebar'
    },
    {
        id: 'quit',
        title: 'Agents continue to run',
        body: '⌘Q quits ShipWarden, but your agents continue to run. The next start shows them again. ⇧⌥⌘Q quits and stops all agents. Help › Take the Tour shows this tour again.'
    }
];

/** A key or a button of the tour. */
export type TourInput = 'next' | 'back' | 'close';

/** The result of an input: the index of the new step, or "close" when the tour ends. */
export type TourResult = number | 'close';

/** Returns the step after an input. "next" on the last step ends the tour. "back" on the first step stays. */
export function tourStep(index: number, count: number, input: TourInput): TourResult {
    if (input === 'close') return 'close';
    if (input === 'back') return Math.max(0, index - 1);
    return index + 1 >= count ? 'close' : index + 1;
}

/** Returns the input of a key: → and Enter go to the next step, ← goes back, Escape closes the tour. */
export function tourKey(key: string): TourInput | undefined {
    if (key === 'ArrowRight' || key === 'Enter') return 'next';
    if (key === 'ArrowLeft') return 'back';
    if (key === 'Escape') return 'close';
    return undefined;
}

/** Returns true when the app offers the tour: the welcome page is done or skipped, and the user has not seen this tour version. */
export function shouldOfferTour(onboarding: OnboardingSettings | undefined, welcomeShows: boolean): boolean {
    if (!onboarding || welcomeShows || onboarding.welcome === 'new') return false;
    return (onboarding.tourSeen ?? 0) < TOUR_VERSION;
}

export interface Rect {
    top: number;
    left: number;
    width: number;
    height: number;
}

export interface Size {
    width: number;
    height: number;
}

export type CalloutPlacement = 'right' | 'left' | 'below' | 'above' | 'center';

export interface CalloutPosition {
    top: number;
    left: number;
    placement: CalloutPlacement;
}

/** The space between the target and the callout, and between the callout and the window border. */
const GAP = 12;
const MARGIN = 12;

/** Keeps a value between a minimum and a maximum. When the range is empty, the minimum wins. */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max));
}

/** Returns true when a target is on the screen: it has a size and a part of it is in the window. */
export function isOnScreen(target: Rect | undefined, viewport: Size): target is Rect {
    if (!target || target.width <= 0 || target.height <= 0) return false;
    return target.left < viewport.width && target.top < viewport.height && target.left + target.width > 0 && target.top + target.height > 0;
}

/**
 * Returns the place of the callout next to its target. It tries the right side, the left side, below and above, in
 * that order. When the target is not on the screen, or the callout fits at no side, the callout goes to the center of
 * the window. So the callout never points at nothing.
 */
export function calloutPosition(target: Rect | undefined, callout: Size, viewport: Size): CalloutPosition {
    const center: CalloutPosition = {
        top: Math.max(MARGIN, Math.round((viewport.height - callout.height) / 2)),
        left: Math.max(MARGIN, Math.round((viewport.width - callout.width) / 2)),
        placement: 'center'
    };
    if (!isOnScreen(target, viewport)) return center;
    const right = target.left + target.width;
    const bottom = target.top + target.height;
    const vertical = clamp(target.top + target.height / 2 - callout.height / 2, MARGIN, viewport.height - callout.height - MARGIN);
    const horizontal = clamp(target.left + target.width / 2 - callout.width / 2, MARGIN, viewport.width - callout.width - MARGIN);
    const fitsHeight = callout.height + 2 * MARGIN <= viewport.height;
    const fitsWidth = callout.width + 2 * MARGIN <= viewport.width;
    if (fitsHeight && right + GAP + callout.width + MARGIN <= viewport.width) {
        return { top: Math.round(vertical), left: Math.round(right + GAP), placement: 'right' };
    }
    if (fitsHeight && target.left - GAP - callout.width >= MARGIN) {
        return { top: Math.round(vertical), left: Math.round(target.left - GAP - callout.width), placement: 'left' };
    }
    if (fitsWidth && bottom + GAP + callout.height + MARGIN <= viewport.height) {
        return { top: Math.round(bottom + GAP), left: Math.round(horizontal), placement: 'below' };
    }
    if (fitsWidth && target.top - GAP - callout.height >= MARGIN) {
        return { top: Math.round(target.top - GAP - callout.height), left: Math.round(horizontal), placement: 'above' };
    }
    return center;
}

/** Returns the highlight around a target: the target with a padding, kept in the window. */
export function spotlightRect(target: Rect, viewport: Size, padding = 4): Rect {
    const left = Math.max(0, target.left - padding);
    const top = Math.max(0, target.top - padding);
    const right = Math.min(viewport.width, target.left + target.width + padding);
    const bottom = Math.min(viewport.height, target.top + target.height + padding);
    return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
