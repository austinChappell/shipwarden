import { useRef, useState } from 'react';
import { GitCompareArrows, LoaderCircle, X } from 'lucide-react';
import { agentCountError, MAX_COMPARE_AGENTS, MIN_COMPARE_AGENTS } from '@shared/agent-compare';
import type { AgentDefinition } from '@shared/settings';
import { useInstalledAgents } from '../../compare/compare-cache';
import { useBudgetWait } from '../../usage-budget';
import { errorText } from '../../util';
import { Button, Checkbox, IconButton, SkeletonRows } from '../ui';
import { useModal } from '../use-modal';

interface Props {
    /** The agents of Settings › Agents. The dialog shows only the agents with a command in the PATH. */
    agents: AgentDefinition[];
    /** The name of the repository of the new worktrees. */
    repoName: string;
    onClose(): void;
    /** Makes the worktrees and starts the agents. */
    onStart(agentIds: string[]): Promise<void>;
}

/** The dialog that starts one task with 2 to 4 agents. Each agent gets its own worktree and branch. */
export function CompareAgentsDialog({ agents, repoName, onClose, onStart }: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const { installed, loading } = useInstalledAgents(agents);
    const [chosen, setChosen] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const countError = agentCountError(chosen.length);
    // The usage budget of Settings › Agents. The Start button waits until the usage of each chosen agent is below it.
    const budgetWait = useBudgetWait(agents.filter(agent => chosen.includes(agent.id)));
    const blocked = countError ?? budgetWait;

    const toggle = (id: string, on: boolean) => setChosen(list => (on ? [...list, id] : list.filter(item => item !== id)));
    const start = async () => {
        setBusy(true);
        setError(undefined);
        try {
            await onStart(chosen);
            onClose();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
            <div
                ref={dialog}
                className="modal compare-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Compare agents"
                onKeyDown={event => {
                    if (event.key !== 'Escape') return;
                    // The task dialog below must stay open.
                    event.preventDefault();
                    event.stopPropagation();
                    if (!busy) onClose();
                }}
            >
                <header className="modal-header">
                    <GitCompareArrows size={15} strokeWidth={1.8} />
                    <h2>Compare agents</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close" title="Close (Esc)" disabled={busy} onClick={onClose} />
                </header>
                <div className="modal-body">
                    <p className="panel-note">
                        Select {MIN_COMPARE_AGENTS} to {MAX_COMPARE_AGENTS} agents. Each agent gets its own worktree in {repoName}. The branch name ends with
                        the agent, for example "-codex". Then compare the results and keep one.
                    </p>
                    {loading && <SkeletonRows count={3} dot={false} label="Finding the agents" />}
                    {!loading && installed.length < MIN_COMPARE_AGENTS && (
                        <p className="form-error">
                            ShipWarden found {installed.length === 0 ? 'no agent' : 'only 1 agent'} in the PATH of your login shell. Install another agent, or
                            add it in Settings › Agents.
                        </p>
                    )}
                    {!loading && (
                        <div className="compare-agent-list">
                            {installed.map(agent => (
                                <Checkbox
                                    key={agent.id}
                                    checked={chosen.includes(agent.id)}
                                    disabled={busy || (!chosen.includes(agent.id) && chosen.length >= MAX_COMPARE_AGENTS)}
                                    label={agent.name}
                                    description={agent.command}
                                    onChange={on => toggle(agent.id, on)}
                                />
                            ))}
                        </div>
                    )}
                    {busy && (
                        <p className="panel-note">
                            <LoaderCircle size={12} className="spin" /> Making the worktrees. The branch name can take a few seconds.
                        </p>
                    )}
                    {budgetWait && !busy && <p className="panel-note compare-budget-wait">{budgetWait} Start is on again after the reset.</p>}
                    {error && <div className="form-error">{error}</div>}
                </div>
                <footer className="modal-footer">
                    <span className="header-spacer" />
                    <Button disabled={busy} onClick={onClose}>
                        Cancel
                    </Button>
                    <Button variant="primary" disabled={busy || !!blocked} title={blocked} onClick={() => void start()}>
                        {chosen.length >= MIN_COMPARE_AGENTS ? `Start ${chosen.length} agents` : 'Start agents'}
                    </Button>
                </footer>
            </div>
        </div>
    );
}
