import { CheckCircle2, Circle, ListChecks, X } from 'lucide-react';
import { CHECKLIST_STEPS, checklistDoneCount, type ChecklistStepId } from '@shared/checklist';

interface Props {
    checklist: Record<string, boolean> | undefined;
    /** Runs the action of a step, for example opens the New worktree dialog. Undefined: the step has no button. */
    actionOf(step: ChecklistStepId): { label: string; run(): void } | undefined;
    /** Closes the card for all time. */
    onClose(): void;
}

/**
 * The getting started checklist at the top of the Dashboard. The app marks a step done when the user does its action.
 * The user can close the card for all time.
 */
export function ChecklistCard({ checklist, actionOf, onClose }: Props) {
    const done = checklistDoneCount(checklist);
    const all = done === CHECKLIST_STEPS.length;
    return (
        <section className="checklist-card" aria-labelledby="checklist-title">
            <header className="checklist-header">
                <ListChecks size={16} strokeWidth={1.7} aria-hidden="true" />
                <h2 id="checklist-title">{all ? 'You are ready' : 'Get started with ShipWarden'}</h2>
                <span className="checklist-progress">
                    {done} of {CHECKLIST_STEPS.length} done
                </span>
                <span className="header-spacer" />
                <button className="icon-button" aria-label="Close the checklist" title="Close the checklist. It does not show again." onClick={onClose}>
                    <X size={14} strokeWidth={1.8} />
                </button>
            </header>
            <progress className="checklist-bar" max={CHECKLIST_STEPS.length} value={done} aria-label="Checklist progress" />
            {/* biome-ignore lint/a11y/noRedundantRoles: Safari removes the list role when the list has no bullets. */}
            <ol className="checklist-steps" role="list">
                {CHECKLIST_STEPS.map(step => {
                    const stepDone = !!checklist?.[step.id];
                    const action = stepDone ? undefined : actionOf(step.id);
                    return (
                        <li key={step.id} className={`checklist-step${stepDone ? ' done' : ''}`}>
                            {stepDone ? (
                                <CheckCircle2 size={16} strokeWidth={1.8} className="checklist-icon done" aria-label="Done" />
                            ) : (
                                <Circle size={16} strokeWidth={1.8} className="checklist-icon" aria-label="Not done" />
                            )}
                            <div className="checklist-text">
                                <span className="checklist-label">{step.label}</span>
                                {!stepDone && <span className="checklist-detail">{step.detail}</span>}
                            </div>
                            {action && (
                                <button className="button" onClick={action.run}>
                                    {action.label}
                                </button>
                            )}
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}
