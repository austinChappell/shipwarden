import { useMemo, useSyncExternalStore } from 'react';
import type { TerminalSession } from '@shared/terminal';
import { useAgentSessions } from './agent-state-store';

const EMPTY: TerminalSession[] = [];

/**
 * A copy of the terminal sessions of `App`. A view that is outside the React tree of `App` reads it, for example a
 * view zone in Monaco. The view then shows the agents that start and stop while it is open.
 */
class SessionListStore {
    private sessions: TerminalSession[] = EMPTY;
    private readonly listeners = new Set<() => void>();

    set(sessions: TerminalSession[]): void {
        if (sessions === this.sessions) return;
        this.sessions = sessions;
        this.listeners.forEach(listener => listener());
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): TerminalSession[] => this.sessions;
}

export const sessionListStore = new SessionListStore();

/** Returns the sessions of a worktree, with their newest agent states. */
export function useWorktreeSessions(worktree: string): TerminalSession[] {
    const all = useSyncExternalStore(sessionListStore.subscribe, sessionListStore.getSnapshot);
    const sessions = useMemo(() => all.filter(session => session.worktreePath === worktree), [all, worktree]);
    return useAgentSessions(sessions);
}
