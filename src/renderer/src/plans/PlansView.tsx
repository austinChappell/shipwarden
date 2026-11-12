import { ChevronLeft, ClipboardList, Plus } from 'lucide-react';
import { PLAN_STATUS_LABELS, newPlan, planCounts, type Plan } from '@shared/plans';
import type { ViewRoute } from '@shared/nav-history';
import type { Project } from '@shared/projects';
import { EmptyState } from '../components/EmptyState';
import { timeAgo } from '../util';
import { PlanPage } from './PlanPage';
import { createPlan, useProjectPlans, usePlans } from './plan-queries';

interface Props {
    project: Project;
    repoLabel(repo: string): string;
    /** The page of the view is the ID of the open plan. */
    route: ViewRoute;
    onRoute(route: ViewRoute): void;
    onOpenWorktree(path: string, sessionId?: string): void;
}

/**
 * The Plans view of a project: the list of plans, and one plan. A plan starts as an idea. An agent reads all
 * repositories of the project and proposes steps. The user edits the steps and executes the plan.
 */
export function PlansView({ project, repoLabel, route, onRoute, onOpenWorktree }: Props) {
    const { loaded } = usePlans();
    const plans = useProjectPlans(project.id);
    const open = route.page ? plans.find(plan => plan.id === route.page) : undefined;

    const startPlan = async () => {
        const plan = newPlan(project.id, Date.now());
        // createPlan puts the plan in the cache at once, so the page can show it.
        const saving = createPlan(plan);
        onRoute({ page: plan.id });
        await saving;
    };

    if (open) {
        return (
            <div className="plans-view">
                <header className="settings-header plans-header">
                    <button type="button" className="view-back" onClick={() => onRoute({})}>
                        <ChevronLeft size={14} /> Plans
                    </button>
                </header>
                <div className="plans-scroll">
                    <PlanPage
                        key={open.id}
                        plan={open}
                        project={project}
                        repoLabel={repoLabel}
                        onOpenWorktree={onOpenWorktree}
                        onClosed={() => onRoute({})}
                        onOpenPlan={id => onRoute({ page: id })}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="plans-view">
            <header className="settings-header plans-header">
                <h1>
                    <ClipboardList size={13} strokeWidth={1.8} /> Plans
                </h1>
                <button type="button" className="button primary-solid" onClick={() => void startPlan()}>
                    <Plus size={14} /> New plan
                </button>
            </header>
            <div className="plans-scroll">
                {loaded && plans.length === 0 ? (
                    <EmptyState
                        icon={ClipboardList}
                        title="Explore an idea"
                        actions={
                            <button type="button" className="button primary-solid" onClick={() => void startPlan()}>
                                <Plus size={14} /> New plan
                            </button>
                        }
                    >
                        Write an idea for {project.name}. An agent reads all repositories of the project and proposes a plan in steps. You edit the steps, link
                        tasks, and then execute the plan. Each step gets its own worktree and pull request.
                    </EmptyState>
                ) : (
                    <div className="settings-page plans-page">
                        <div className="settings-card">
                            {plans.map(plan => (
                                <PlanRow key={plan.id} plan={plan} onOpen={() => onRoute({ page: plan.id })} />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function PlanRow({ plan, onOpen }: { plan: Plan; onOpen(): void }) {
    const counts = planCounts(plan);
    const done = plan.steps.filter(step => step.status === 'done').length;
    const parts = [
        counts.steps === 1 ? '1 step' : `${counts.steps} steps`,
        plan.status === 'draft' ? `${counts.pullRequests} pull requests` : `${done} done`,
        plan.steps.filter(step => step.pr).length > 0 ? `${plan.steps.filter(step => step.pr).length} pull requests open` : '',
        `changed ${timeAgo(new Date(plan.updatedAt).toISOString())}`
    ].filter(Boolean);
    return (
        <button type="button" className="settings-row plan-row" onClick={onOpen}>
            <div className="settings-row-main">
                <div className="settings-row-text">
                    <div className="settings-row-label">
                        <span className={`plan-status ${plan.status}`}>{PLAN_STATUS_LABELS[plan.status]}</span> {plan.title}
                    </div>
                    <div className="settings-row-description">{parts.join(' · ')}</div>
                </div>
            </div>
        </button>
    );
}
