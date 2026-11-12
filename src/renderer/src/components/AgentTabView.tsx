import { useSyncExternalStore } from 'react';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { agentStateStore, withAgentStore } from '../terminal/agent-state-store';
import { AGENT_CHAT_ENABLED, agentViewStore, canShowChat, showsChat, useAgentViewChoices } from '../terminal/agent-view-store';
import { ChatView } from './ChatView';
import { TerminalView } from './TerminalView';

interface Props {
    session: TerminalSession;
    settings: TerminalSettings;
    /** The key of the terminal view. A new key opens the terminal again, for example after a change of the colors. */
    terminalKey: string;
    focused: boolean;
    /** The setting "agentChat". */
    chatByDefault: boolean;
    /** True when the command of the tab starts Claude Code. */
    claude: boolean;
}

/**
 * Shows a terminal tab: the chat or the terminal. Only an agent tab of Claude Code can show the chat.
 * The view reads the newest agent state from the store, so a state change renders only this view and not the app.
 */
export function AgentTabView({ session: base, settings, terminalKey, focused, chatByDefault, claude }: Props) {
    // Only a change of this session renders the view again. The store replaces the update object at each change.
    const update = useSyncExternalStore(agentStateStore.subscribe, () => agentStateStore.getSnapshot().get(base.id));
    const choices = useAgentViewChoices();
    const session = update ? withAgentStore([base], new Map([[base.id, update]]), new Map())[0] : base;
    if (AGENT_CHAT_ENABLED && showsChat(session, choices.get(session.id), chatByDefault, claude)) {
        return <ChatView session={session} focused={focused} />;
    }
    return (
        <TerminalView
            key={terminalKey}
            session={base}
            settings={settings}
            focused={focused}
            onShowChat={AGENT_CHAT_ENABLED && canShowChat(session, claude) ? () => agentViewStore.set(session.id, 'chat') : undefined}
        />
    );
}
