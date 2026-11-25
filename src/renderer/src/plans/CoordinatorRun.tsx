import { useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { WORKER_STATUS_LABELS } from '@shared/coordinator';
import { formatAgo, pluralize } from '@shared/format';
import { PLAN_STATUS_LABELS, type Plan, type PlanStep, type StepStatus } from '@shared/plans';
import { confirmDialog } from '../components/ConfirmDialog';
import { Markdown } from '../components/Markdown';
import { Button, Card, Chip, type ChipTone } from '../components/ui';
import { openPullRequestUrl } from '../pull-request-links';
import { errorText } from '../util';
import { removePlan } from './plan-queries';

const WORKER_TONES: Record<StepStatus, ChipTone> = {
    pending: 'pending',
    running: 'pending',
    attention: 'warning',
    done: 'success',
    skipped: 'neutral',
    failed: 'danger'
};

interface Props {
    plan: Plan;
    repoLabel(repo: string): string;
    onOpenWorktree(path: string, sessionId?: string): void;
    onClosed(): void;
}

/**
 * A coordinator run: the workers that an agent started with the MCP tool start_worker. The main process changes the
 * run, so the page shows it and does not edit it.
 */
export function CoordinatorRun({ plan, repoLabel, onOpenWorktree, onClosed }: Props) {
    const [error, setError] = useState<string>();
    const coordinator = plan.coordinator;
    const open = plan.steps.filter(step => step.status === 'running' || step.status === 'attention' || step.status === 'pending').length;

    const remove = async () => {
        const ok = await confirmDialog({
            title: `Delete "${plan.title}"?`,
            message:
                'The list of the workers goes away. The worktrees, the branches, the agents, and the pull requests stay. The workers cannot send their results anymore.',
            confirmLabel: 'Delete',
            danger: true
        });
        if (!ok) return;
        try {
            await removePlan(plan.id);
            onClosed();
        } catch (err) {
            setError(errorText(err));
        }
    };

    return (
        <div className="flow-page plan-page coordinator-page">
            <header className="flow-header">
                <div className="flow-header-main">
                    <div className="flow-title-row">
                        <h2 className="flow-title">{plan.title}</h2>
                        <Chip tone={plan.status === 'running' ? 'pending' : 'success'}>{PLAN_STATUS_LABELS[plan.status]}</Chip>
                    </div>
                    <div className="flow-field-note">
                        {[
                            pluralize(plan.steps.length, 'worker'),
                            open > 0 ? `${open} open` : '',
                            `started ${formatAgo(new Date(plan.createdAt).toISOString())}`
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                    </div>
                </div>
                <div className="flow-header-actions">
                    {coordinator && (
                        <Button icon={<SquareTerminal size={14} />} onClick={() => onOpenWorktree(coordinator.worktree, coordinator.sessionId)}>
                            Open coordinator
                        </Button>
                    )}
                    <Button variant="danger" onClick={() => void remove()}>
                        Delete…
                    </Button>
                </div>
            </header>
            {error && <div className="form-error">{error}</div>}
            <p className="flow-field-note">
                An agent started these workers with the ShipWarden tool start_worker. Each worker has its own worktree. ShipWarden tells the coordinator when a
                worker finishes, stops, or waits for 10 minutes.
            </p>
            <Card>
                {plan.steps.map(step => (
                    <WorkerRow key={step.id} step={step} repoLabel={repoLabel} onOpenWorktree={onOpenWorktree} />
                ))}
            </Card>
        </div>
    );
}

function WorkerRow({
    step,
    repoLabel,
    onOpenWorktree
}: {
    step: PlanStep;
    repoLabel(repo: string): string;
    onOpenWorktree(path: string, sessionId?: string): void;
}) {
    const meta = [step.repo ? repoLabel(step.repo) : '', step.branch ?? '', step.depth && step.depth > 1 ? `depth ${step.depth}` : '', step.detail ?? '']
        .filter(Boolean)
        .join(' · ');
    const worktree = step.worktreePath;
    return (
        <div className="settings-row coordinator-worker">
            <div className="settings-row-main">
                <div className="settings-row-text">
                    <div className="settings-row-label">
                        <Chip tone={WORKER_TONES[step.status]}>{WORKER_STATUS_LABELS[step.status]}</Chip> {step.title}
                    </div>
                    <div className="settings-row-description">{meta}</div>
                </div>
                <div className="settings-row-control">
                    {step.pr && (
                        <Button size="sm" variant="link" onClick={() => openPullRequestUrl(step.pr?.url ?? '')}>
                            #{step.pr.number}
                        </Button>
                    )}
                    {worktree && (
                        <Button size="sm" onClick={() => onOpenWorktree(worktree, step.sessionId)}>
                            Open
                        </Button>
                    )}
                </div>
            </div>
            {(step.report || step.description) && (
                <details className="plan-step-details">
                    <summary>{step.report ? 'Task and report' : 'Task'}</summary>
                    <div className="flow-label">Task</div>
                    <Markdown className="plan-summary" text={step.description} />
                    {step.report && (
                        <>
                            <div className="flow-label">Report</div>
                            <Markdown className="plan-summary" text={step.report} />
                        </>
                    )}
                </details>
            )}
        </div>
    );
}
