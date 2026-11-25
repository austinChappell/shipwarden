import { useState } from 'react';
import { Send } from 'lucide-react';
import { noteTargetOptions, type NoteTarget } from '@shared/code-note';
import { elementPrompt, pickLabel, type ElementPick } from '@shared/element-pick';
import type { AgentDefinition } from '@shared/settings';
import { useWorktreeSessions } from '../terminal/session-list-store';
import { targetSelectOptions } from './ReviewZones';
import { Button, Input, Select } from './ui';

/**
 * The bar of a picked element, between the toolbar and the page: a preview of the element, a note, the agent that gets
 * the element, and the send button. The first agent that runs in the worktree is the default. Without a running agent,
 * the default is a new session of the agent of the repository.
 */
export function ElementPickBar({
    pick,
    worktree,
    agents,
    defaultAgentId,
    onSend,
    onClose
}: {
    pick: ElementPick;
    worktree: string;
    agents: readonly AgentDefinition[];
    defaultAgentId?: string;
    onSend(prompt: string, target: NoteTarget): void;
    onClose(): void;
}) {
    const [note, setNote] = useState('');
    const [targetKey, setTargetKey] = useState<string>();
    const sessions = useWorktreeSessions(worktree);
    const targets = noteTargetOptions(sessions, agents, defaultAgentId);
    // The selected agent can stop while the bar is open. Then the first choice applies.
    const target = targets.find(option => option.key === targetKey) ?? targets[0];
    const { element } = pick;
    const label = pickLabel(element);
    const send = () => {
        if (target) onSend(elementPrompt({ pick, note }), target.target);
    };
    return (
        <div className="element-pick-bar">
            <div className="element-pick-summary">
                {pick.imageDataUrl && <img className="element-pick-image" src={pick.imageDataUrl} alt={`Screenshot of ${label}`} />}
                <code className="element-pick-label" title={label}>
                    {label}
                </code>
                <span className="element-pick-size">
                    {element.rect.width} × {element.rect.height}
                </span>
            </div>
            <div className="row-buttons element-pick-actions">
                <Input
                    size="sm"
                    className="element-pick-note"
                    autoFocus
                    value={note}
                    placeholder="Add a note for the agent (optional)"
                    aria-label="Note for the agent"
                    onChange={event => setNote(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            send();
                        }
                        if (event.key === 'Escape') onClose();
                    }}
                />
                <Select
                    size="sm"
                    className="element-pick-target"
                    aria-label="Agent that gets the element"
                    title="The agent that gets the element"
                    value={target?.key ?? ''}
                    options={targetSelectOptions(targets)}
                    onChange={setTargetKey}
                />
                <Button size="sm" onClick={onClose}>
                    Cancel
                </Button>
                <Button size="sm" variant="primary" icon={<Send size={13} strokeWidth={1.7} />} disabled={!target} onClick={send}>
                    Send to agent
                </Button>
            </div>
        </div>
    );
}
