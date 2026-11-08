import { useMemo, useSyncExternalStore } from 'react';
import type { AgentUpdate } from '@shared/agents';
import type { TerminalSession } from '@shared/terminal';

/**
 * The newest agent state of each terminal session, from the agent hooks.
 * An agent reports its state at each tool call. The state is kept here and not in the state of `App`, so that only
 * the views that show it render again, and not the full app with the terminal that the user types in.
 */
export class AgentStateStore {
    private updates: ReadonlyMap<string, AgentUpdate> = new Map();
    private readonly listeners = new Set<() => void>();

    /** Records the state of a session. An update that changes nothing does not render the views again. */
    set(id: string, update: AgentUpdate): void {
        const current = this.updates.get(id);
        if (current && current.state === update.state && current.message === update.message
            && current.prompt === update.prompt && current.at === update.at) {
            return;
        }
        const next = new Map(this.updates);
        next.set(id, update);
        this.update(next);
    }

    /** Forgets the state of a session that closed. */
    delete(id: string): void {
        if (this.updates.has(id)) {
            const next = new Map(this.updates);
            next.delete(id);
            this.update(next);
        }
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    /** The states by session ID. The map is new after each change, so React can compare it. */
    getSnapshot = (): ReadonlyMap<string, AgentUpdate> => this.updates;

    private update(next: ReadonlyMap<string, AgentUpdate>): void {
        this.updates = next;
        this.listeners.forEach(listener => listener());
    }
}

export const agentStateStore = new AgentStateStore();

/** Applies the newest agent states to the sessions. Renders again when an agent state changes. */
export function useAgentSessions(sessions: TerminalSession[]): TerminalSession[] {
    const updates = useSyncExternalStore(agentStateStore.subscribe, agentStateStore.getSnapshot);
    return useMemo(() => updates.size === 0 ? sessions : sessions.map(session => {
        const update = updates.get(session.id);
        return update
            ? { ...session, agentState: update.state, agentMessage: update.message, agentPrompt: update.prompt, agentStateAt: update.at }
            : session;
    }), [sessions, updates]);
}
