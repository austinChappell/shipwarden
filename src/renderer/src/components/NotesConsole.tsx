import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Bot, ChevronDown, ChevronUp, Play, Plus, SquareTerminal, X } from 'lucide-react';
import { AGENT_STATE_LABELS, type AgentState } from '@shared/agents';
import { RUN_TAB_PREFIX } from '@shared/note-run';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { agentStateStore } from '../terminal/agent-state-store';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { usePanelWidth } from './ResizeHandle';
import { TerminalView } from './TerminalView';
import { Chip, IconButton, type ChipTone } from './ui';

/** The tone of the state chip for each agent state. The tones are the same as in the agent drawer. */
const STATE_TONES: Record<AgentState, ChipTone> = {
    starting: 'neutral',
    idle: 'neutral',
    working: 'pending',
    waiting: 'danger',
    done: 'success',
    exited: 'neutral'
};

/** One tab of the console: an icon for the kind of session, the title, and the agent state of an agent. */
function ConsoleTab({ session, active, onSelect, onClose }: { session: TerminalSession; active: boolean; onSelect(): void; onClose(): void }) {
    const update = useSyncExternalStore(agentStateStore.subscribe, () => agentStateStore.getSnapshot().get(session.id));
    const state = session.isAgent ? (update?.state ?? session.agentState) : undefined;
    const ref = useRef<HTMLDivElement>(null);
    // The active tab stays visible when the tab strip is too narrow for all tabs.
    useEffect(() => {
        if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [active]);
    const Icon = session.isAgent ? Bot : session.title.startsWith(RUN_TAB_PREFIX) ? Play : SquareTerminal;
    return (
        <div ref={ref} className={`notes-console-tab${active ? ' active' : ''}`} role="tab" aria-selected={active}>
            <button type="button" className="notes-console-tab-main" title={session.title} onClick={onSelect}>
                <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
                <span className="notes-console-tab-title">{session.title}</span>
                {state && state !== 'idle' && <Chip tone={STATE_TONES[state]}>{AGENT_STATE_LABELS[state]}</Chip>}
            </button>
            <IconButton size="sm" icon={<X size={12} strokeWidth={1.8} />} label={`Close ${session.title}. Its process stops.`} onClick={onClose} />
        </div>
    );
}

interface Props {
    /** The sessions of the Scratch Pad, in the order that they started. */
    sessions: TerminalSession[];
    activeId: string | undefined;
    settings: TerminalSettings;
    /** A part of the key of the terminal view. A new value opens the terminal again, for example after a change of the colors. */
    colorsKey: string;
    collapsed: boolean;
    onToggle(): void;
    onSelect(session: TerminalSession): void;
    onClose(session: TerminalSession): void;
    /** Opens a new shell in the notes folder. */
    onNewTerminal(): void;
}

/**
 * The console at the bottom of the Scratch Pad: a tab for each run of a file, each terminal, and each agent in the
 * notes folder. The user can edit a file and see its output at the same time, as in the run tool of an IDE.
 */
export function NotesConsole({ sessions, activeId, settings, colorsKey, collapsed, onToggle, onSelect, onClose, onNewTerminal }: Props) {
    const height = usePanelWidth('shipwarden.height.notesConsole', 260, 120, 1600);
    const active = sessions.find(session => session.id === activeId) ?? sessions[sessions.length - 1];

    return (
        <section
            className={`notes-console${collapsed ? ' collapsed' : ''}`}
            style={collapsed ? undefined : { height: height.width }}
            aria-label="Scratch Pad console"
        >
            {!collapsed && <DrawerResizeHandle height={height} name="console" />}
            <header className="notes-console-header">
                <div className="notes-console-tabs" role="tablist">
                    {sessions.map(session => (
                        <ConsoleTab
                            key={session.id}
                            session={session}
                            active={session.id === active?.id}
                            onSelect={() => {
                                onSelect(session);
                                if (collapsed) onToggle();
                            }}
                            onClose={() => onClose(session)}
                        />
                    ))}
                </div>
                <IconButton size="sm" icon={<Plus size={14} strokeWidth={1.8} />} label="New terminal in the notes folder" onClick={onNewTerminal} />
                <IconButton
                    size="sm"
                    icon={collapsed ? <ChevronUp size={14} strokeWidth={1.8} /> : <ChevronDown size={14} strokeWidth={1.8} />}
                    label={collapsed ? 'Show the console' : 'Hide the console'}
                    onClick={onToggle}
                />
            </header>
            {!collapsed && active && (
                <div className="notes-console-body">
                    <TerminalView key={`${active.id}:${colorsKey}`} session={active} settings={settings} />
                </div>
            )}
        </section>
    );
}
