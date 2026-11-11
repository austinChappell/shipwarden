import type { OnboardingSettings } from './onboarding';

/** The steps of the getting started checklist, in order. */
export const CHECKLIST_STEPS = [
    { id: 'addRepository', label: 'Add a repository', detail: 'Add a git repository from your Mac, or clone one.' },
    { id: 'createWorktree', label: 'Create a worktree', detail: 'A worktree is a separate folder with its own branch. Press ⌘N.' },
    { id: 'startAgent', label: 'Start an agent', detail: 'Start your agent in a worktree with the Agent button.' },
    { id: 'openAgents', label: 'Open the Agents view', detail: 'See all agents and their state. Press ⌥⌘2.' },
    { id: 'openPullRequest', label: 'Open a pull request', detail: 'Push the branch of a worktree and create its pull request in the right panel.' }
] as const;

export type ChecklistStepId = (typeof CHECKLIST_STEPS)[number]['id'];

/** The facts of the app that mark the steps done. */
export interface ChecklistFacts {
    hasRepository: boolean;
    /** A worktree that is not the main worktree of its repository exists. */
    hasWorktree: boolean;
    /** An agent runs, or ran in this session. */
    hasAgent: boolean;
    /** The Agents view shows now. */
    agentsViewOpen: boolean;
    /** The branch of a worktree has a pull request. */
    hasPullRequest: boolean;
}

const FACT_OF_STEP: Record<ChecklistStepId, keyof ChecklistFacts> = {
    addRepository: 'hasRepository',
    createWorktree: 'hasWorktree',
    startAgent: 'hasAgent',
    openAgents: 'agentsViewOpen',
    openPullRequest: 'hasPullRequest'
};

/**
 * Returns the checklist with the steps that the facts mark done, or undefined when nothing changes. A step that is
 * done stays done, also when its fact goes away (for example the user removes the worktree).
 */
export function updatedChecklist(current: Record<string, boolean> | undefined, facts: ChecklistFacts): Record<string, boolean> | undefined {
    const next = { ...current };
    let changed = false;
    for (const step of CHECKLIST_STEPS) {
        if (!next[step.id] && facts[FACT_OF_STEP[step.id]]) {
            next[step.id] = true;
            changed = true;
        }
    }
    return changed ? next : undefined;
}

/** Returns the number of steps that are done. */
export function checklistDoneCount(checklist: Record<string, boolean> | undefined): number {
    return CHECKLIST_STEPS.filter(step => checklist?.[step.id]).length;
}

/**
 * Returns true when the Dashboard shows the checklist card: the welcome page is done or skipped, and the user did not
 * close the card. A user who had ShipWarden before the onboarding gets `checklistClosed` at the first start.
 */
export function shouldShowChecklist(onboarding: OnboardingSettings | undefined): boolean {
    return !!onboarding && onboarding.welcome !== 'new' && !onboarding.checklistClosed;
}
