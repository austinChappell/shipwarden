import { useSyncExternalStore } from 'react';
import type { CreateWorktreeProgress, CreateWorktreeStep, Worktree } from '@shared/worktrees';

const api = window.shipwarden;

/** A step of a creation that occurred, with the count of the copied items for the "copy" step. */
export type ProgressStep = CreateWorktreeProgress;

/** The state of one worktree creation. */
export interface WorktreeProgress {
    id: string;
    repoPath: string;
    branch: string;
    /** The steps that started, in order. The last step runs now while `status` is "running". */
    steps: ProgressStep[];
    status: 'running' | 'ready' | 'failed';
    /** True after the user closed the dialog with "Notify me when ready". A notice then shows the progress. */
    background: boolean;
    worktree?: Worktree;
    error?: string;
}

/**
 * The value that `createWorktree` throws when the user closed the dialog before the end. The worktree exists. The caller
 * must not close the dialog again, because the user can have opened a new dialog.
 */
export class CreationInBackground extends Error {
    constructor() {
        super('The creation continues without the dialog.');
        this.name = 'CreationInBackground';
    }
}

let entries: WorktreeProgress[] = [];
const listeners = new Set<() => void>();
/** True after the store subscribes to the progress events. The subscription lasts as long as the page. */
let listening = false;

function emit(next: WorktreeProgress[]): void {
    entries = next;
    for (const listener of listeners) listener();
}

function update(id: string, change: (entry: WorktreeProgress) => WorktreeProgress): void {
    emit(entries.map(entry => (entry.id === id ? change(entry) : entry)));
}

/** Adds a step, or replaces the counts of the last step when it is the same step. */
export function withStep(steps: ProgressStep[], progress: ProgressStep): ProgressStep[] {
    const last = steps.at(-1);
    return last?.step === progress.step ? [...steps.slice(0, -1), progress] : [...steps, progress];
}

/** Receives the progress events of the main process. One listener serves all creations. */
function listenToEvents(): void {
    if (listening) return;
    listening = true;
    api.worktrees.onProgress((id, progress) => {
        if (entries.some(entry => entry.id === id)) update(id, entry => ({ ...entry, steps: withStep(entry.steps, progress) }));
    });
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The creations of worktrees and their progress. The New worktree dialog and the progress notices read it. */
export const worktreeProgress = {
    /** Starts to track a creation. */
    start(id: string, repoPath: string, branch: string): void {
        listenToEvents();
        emit([...entries.filter(entry => entry.id !== id), { id, repoPath, branch, steps: [], status: 'running', background: false }]);
    },
    /** Adds a step that the page runs, for example "setup" or "agent". */
    step(id: string, step: CreateWorktreeStep): void {
        update(id, entry => ({ ...entry, steps: withStep(entry.steps, { step }) }));
    },
    /** Marks the creation as one that continues without the dialog. */
    moveToBackground(id: string): void {
        update(id, entry => ({ ...entry, background: true }));
    },
    isBackground(id: string): boolean {
        return entries.find(entry => entry.id === id)?.background ?? false;
    },
    /** Ends a creation. A creation with the dialog stops here. A creation without the dialog keeps its notice. */
    finish(id: string, worktree: Worktree): void {
        if (worktreeProgress.isBackground(id)) update(id, entry => ({ ...entry, status: 'ready', worktree }));
        else worktreeProgress.dismiss(id);
    },
    /** Ends a creation with an error. A creation with the dialog stops here, because the dialog shows the error. */
    fail(id: string, error: string): void {
        if (worktreeProgress.isBackground(id)) update(id, entry => ({ ...entry, status: 'failed', error }));
        else worktreeProgress.dismiss(id);
    },
    dismiss(id: string): void {
        emit(entries.filter(entry => entry.id !== id));
    }
};

/** Returns the state of one creation. */
export function useWorktreeProgress(id: string | undefined): WorktreeProgress | undefined {
    return useSyncExternalStore(subscribe, () => entries.find(entry => entry.id === id));
}

/** Returns the creations that continue without the dialog. */
export function useBackgroundCreations(): WorktreeProgress[] {
    const all = useSyncExternalStore(subscribe, () => entries);
    return all.filter(entry => entry.background);
}

/** The text of a step for the user. `running` selects the text of a step that runs now. */
export function stepLabel({ step, done, total }: ProgressStep, running: boolean): string {
    switch (step) {
        case 'fetch':
            return running ? 'Fetching origin…' : 'Fetched origin';
        case 'checkout':
            return running ? 'Checking out the files…' : 'Checked out the files';
        case 'copy': {
            const count = total ? ` (${running ? `${Math.min((done ?? 0) + 1, total)} of ${total}` : total})` : '';
            return running ? `Copying the ignored files${count}…` : `Copied the ignored files${count}`;
        }
        case 'setup':
            return running ? 'Starting the setup script…' : 'Started the setup script in the Setup tab';
        case 'agent':
            return running ? 'Starting the agent…' : 'Started the agent';
    }
}
