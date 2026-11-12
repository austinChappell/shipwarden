import { ChevronLeft, ClipboardList, Plus } from 'lucide-react';
import { PLAN_STATUS_LABELS, newPlan, planCounts, type Plan } from '@shared/plans';
import type { ViewRoute } from '@shared/nav-history';
import type { Project } from '@shared/projects';
import { EmptyState } from '../components/EmptyState';
import { Button, Card, Chip, PageHeader } from '../components/ui';
import { formatAgo, pluralize } from '@shared/format';
import { PLAN_STATUS_TONES, PlanPage } from './PlanPage';
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
                <header className="form-page-back">
                    <Button variant="ghost" size="lg" className="view-back" icon={<ChevronLeft size={16} />} onClick={() => onRoute({})}>
                        Plans
                    </Button>
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
            <PageHeader
                icon={ClipboardList}
                title="Plans"
                meta={loaded && plans.length > 0 ? plansMeta(plans) : undefined}
                primary={
                    <Button size="lg" variant="primary" icon={<Plus size={14} />} onClick={() => void startPlan()}>
                        New plan
                    </Button>
                }
            />
            <div className="plans-scroll">
                {loaded && plans.length === 0 ? (
                    <EmptyState
                        icon={ClipboardList}
                        title="Explore an idea"
                        actions={
                            <Button size="lg" variant="primary" icon={<Plus size={14} />} onClick={() => void startPlan()}>
                                New plan
                            </Button>
                        }
                    >
                        Write an idea for {project.name}. An agent reads all repositories of the project and proposes a plan in steps. You edit the steps, link
                        tasks, and then execute the plan. Each step gets its own worktree and pull request.
                    </EmptyState>
                ) : (
                    <div className="settings-page plans-page">
                        <Card>
                            {plans.map(plan => (
                                <PlanRow key={plan.id} plan={plan} onOpen={() => onRoute({ page: plan.id })} />
                            ))}
                        </Card>
                    </div>
                )}
            </div>
        </div>
    );
}

/** The meta line of the header: the number of drafts, or the number of plans when there are no drafts. */
function plansMeta(plans: readonly Plan[]): string {
    const drafts = plans.filter(plan => plan.status === 'draft').length;
    const running = plans.filter(plan => plan.status === 'running').length;
    const parts = [drafts > 0 ? pluralize(drafts, 'draft') : '', running > 0 ? `${running} running` : ''].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : pluralize(plans.length, 'plan');
}

function PlanRow({ plan, onOpen }: { plan: Plan; onOpen(): void }) {
    const counts = planCounts(plan);
    const done = plan.steps.filter(step => step.status === 'done').length;
    const opened = plan.steps.filter(step => step.pr).length;
    const parts = [
        pluralize(counts.steps, 'step'),
        plan.status === 'draft' ? pluralize(counts.pullRequests, 'pull request') : `${done} done`,
        opened > 0 ? `${pluralize(opened, 'pull request')} open` : '',
        `changed ${formatAgo(new Date(plan.updatedAt).toISOString())}`
    ].filter(Boolean);
    return (
        <button type="button" className="settings-row plan-row" onClick={onOpen}>
            <div className="settings-row-main">
                <div className="settings-row-text">
                    <div className="settings-row-label">
                        <Chip tone={PLAN_STATUS_TONES[plan.status]}>{PLAN_STATUS_LABELS[plan.status]}</Chip> {plan.title}
                    </div>
                    <div className="settings-row-description">{parts.join(' · ')}</div>
                </div>
            </div>
        </button>
    );
}
