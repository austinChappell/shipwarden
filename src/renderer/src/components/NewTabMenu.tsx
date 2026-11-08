import { useEffect, useRef, useState } from 'react';
import { Bot, Plus, SquareTerminal } from 'lucide-react';
import type { AgentDefinition } from '@shared/settings';

interface Props {
    agents: AgentDefinition[];
    /** The agent of the repository: its own choice, else the global default. The menu marks it. */
    defaultAgentId: string;
    onStart(target: AgentDefinition | 'shell'): void;
}

/**
 * The "+" button of the tab bar. Its menu starts an agent or a shell in the selected worktree.
 * With one agent, the menu says "Agent". With several, it lists each agent by name.
 */
export function NewTabMenu({ agents, defaultAgentId, onStart }: Props) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onPointer = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('pointerdown', onPointer);
        window.addEventListener('keydown', onKey);
        // Focus the first item, so the arrow keys and Enter work at once.
        root.current?.querySelector<HTMLButtonElement>('.new-tab-item')?.focus();
        return () => {
            window.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const start = (target: AgentDefinition | 'shell') => {
        setOpen(false);
        onStart(target);
    };

    /** Moves the focus between the items with the arrow keys. */
    const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.new-tab-item') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
        next?.focus();
    };

    // The repository's agent comes first.
    const ordered = [...agents].sort((a, b) => (a.id === defaultAgentId ? -1 : b.id === defaultAgentId ? 1 : 0));

    return (
        <div className="new-tab" ref={root}>
            <button
                className={`icon-button new-tab-button${open ? ' on' : ''}`}
                title="New tab: an agent or a shell"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
            >
                <Plus size={16} strokeWidth={1.75} />
            </button>
            {open && (
                <div className="new-tab-menu" role="menu" onKeyDown={onMenuKey}>
                    {agents.length === 1 ? (
                        <button className="new-tab-item" role="menuitem" onClick={() => start(agents[0])}>
                            <Bot size={14} strokeWidth={1.6} />
                            <span className="new-tab-label">Agent</span>
                            <span className="new-tab-detail">{agents[0].name}</span>
                        </button>
                    ) : (
                        <>
                            <div className="new-tab-heading">Agents</div>
                            {ordered.map(agent => (
                                <button key={agent.id} className="new-tab-item" role="menuitem" title={agent.command} onClick={() => start(agent)}>
                                    <Bot size={14} strokeWidth={1.6} />
                                    <span className="new-tab-label">{agent.name}</span>
                                    {agent.id === defaultAgentId && <span className="new-tab-badge">default</span>}
                                </button>
                            ))}
                            <div className="new-tab-separator" />
                        </>
                    )}
                    <button className="new-tab-item" role="menuitem" onClick={() => start('shell')}>
                        <SquareTerminal size={14} strokeWidth={1.6} />
                        <span className="new-tab-label">Shell</span>
                    </button>
                </div>
            )}
        </div>
    );
}
