import { useRef, useState } from 'react';
import { ClipboardList, X } from 'lucide-react';
import { repoLabel, type RepoRef } from '@shared/github';
import { MAX_GROUP_PULL_REQUESTS, parsePullRequestLink, prKey } from '@shared/pr-groups';
import { PLAN_STATUS_LABELS, type Plan } from '@shared/plans';
import type { ProjectsState } from '@shared/projects';
import { errorText } from '../util';
import { addPullRequestStep } from '../plans/plan-actions';
import { usePlans } from '../plans/plan-queries';
import { Button, Combobox, Field, IconButton } from './ui';
import { useModal } from './use-modal';

interface Props {
    repo: RepoRef;
    pr: { number: number; title: string; url: string };
    projects: ProjectsState;
    /** The folder of the project repository that is a clone of the repository. Null when no project has a clone. */
    clone: string | null | undefined;
    onClose(): void;
    /** Opens the page of the plan after the add. */
    onOpenPlan(id: string): void;
}

/** True when a step of the plan has the pull request. */
function hasPullRequest(plan: Plan, key: string): boolean {
    return plan.steps.some(step => {
        const link = step.pr ? parsePullRequestLink(step.pr.url) : undefined;
        return !!link && prKey(link).toLowerCase() === key;
    });
}

/**
 * The dialog that adds a pull request to a plan that ran. The pull request becomes a done step at the end of the plan.
 * A draft does not show, because a draft has no pull requests yet.
 */
export function AddToPlanDialog({ repo, pr, projects, clone, onClose, onOpenPlan }: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const { plans: allPlans } = usePlans();
    const key = prKey({ repo, number: pr.number }).toLowerCase();
    const projectOf = (plan: Plan) => projects.projects.find(project => project.id === plan.projectId);
    const plans = allPlans.filter(plan => plan.status !== 'draft' && projectOf(plan));
    const [chosenTarget, setTarget] = useState<string>();
    // The plans can load after the first render. Until the user selects, the newest plan with the repository is the default.
    const target = chosenTarget ?? (plans.find(plan => clone && projectOf(plan)?.repos.includes(clone)) ?? plans[0])?.id;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const chosen = plans.find(plan => plan.id === target);
    const already = !!chosen && hasPullRequest(chosen, key);
    const full = !!chosen && !already && chosen.steps.length >= MAX_GROUP_PULL_REQUESTS;

    const submit = async () => {
        if (!chosen) return;
        if (already) {
            onOpenPlan(chosen.id);
            onClose();
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await addPullRequestStep(chosen.id, pr.url, projectOf(chosen)?.repos ?? []);
            onOpenPlan(chosen.id);
            onClose();
        } catch (err) {
            setError(errorText(err));
            setBusy(false);
        }
    };

    // The plans of each project are in one group of the list.
    const options = projects.projects.flatMap(project => {
        const items = plans
            .filter(plan => plan.projectId === project.id)
            .map(plan => ({ value: plan.id, label: `${plan.title} (${PLAN_STATUS_LABELS[plan.status]})` }));
        return items.length ? [{ label: project.name, items }] : [];
    });

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
            <div
                ref={dialog}
                className="modal add-group-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Add to a plan"
                onKeyDown={event => {
                    if (event.key === 'Escape' && !busy) onClose();
                }}
            >
                <header className="modal-header">
                    <ClipboardList size={15} strokeWidth={1.8} />
                    <h2>Add to a plan</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close" title="Close (Esc)" disabled={busy} onClick={onClose} />
                </header>
                <div className="modal-body">
                    <p className="panel-note">
                        {repoLabel(repo)}#{pr.number} becomes a done step at the end of the plan. The PR group of the plan gets it too. The project of the plan
                        must have the repository.
                    </p>
                    {plans.length === 0 ? (
                        <p className="panel-note">No plan ran yet. Run a plan first.</p>
                    ) : (
                        <Field label="Plan">
                            <Combobox
                                value={target}
                                groups={options}
                                placeholder="Select a plan"
                                searchPlaceholder="Filter plans"
                                onChange={value => {
                                    setTarget(value);
                                    setError(undefined);
                                }}
                            />
                        </Field>
                    )}
                    {already && <p className="panel-note">The pull request is in this plan already.</p>}
                    {full && <p className="panel-note">A plan can have at most {MAX_GROUP_PULL_REQUESTS} steps.</p>}
                    {error && (
                        <div className="form-error" role="alert">
                            {error}
                        </div>
                    )}
                </div>
                <footer className="modal-footer">
                    <Button onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button variant="primary" disabled={busy || !chosen || full} onClick={() => void submit()}>
                        {already ? 'Open plan' : busy ? 'Adding…' : 'Add'}
                    </Button>
                </footer>
            </div>
        </div>
    );
}
