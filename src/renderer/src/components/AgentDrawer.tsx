import { useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowUpRight, ChevronDown, ChevronUp, SquareTerminal, X } from 'lucide-react';
import { AGENT_STATE_LABELS, type AgentState } from '@shared/agents';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import { agentStateStore } from '../terminal/agent-state-store';
import { usePanelWidth } from './ResizeHandle';
import { TerminalView } from './TerminalView';
import { Button, Chip, IconButton, type ChipTone } from './ui';

/** The change of the height in pixels for one push of an arrow key. Shift makes the step 4 times larger. */
const KEY_STEP = 16;
/** The smallest height of the page above the drawer. */
const MIN_PAGE_HEIGHT = 160;

/** The tone of the state chip for each agent state. The tones are the same as in the worktree list. */
const STATE_TONES: Record<AgentState, ChipTone> = {
    starting: 'neutral',
    idle: 'neutral',
    working: 'pending',
    waiting: 'danger',
    done: 'success',
    exited: 'neutral'
};

interface Props {
    session: TerminalSession;
    /** The name of the worktree of the agent, as the sidebar shows it. */
    worktreeName: string;
    branch?: string;
    settings: TerminalSettings;
    /** The key of the terminal view. A new key opens the terminal again, for example after a change of the colors. */
    terminalKey: string;
    collapsed: boolean;
    onToggle(): void;
    onClose(): void;
    /** Shows the worktree of the agent, with the agent tab selected. */
    onOpenWorktree(): void;
}

/**
 * A drawer at the bottom of a page that shows an agent terminal of a worktree. The user can read the page and type
 * to the agent at the same time. The terminal is the same terminal as in the agent tab. When the drawer closes, the
 * terminal goes back to the agent tab.
 */
export function AgentDrawer({ session, worktreeName, branch, settings, terminalKey, collapsed, onToggle, onClose, onOpenWorktree }: Props) {
    const height = usePanelWidth('shipwarden.height.agentDrawer', 300, 140, 1600);
    const update = useSyncExternalStore(agentStateStore.subscribe, () => agentStateStore.getSnapshot().get(session.id));
    const state: AgentState | undefined = session.exited ? 'exited' : (update?.state ?? session.agentState);

    /** The largest height that leaves space for the page above the drawer. */
    const maxHeight = (drawer: HTMLElement) => (drawer.parentElement?.clientHeight ?? window.innerHeight) - MIN_PAGE_HEIGHT;
    const resize = (drawer: HTMLElement, value: number) => height.setWidth(Math.min(value, maxHeight(drawer)));

    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        const drawer = handle.parentElement;
        if (!drawer) return;
        const startY = event.clientY;
        const startHeight = drawer.offsetHeight;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing-rows');
        const onMove = (move: globalThis.PointerEvent) => resize(drawer, startHeight + startY - move.clientY);
        const onEnd = () => {
            document.body.classList.remove('resizing-rows');
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onEnd);
            handle.removeEventListener('pointercancel', onEnd);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onEnd);
        handle.addEventListener('pointercancel', onEnd);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const drawer = event.currentTarget.parentElement;
        if (!drawer || event.metaKey || event.ctrlKey || event.altKey) return;
        const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            resize(drawer, height.width + (event.key === 'ArrowUp' ? step : -step));
        } else if (event.key === 'Enter' || event.key === 'Home') {
            event.preventDefault();
            height.reset();
        }
    };

    return (
        <section
            className={`agent-drawer${collapsed ? ' collapsed' : ''}`}
            style={collapsed ? undefined : { height: height.width }}
            aria-label={`Agent of the worktree ${worktreeName}`}
        >
            {!collapsed && (
                <div
                    className="agent-drawer-resize"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize the agent drawer"
                    aria-valuenow={height.width}
                    aria-valuemin={height.min}
                    aria-valuemax={height.max}
                    tabIndex={0}
                    title="Resize the agent drawer. Shift with an arrow key makes bigger steps. Double-click or press Enter to reset."
                    onPointerDown={onPointerDown}
                    onDoubleClick={height.reset}
                    onKeyDown={onKeyDown}
                />
            )}
            <header className="agent-drawer-header">
                <button type="button" className="agent-drawer-title" onClick={onToggle} aria-expanded={!collapsed}>
                    <SquareTerminal size={14} strokeWidth={1.8} aria-hidden="true" />
                    <span className="agent-drawer-name">{session.title}</span>
                    <span className="agent-drawer-worktree">{worktreeName}</span>
                </button>
                {branch && branch !== worktreeName && (
                    <Chip mono className="agent-drawer-branch" title={branch}>
                        {branch}
                    </Chip>
                )}
                {state && <Chip tone={STATE_TONES[state]}>{AGENT_STATE_LABELS[state]}</Chip>}
                <span className="agent-drawer-spacer" />
                <Button size="sm" icon={<ArrowUpRight size={14} strokeWidth={1.8} />} onClick={onOpenWorktree}>
                    Go to worktree
                </Button>
                <IconButton
                    size="sm"
                    icon={collapsed ? <ChevronUp size={14} strokeWidth={1.8} /> : <ChevronDown size={14} strokeWidth={1.8} />}
                    label={collapsed ? 'Show the agent' : 'Hide the agent'}
                    onClick={onToggle}
                />
                <IconButton size="sm" icon={<X size={14} strokeWidth={1.8} />} label="Close the drawer. The agent continues to run." onClick={onClose} />
            </header>
            {!collapsed && (
                <div className="agent-drawer-body">
                    <TerminalView key={terminalKey} session={session} settings={settings} focused={false} />
                </div>
            )}
        </section>
    );
}
