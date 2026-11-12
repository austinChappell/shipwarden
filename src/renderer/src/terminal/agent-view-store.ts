import { useSyncExternalStore } from 'react';
import type { TerminalSession } from '@shared/terminal';

/**
 * The view that the user selected for one agent tab.
 * - chat: the chat.
 * - terminal: the terminal.
 * - answer: the terminal while the agent waits for an answer. The tab shows the chat again after the answer.
 */
export type AgentViewChoice = 'chat' | 'terminal' | 'answer';

/** The view choices of the agent tabs, by session ID. A tab without a choice uses the setting "agentChat". */
class AgentViewStore {
    private choices: ReadonlyMap<string, AgentViewChoice> = new Map();
    private readonly listeners = new Set<() => void>();

    set(id: string, choice: AgentViewChoice | undefined): void {
        if (this.choices.get(id) === choice) return;
        const next = new Map(this.choices);
        if (choice) next.set(id, choice);
        else next.delete(id);
        this.choices = next;
        this.listeners.forEach(listener => listener());
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): ReadonlyMap<string, AgentViewChoice> => this.choices;
}

export const agentViewStore = new AgentViewStore();

/** Returns the view choices of the agent tabs. Renders again when a choice changes. */
export function useAgentViewChoices(): ReadonlyMap<string, AgentViewChoice> {
    return useSyncExternalStore(agentViewStore.subscribe, agentViewStore.getSnapshot);
}

/**
 * The chat of the agent tabs is not ready for users. While this is false, each agent tab shows the terminal, and
 * Settings › Agents does not show the chat setting. The chat code stays, so that work on it can continue.
 */
export const AGENT_CHAT_ENABLED = false;

type ChatSession = Pick<TerminalSession, 'isAgent' | 'exited' | 'agentState' | 'agentTranscript'>;

/**
 * Returns true when the session can show the chat: an agent tab that runs Claude Code. `claude` is true when the
 * command of the tab starts Claude Code. Such a tab shows the chat from its start, before Claude Code reports its
 * transcript. A tab with a transcript runs Claude Code too. Other agents do not write a transcript that ShipWarden can
 * read, so they always show the terminal.
 */
export function canShowChat(session: ChatSession, claude: boolean): boolean {
    if (!session.isAgent || session.exited || session.agentState === 'exited') return false;
    return !!session.agentTranscript || (claude && session.agentState === 'starting');
}

/** Returns true when the tab shows the chat. `chatByDefault` is the setting "agentChat". */
export function showsChat(session: ChatSession, choice: AgentViewChoice | undefined, chatByDefault: boolean, claude: boolean): boolean {
    if (!canShowChat(session, claude)) return false;
    // A question at the start (for example the folder trust question) comes before the first hook, in the state "starting".
    if (choice === 'answer') return session.agentState !== 'waiting' && session.agentState !== 'starting';
    return choice ? choice === 'chat' : chatByDefault;
}
