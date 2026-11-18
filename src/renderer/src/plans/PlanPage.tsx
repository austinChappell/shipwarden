import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    ArrowRight,
    ArrowUpRight,
    Check,
    ChevronDown,
    ChevronRight,
    CircleAlert,
    CircleCheck,
    Layers,
    Loader2,
    GitPullRequest,
    MoreHorizontal,
    Pencil,
    Pause,
    Play,
    Plus,
    RefreshCw,
    RotateCcw,
    Send,
    SkipForward,
    Sparkles,
    SquareCheck,
    X
} from 'lucide-react';
import { AGENT_MODES, type AgentMode } from '@shared/agent-modes';
import {
    MAX_TITLE_LENGTH,
    NEW_PLAN_TITLE,
    PLAN_STATUS_LABELS,
    duplicatePlan,
    newStep,
    planCounts,
    planProblems,
    planReview,
    reviewText,
    stackedOnIndex,
    stepStatusLabel,
    type Plan,
    type PlanDecision,
    type PlanProblem,
    type PlanReview,
    type PlanStatus,
    type PlanStep,
    type PlanTaskTarget,
    type PromptRepo,
    type StepStatus,
    type StepTask
} from '@shared/plans';
import { formatAgo, pluralize } from '@shared/format';
import type { Project } from '@shared/projects';
import { REPO_COLORS, type RepoColor } from '@shared/settings';
import type { TaskLink } from '@shared/tasks';
import {
    Button,
    ButtonGroup,
    Card,
    CardBody,
    CardHeader,
    Checkbox,
    Chip,
    Combobox,
    Count,
    IconButton,
    Select,
    Switch,
    TextArea,
    sortedGroups,
    type ChipTone
} from '../components/ui';
import { alertDialog, confirmDialog } from '../components/ConfirmDialog';
import { showContextMenu } from '../components/ContextMenu';
import { radioGroupKeys } from '../components/keyboard';
import { Markdown } from '../components/Markdown';
import { collectionsQueryOptions, connectionsQueryOptions } from '../components/tasks/use-task-source';
import { taskQueryKeys } from '../components/tasks/task-view-logic';
import { loadCollectionTasks } from '../automations/engine';
import { openLink } from '../links';
import { agentStateStore } from '../terminal/agent-state-store';
import { keyRoots } from '../query-client';
import { errorText } from '../util';
import { cancelExplore, explorePlan } from './plan-explore';
import { cachedPlan, createPlan, removePlan, updatePlan, useExploreState } from './plan-queries';
import { planRunner } from './plan-runner';
import { planPullRequests, syncPlanGroup, usePlanGroup } from './plan-group';

const api = window.shipwarden;

/** The local changes of a draft go to the file after this pause in the typing. */
const SAVE_DELAY_MS = 400;

interface Props {
    plan: Plan;
    project: Project;
    repoLabel(repo: string): string;
    /** The color of a repository from its settings, as in the sidebar. */
    repoColor(repo: string): RepoColor | undefined;
    onOpenWorktree(path: string, sessionId?: string): void;
    /** The plan was deleted. */
    onClosed(): void;
    onOpenPlan(id: string): void;
    /** Opens the page of a PR group in the Review view. */
    onOpenGroup(id: string): void;
}

/** One plan: the editor of a draft, or the steps of a plan that ran. */
export function PlanPage(props: Props) {
    return props.plan.status === 'draft' ? <PlanEditor {...props} /> : <PlanRun {...props} />;
}

/** The "More" menu of a plan: review the pull requests together, duplicate, and delete. */
async function planMenu(plan: Plan, anchor: Element, props: Pick<Props, 'onClosed' | 'onOpenPlan' | 'onOpenGroup'>): Promise<void> {
    const { onClosed, onOpenPlan, onOpenGroup } = props;
    const pullRequests = planPullRequests(plan);
    const choice = await showContextMenu(
        [
            ...(pullRequests.length > 0 ? [{ id: 'group', label: 'Review the pull requests together' }] : []),
            { id: 'duplicate', label: plan.status === 'draft' ? 'Duplicate' : 'Duplicate as a new draft' },
            { id: 'delete', label: 'Delete…', danger: true }
        ],
        anchor
    );
    if (choice === 'group') {
        try {
            // The user asks for the group, so the next pull requests of the plan go into it too.
            if (plan.noPrGroup) await updatePlan(plan.id, current => ({ ...current, noPrGroup: undefined }));
            onOpenGroup((await syncPlanGroup(plan, pullRequests)).id);
        } catch (error) {
            await alertDialog('ShipWarden could not make the PR group.', errorText(error));
        }
    }
    if (choice === 'duplicate') {
        const copy = duplicatePlan(plan, Date.now());
        await createPlan(copy);
        onOpenPlan(copy.id);
    }
    if (choice === 'delete') {
        const ok = await confirmDialog({
            title: `Delete "${plan.title}"?`,
            message:
                plan.status === 'draft'
                    ? 'The plan goes away. This cannot be undone.'
                    : 'The plan and its history go away. The worktrees, the branches, the pull requests and the tasks stay.',
            confirmLabel: 'Delete',
            danger: true
        });
        if (!ok) return;
        if (plan.status === 'running') await planRunner.pause(plan.id);
        await removePlan(plan.id);
        onClosed();
    }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Header                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The idea of a plan, as read-only text. The label and the buttons are in the head row. The text uses the full width.
 * A long idea shows only its start. The label and the "Show more" button open the full text.
 */
function IdeaText({ text, actions }: { text: string; actions: ReactNode }) {
    const [open, setOpen] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const idea = text.trim();

    // Measure the closed text. The toggle shows only when the text is longer than the closed height.
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new idea text has a new height. Thus the effect measures it again.
    useLayoutEffect(() => {
        const element = box.current;
        if (!element || open) return;
        const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [idea, open]);

    const toggleable = open || overflows;
    return (
        <>
            <div className="plan-idea-top">
                {toggleable ? (
                    <button
                        type="button"
                        className="flow-label plan-idea-toggle"
                        aria-expanded={open}
                        title={open ? 'Show less' : 'Show the full idea'}
                        onClick={() => setOpen(value => !value)}
                    >
                        <ChevronRight size={13} strokeWidth={1.8} className={`section-chevron${open ? ' open' : ''}`} />
                        Idea
                    </button>
                ) : (
                    <div className="flow-label">Idea</div>
                )}
                <div className="plan-idea-actions">{actions}</div>
            </div>
            <div ref={box} className={`plan-idea-body${idea ? '' : ' empty'}${open ? ' open' : ''}${!open && overflows ? ' clipped' : ''}`}>
                {idea || 'No idea. You wrote the steps yourself.'}
            </div>
            {toggleable && (
                <Button variant="link" className="plan-idea-more" onClick={() => setOpen(value => !value)}>
                    {open ? 'Show less' : 'Show more'}
                </Button>
            )}
        </>
    );
}

/** The three stages of a plan, from the idea to the run. */
type Stage = 'explore' | 'review' | 'run';

/** The title row and the stages of a plan. */
function PlanHeader({
    title,
    status,
    actions,
    stage,
    finished
}: {
    title: ReactNode;
    status: ReactNode;
    actions: ReactNode;
    stage: Stage;
    finished?: boolean;
}) {
    return (
        <header className="flow-header">
            <div className="flow-header-main">
                <div className="flow-title-row">
                    {title}
                    {status}
                </div>
                <PlanStages stage={stage} finished={finished} />
            </div>
            <div className="flow-header-actions">{actions}</div>
        </header>
    );
}

function PlanStages({ stage, finished }: { stage: Stage; finished?: boolean }) {
    const order: Stage[] = ['explore', 'review', 'run'];
    const at = order.indexOf(stage);
    const labels: Record<Stage, [string, string]> = {
        explore: ['Explore idea', 'Idea explored'],
        review: ['Review steps', 'Steps reviewed'],
        run: ['Run', 'Run finished']
    };
    return (
        <ol className="plan-stages">
            {order.map((item, index) => {
                const done = index < at || (finished === true && item === 'run');
                const state = done ? 'done' : index === at ? 'current' : 'next';
                return (
                    <li key={item} className={`plan-stage ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                        <span className="plan-stage-mark">{done ? <Check size={11} strokeWidth={3} /> : index + 1}</span>
                        {labels[item][done ? 1 : 0]}
                    </li>
                );
            })}
        </ol>
    );
}

/** Returns "A", "A and B" or "A, B, and C". */
function listText(items: readonly string[]): string {
    return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(items);
}

/** The tone of the chip of each plan status. */
export const PLAN_STATUS_TONES: Record<PlanStatus, ChipTone> = {
    draft: 'neutral',
    running: 'pending',
    paused: 'warning',
    done: 'success'
};

/** The tone of the chip of each step status. */
const STEP_STATUS_TONES: Record<StepStatus, ChipTone> = {
    pending: 'neutral',
    running: 'pending',
    attention: 'warning',
    done: 'success',
    skipped: 'neutral',
    failed: 'danger'
};

/** Returns the status label and tone of a step. The live state of the step agent decides if the step needs the user. */
function useStepStatus(step: PlanStep): { label: string; tone: ChipTone } {
    const sessionId = step.sessionId;
    const agentState = useSyncExternalStore(agentStateStore.subscribe, () => (sessionId ? agentStateStore.getSnapshot().get(sessionId)?.state : undefined));
    // A running step whose agent asks a question gets the tone of a step that stopped.
    const tone = step.status === 'running' && agentState === 'waiting' ? STEP_STATUS_TONES.attention : STEP_STATUS_TONES[step.status];
    return { label: stepStatusLabel(step.status, agentState), tone };
}

/**
 * Returns the plan after a change to the title of a step. A plan with the default title, or with the title of its first
 * step, gets the new title of the first step. Thus a new plan has a name from its first step.
 */
function withStepTitle(plan: Plan, stepId: string, title: string): Plan {
    const first = plan.steps[0];
    if (first?.id !== stepId) return plan;
    const named = plan.title === NEW_PLAN_TITLE || plan.title === first.title.trim().slice(0, MAX_TITLE_LENGTH);
    if (!named) return plan;
    return { ...plan, title: title.trim().slice(0, MAX_TITLE_LENGTH) || NEW_PLAN_TITLE };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Draft                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

function PlanEditor({ plan, project, repoLabel, repoColor, onClosed, onOpenPlan, onOpenGroup }: Props) {
    const explore = useExploreState(plan.id);
    const [draft, setDraft] = useState(plan);
    const [feedback, setFeedback] = useState('');
    const [error, setError] = useState<string>();
    const [starting, setStarting] = useState(false);
    /** True while the user edits the idea of a plan that has steps. A plan without steps always shows the editor. */
    const [editingIdea, setEditingIdea] = useState(false);
    /** The IDs of the steps that show the editor. The other steps show read-only text. */
    const [editingSteps, setEditingSteps] = useState<ReadonlySet<string>>(() => new Set());
    /** The IDs of the open steps. At the start, the first step that needs a review is open. */
    const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(() => new Set(firstToReview(plan.steps)));
    const [filter, setFilter] = useState<'all' | 'open'>('all');
    const toggle = (setter: typeof setEditingSteps, id: string, on: boolean) =>
        setter(current => {
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });
    const setStepEditing = (id: string, on: boolean) => {
        toggle(setEditingSteps, id, on);
        if (on) toggle(setOpenSteps, id, true);
    };
    const setStepOpen = (id: string, on: boolean) => toggle(setOpenSteps, id, on);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    /** True while the draft has changes that are not in the file. */
    const dirty = useRef(false);

    const flush = async () => {
        if (!dirty.current) return;
        dirty.current = false;
        await updatePlan(plan.id, () => draftRef.current);
    };
    const edit = (change: (current: Plan) => Plan) => {
        dirty.current = true;
        setDraft(change);
    };
    const editStep = (id: string, patch: Partial<PlanStep>) =>
        edit(current => {
            const named = patch.title === undefined ? current : withStepTitle(current, id, patch.title);
            return { ...named, steps: current.steps.map(step => (step.id === id ? { ...step, ...patch } : step)) };
        });
    const setConfirmed = (id: string, confirmed: boolean) =>
        edit(current => ({ ...current, decisions: current.decisions?.map(decision => (decision.id === id ? { ...decision, confirmed } : decision)) }));

    // biome-ignore lint/correctness/useExhaustiveDependencies: Each change of the draft starts the timer again.
    useEffect(() => {
        if (!dirty.current) return;
        const timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
        return () => clearTimeout(timer);
    }, [draft]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Save the last changes when the page closes.
    useEffect(() => () => void flush(), []);

    // An exploration replaces the steps in the file. Then the page shows them, with the first step to review open.
    const wasExploring = useRef(explore.running);
    useEffect(() => {
        if (wasExploring.current && !explore.running) {
            const fresh = cachedPlan(plan.id);
            if (fresh) {
                dirty.current = false;
                setDraft(fresh);
                setEditingSteps(new Set());
                setOpenSteps(new Set(firstToReview(fresh.steps)));
            }
        }
        wasExploring.current = explore.running;
    }, [explore.running, plan.id]);

    const promptRepos = useMemo<PromptRepo[]>(() => project.repos.map(path => ({ name: repoLabel(path), path })), [project.repos, repoLabel]);
    const target = draft.taskTarget;
    const source = useQuery({
        queryKey: taskQueryKeys.source(target?.connectionId),
        queryFn: () => api.tasks.source(target?.connectionId as string),
        enabled: !!target
    });
    const canCreateTasks = source.data?.capabilities.create === true;
    const problems = planProblems(draft, project.repos, canCreateTasks || source.isPending);
    const review = planReview(draft);
    const counts = planCounts(draft);
    const locked = explore.running || starting;
    const hasSteps = draft.steps.length > 0;
    const decisions = draft.decisions ?? [];
    const canExecute = !locked && hasSteps && problems.length === 0 && review.complete;

    const runExplore = async (withFeedback?: string) => {
        setError(undefined);
        if (!draft.idea.trim() && !withFeedback) {
            setError('Write the idea first.');
            setEditingIdea(true);
            return;
        }
        if (!withFeedback && hasSteps) {
            const ok = await confirmDialog({
                title: 'Explore the idea again?',
                message:
                    'The new proposal replaces the current steps and decisions. To keep the steps and change them, ask the agent to revise the plan instead.',
                confirmLabel: 'Explore again'
            });
            if (!ok) return;
        }
        await flush();
        setFeedback('');
        setEditingIdea(false);
        await explorePlan(plan.id, promptRepos, withFeedback);
    };

    const execute = async () => {
        setError(undefined);
        const lines = [
            `${counts.steps === 1 ? 'One step runs' : `${counts.steps} steps run one after the other`}. Each step gets a new worktree and a new agent.`,
            counts.pullRequests > 0
                ? `ShipWarden opens ${counts.pullRequests === 1 ? 'one pull request' : `${counts.pullRequests} pull requests`} when the agents finish. Steps in the same repository stack: each pull request targets the branch of the step before it.`
                : 'No step opens a pull request. The branches stay on this Mac.',
            counts.newTasks > 0 ? `ShipWarden makes ${counts.newTasks === 1 ? 'one new task' : `${counts.newTasks} new tasks`} first.` : '',
            'A step that ends without a commit waits for you.'
        ].filter(Boolean);
        const ok = await confirmDialog({ title: `Execute "${draft.title}"?`, message: lines.join('\n\n'), confirmLabel: 'Execute plan' });
        if (!ok) return;
        setStarting(true);
        try {
            await flush();
            await planRunner.execute(plan.id);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setStarting(false);
        }
    };

    /** Opens a step and scrolls to it. */
    const focusStep = (stepId: string) => {
        setStepOpen(stepId, true);
        scrollToElement(stepElementId(stepId));
    };
    // A step with a problem opens its editor, so that the user can fix it there.
    const showStep = (stepId: string) => {
        setStepEditing(stepId, true);
        scrollToElement(stepElementId(stepId));
    };
    /** Closes a step and opens the next step that needs a review. */
    const moveOn = (stepId: string, steps: readonly PlanStep[]) => {
        setStepOpen(stepId, false);
        toggle(setEditingSteps, stepId, false);
        const next = nextToReview(steps, stepId);
        if (next) focusStep(next.id);
    };
    const looksGood = (stepId: string) => {
        const steps = draft.steps.map(step => (step.id === stepId ? { ...step, reviewed: true } : step));
        editStep(stepId, { reviewed: true });
        moveOn(stepId, steps);
    };
    const changeDecision = (decision: PlanDecision, change: string) =>
        runExplore(
            `Change this decision: "${decision.text}"\n\nThe user wants this instead: ${change.trim()}\n\nWrite the new decision in the decisions list. Change only the steps that the decision affects.`
        );
    // A new step is empty. Thus it opens in the editor.
    const addStep = () => {
        const step = newStep(project.repos.length === 1 ? project.repos[0] : undefined);
        edit(current => ({ ...current, steps: [...current.steps, step] }));
        setStepEditing(step.id, true);
    };
    const repoNames = listText(project.repos.map(repoLabel));
    const groups = repoGroups(draft.steps, project.repos, repoColor);
    const toReview = draft.steps.filter(step => !step.skip && !step.reviewed);
    const shown = filter === 'open' ? toReview : draft.steps;

    return (
        <div className="flow-page plan-page">
            <PlanHeader
                stage={hasSteps && !explore.running ? 'review' : 'explore'}
                title={
                    <input
                        className="flow-title-input"
                        value={draft.title}
                        maxLength={MAX_TITLE_LENGTH}
                        aria-label="Plan title"
                        onChange={event => edit(current => ({ ...current, title: event.target.value }))}
                    />
                }
                status={<Chip tone={PLAN_STATUS_TONES.draft}>{PLAN_STATUS_LABELS.draft}</Chip>}
                actions={
                    <>
                        {hasSteps && review.steps > 0 && <ReviewProgress reviewed={review.reviewedSteps} total={review.steps} />}
                        {hasSteps && (
                            <Button icon={<RefreshCw size={13} />} disabled={locked || project.repos.length === 0} onClick={() => void runExplore()}>
                                Explore again
                            </Button>
                        )}
                        {hasSteps && (
                            <Button
                                variant="primary"
                                icon={<Play size={14} />}
                                disabled={!canExecute}
                                title={canExecute ? undefined : problems.length > 0 ? 'Fix the problems first.' : reviewText(review)}
                                onClick={() => void execute()}
                            >
                                {starting ? 'Starting…' : 'Execute plan'}
                            </Button>
                        )}
                        <IconButton
                            label="More"
                            icon={<MoreHorizontal size={14} />}
                            onClick={event => void planMenu(draft, event.currentTarget, { onClosed, onOpenPlan, onOpenGroup })}
                        />
                    </>
                }
            />

            <div className={`flow-layout${hasSteps ? ' with-outline' : ''}`}>
                {hasSteps && (
                    <PlanOutline
                        groups={groups}
                        decisions={decisions}
                        openSteps={openSteps}
                        repoLabel={repoLabel}
                        onIdea={() => scrollToElement(IDEA_ID)}
                        onDecisions={() => scrollToElement(DECISIONS_ID)}
                        onStep={focusStep}
                    />
                )}

                <div className="flow-main">
                    <Card as="section" className="plan-idea-card" id={IDEA_ID}>
                        <CardBody>
                            {explore.running ? (
                                <>
                                    <IdeaText
                                        text={draft.idea}
                                        actions={
                                            <Button icon={<X size={14} />} onClick={() => void cancelExplore(plan.id)}>
                                                Cancel
                                            </Button>
                                        }
                                    />
                                    <div className="plan-idea-note">
                                        <Loader2 size={14} className="spin" aria-hidden="true" /> The agent reads {repoNames}. This can take a few minutes. You
                                        can leave this page.
                                    </div>
                                </>
                            ) : !hasSteps || editingIdea ? (
                                <>
                                    <label className="flow-label" htmlFor={`plan-idea-${plan.id}`}>
                                        Idea
                                    </label>
                                    <div className="plan-idea-note">
                                        {project.repos.length === 0
                                            ? `${project.name} has no repositories. Add a repository to the project first.`
                                            : `What do you want to try? The agent reads ${repoNames}. It does not change files.`}
                                    </div>
                                    <TextArea
                                        id={`plan-idea-${plan.id}`}
                                        className="plan-idea"
                                        value={draft.idea}
                                        disabled={locked}
                                        autoFocus={editingIdea}
                                        placeholder="For example: Add a dark mode to the web app and the API settings, with a toggle in the user menu."
                                        onChange={event => edit(current => ({ ...current, idea: event.target.value }))}
                                    />
                                    <div className="plan-idea-buttons">
                                        {hasSteps && <Button onClick={() => setEditingIdea(false)}>Done</Button>}
                                        <Button
                                            variant={hasSteps ? 'secondary' : 'primary'}
                                            icon={<Sparkles size={14} />}
                                            disabled={locked || project.repos.length === 0}
                                            onClick={() => void runExplore()}
                                        >
                                            {hasSteps ? 'Explore again' : 'Explore with an agent'}
                                        </Button>
                                    </div>
                                </>
                            ) : (
                                <ApproachView plan={draft} repoNames={repoNames} disabled={locked} onEditIdea={() => setEditingIdea(true)} />
                            )}
                            {explore.error && <div className="form-error">{explore.error}</div>}
                        </CardBody>
                    </Card>

                    {hasSteps && decisions.length > 0 && (
                        <DecisionList
                            decisions={decisions}
                            disabled={locked}
                            onConfirm={id => setConfirmed(id, true)}
                            onReopen={id => setConfirmed(id, false)}
                            onChange={(decision, change) => void changeDecision(decision, change)}
                        />
                    )}

                    <section className="plan-steps-section">
                        <div className="plan-section-head">
                            <h3>Steps</h3>
                            {hasSteps ? (
                                <div className="plan-section-tools">
                                    <ButtonGroup size="sm" role="radiogroup" label="Show steps" onKeyDown={radioGroupKeys}>
                                        <Button size="sm" role="radio" aria-checked={filter === 'all'} onClick={() => setFilter('all')}>
                                            All <Count value={draft.steps.length} />
                                        </Button>
                                        <Button size="sm" role="radio" aria-checked={filter === 'open'} onClick={() => setFilter('open')}>
                                            Not reviewed <Count value={toReview.length} />
                                        </Button>
                                    </ButtonGroup>
                                    {openSteps.size > 0 ? (
                                        <Button size="sm" onClick={() => setOpenSteps(new Set(editingSteps))}>
                                            Collapse all
                                        </Button>
                                    ) : (
                                        <Button size="sm" onClick={() => setOpenSteps(new Set(draft.steps.map(step => step.id)))}>
                                            Expand all
                                        </Button>
                                    )}
                                </div>
                            ) : (
                                <span className="plan-section-note">Explore the idea with an agent, or add the steps yourself.</span>
                            )}
                        </div>
                        <div className="plan-steps">
                            {shown.map(step => {
                                const index = draft.steps.indexOf(step);
                                const editing = editingSteps.has(step.id) && !locked;
                                return (
                                    <StepCard
                                        key={step.id}
                                        step={step}
                                        index={index}
                                        count={draft.steps.length}
                                        stackedOn={stackedOnIndex(draft.steps, index)}
                                        next={nextToReview(draft.steps, step.id)}
                                        problems={problems.filter(problem => problem.stepId === step.id)}
                                        repos={project.repos}
                                        repoLabel={repoLabel}
                                        target={target}
                                        disabled={locked}
                                        open={openSteps.has(step.id) || editing}
                                        editing={editing}
                                        onOpen={on => {
                                            setStepOpen(step.id, on);
                                            if (!on) toggle(setEditingSteps, step.id, false);
                                        }}
                                        onEditing={on => setStepEditing(step.id, on)}
                                        onChange={patch => editStep(step.id, patch)}
                                        onLooksGood={() => looksGood(step.id)}
                                        onSkipForNow={() => moveOn(step.id, draft.steps)}
                                        onMove={delta =>
                                            edit(current => {
                                                const steps = [...current.steps];
                                                const to = index + delta;
                                                if (to < 0 || to >= steps.length) return current;
                                                [steps[index], steps[to]] = [steps[to], steps[index]];
                                                return { ...current, steps };
                                            })
                                        }
                                        onRemove={() => edit(current => ({ ...current, steps: current.steps.filter(item => item.id !== step.id) }))}
                                    />
                                );
                            })}
                            {filter === 'open' && shown.length === 0 && hasSteps && <div className="plan-steps-empty">All steps are reviewed.</div>}
                            {filter === 'all' && (
                                <button type="button" className="flow-add" disabled={locked} onClick={addStep}>
                                    <Plus size={15} /> Add step
                                </button>
                            )}
                        </div>
                    </section>

                    {hasSteps && (
                        <Card as="section" className="plan-revise">
                            <CardBody>
                                <label className="plan-revise-title" htmlFor={`plan-feedback-${plan.id}`}>
                                    <Sparkles size={15} /> Ask the agent to revise
                                </label>
                                <div className="plan-revise-row">
                                    <TextArea
                                        id={`plan-feedback-${plan.id}`}
                                        className="plan-feedback"
                                        value={feedback}
                                        disabled={locked}
                                        placeholder="For example: Merge steps 1 and 2. Put the API change first."
                                        onChange={event => setFeedback(event.target.value)}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && feedback.trim() && !locked) {
                                                event.preventDefault();
                                                void runExplore(feedback);
                                            }
                                        }}
                                    />
                                    <IconButton
                                        variant="outline"
                                        label="Revise the plan"
                                        title="Revise the plan (⌘↩)"
                                        icon={<ArrowRight size={14} />}
                                        disabled={locked || !feedback.trim()}
                                        onClick={() => void runExplore(feedback)}
                                    />
                                </div>
                                <div className="plan-idea-note">Steps that need no change stay as they are. A changed step needs a new review.</div>
                            </CardBody>
                        </Card>
                    )}
                </div>

                <aside className="flow-side">
                    {hasSteps && <WhatWillRun groups={groups} repoLabel={repoLabel} onStep={focusStep} />}
                    <RunSettings
                        draft={draft}
                        disabled={locked}
                        canCreateTasks={canCreateTasks}
                        onChange={patch => edit(current => ({ ...current, ...patch }))}
                    />
                    <ReviewGate
                        plan={draft}
                        review={review}
                        problems={problems}
                        hasSteps={hasSteps}
                        error={error}
                        onProblem={showStep}
                        onDecisions={() => scrollToElement(DECISIONS_ID)}
                        onNextStep={() => {
                            const next = nextToReview(draft.steps);
                            if (next) focusStep(next.id);
                        }}
                    />
                </aside>
            </div>
        </div>
    );
}

const IDEA_ID = 'plan-idea-card';
const DECISIONS_ID = 'plan-decisions';

/** Scrolls to an element after the next render. */
function scrollToElement(id: string): void {
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

/** Returns the ID of the first step that needs a review, as a list with one or zero items. */
function firstToReview(steps: readonly PlanStep[]): string[] {
    const step = nextToReview(steps);
    return step ? [step.id] : [];
}

/**
 * Returns the next step that needs a review: the first one after the step with the ID, or else the first one before it.
 * Without an ID, returns the first step that needs a review.
 */
function nextToReview(steps: readonly PlanStep[], afterId?: string): PlanStep | undefined {
    const at = afterId ? steps.findIndex(step => step.id === afterId) : -1;
    const needs = (step: PlanStep) => !step.skip && !step.reviewed && step.id !== afterId;
    return steps.slice(at + 1).find(needs) ?? steps.slice(0, Math.max(at, 0)).find(needs);
}

/** The steps of one repository, in the order of the plan. */
interface RepoGroup {
    repo: string | undefined;
    /** The color of the repository: the color from its settings, or else a color from its place in the project. */
    color: string;
    steps: { step: PlanStep; index: number }[];
}

/** Groups the steps by repository, in the order of the first step of each repository. */
function repoGroups(steps: readonly PlanStep[], repos: readonly string[], repoColor: (repo: string) => RepoColor | undefined): RepoGroup[] {
    const groups: RepoGroup[] = [];
    steps.forEach((step, index) => {
        let group = groups.find(item => item.repo === step.repo);
        if (!group) {
            const set = step.repo ? repoColor(step.repo) : undefined;
            const at = step.repo ? repos.indexOf(step.repo) : -1;
            const fallback = FALLBACK_REPO_COLORS[(at >= 0 ? at : groups.length) % FALLBACK_REPO_COLORS.length];
            group = { repo: step.repo, color: set ? REPO_COLORS[set] : fallback, steps: [] };
            groups.push(group);
        }
        group.steps.push({ step, index });
    });
    return groups;
}

/** The colors of the repositories that have no color in their settings: the hues of the label palette. */
const FALLBACK_REPO_COLORS = ['#6f8fc7', '#9a82c9', '#7fae8a', '#c69a5e', '#6fb0b8'];

/** The CSS variable of the color of a repository group. */
function repoStyle(group: RepoGroup): CSSProperties {
    return { '--repo': group.color } as CSSProperties;
}

/** The bar in the header: how many steps the user reviewed. */
function ReviewProgress({ reviewed, total }: { reviewed: number; total: number }) {
    return (
        <div className="plan-progress" title={`${reviewed} of ${total} steps are reviewed`}>
            <div className="plan-progress-text">
                <span>Reviewed</span>
                <strong>
                    {reviewed} of {pluralize(total, 'step')}
                </strong>
            </div>
            <div className="plan-progress-track">
                <span className="plan-progress-fill" style={{ width: `${total > 0 ? (reviewed / total) * 100 : 0}%` }} />
            </div>
        </div>
    );
}

/** The outline at the left: the idea, the decisions and the steps of each repository. A click scrolls to the item. */
function PlanOutline({
    groups,
    decisions,
    openSteps,
    repoLabel,
    onIdea,
    onDecisions,
    onStep
}: {
    groups: RepoGroup[];
    decisions: PlanDecision[];
    openSteps: ReadonlySet<string>;
    repoLabel(repo: string): string;
    onIdea(): void;
    onDecisions(): void;
    onStep(id: string): void;
}) {
    const open = decisions.filter(decision => !decision.confirmed).length;
    return (
        <nav className="plan-outline" aria-label="Plan outline">
            <div className="flow-label">Outline</div>
            <button type="button" className="plan-outline-link" onClick={onIdea}>
                Idea and approach
            </button>
            {decisions.length > 0 && (
                <button type="button" className="plan-outline-link" onClick={onDecisions}>
                    <span>Decisions to confirm</span>
                    {open > 0 ? <Chip tone="warning">{open} open</Chip> : <Check size={14} className="plan-outline-check" aria-label="All confirmed" />}
                </button>
            )}
            {groups.map(group => {
                const active = group.steps.filter(({ step }) => !step.skip);
                return (
                    <div key={group.repo ?? ''} className="plan-outline-group">
                        <div className="plan-outline-repo">
                            <span className="plan-repo-dot" style={repoStyle(group)} />
                            <span className="plan-outline-repo-name">{group.repo ? repoLabel(group.repo) : 'No repository'}</span>
                            <span className="plan-outline-count">
                                {active.filter(({ step }) => step.reviewed).length}/{active.length}
                            </span>
                        </div>
                        {group.steps.map(({ step, index }) => (
                            <button
                                key={step.id}
                                type="button"
                                className={`plan-outline-step${openSteps.has(step.id) ? ' active' : ''}${step.skip ? ' skipped' : ''}`}
                                onClick={() => onStep(step.id)}
                            >
                                <span className="plan-outline-number">{index + 1}</span>
                                <span className="plan-outline-title">{step.title.trim() || 'No title'}</span>
                                {step.reviewed && !step.skip && <Check size={13} className="plan-outline-check" aria-label="Reviewed" />}
                            </button>
                        ))}
                    </div>
                );
            })}
        </nav>
    );
}

/**
 * The idea card of a plan with steps: the approach of the agent and its key facts. "Show full write-up" opens the idea
 * of the user and the full answer of the agent. A plan from an older version has no approach. It shows the idea.
 */
function ApproachView({ plan, repoNames, disabled, onEditIdea }: { plan: Plan; repoNames: string; disabled: boolean; onEditIdea(): void }) {
    const [full, setFull] = useState(false);
    const approach = plan.approach?.trim();
    const hasWriteUp = !!approach && (!!plan.idea.trim() || !!plan.summary);
    return (
        <>
            <div className="plan-card-head">
                <h3 className="plan-card-title">Idea</h3>
                <div className="plan-idea-actions">
                    <Button size="sm" disabled={disabled} onClick={onEditIdea}>
                        Edit idea
                    </Button>
                    {hasWriteUp && (
                        <Button size="sm" aria-expanded={full} onClick={() => setFull(value => !value)}>
                            {full ? 'Hide full write-up' : 'Show full write-up'}
                        </Button>
                    )}
                </div>
            </div>
            {approach ? (
                <Markdown className="plan-summary plan-approach" text={approach} />
            ) : (
                <>
                    <div className={`plan-idea-body open${plan.idea.trim() ? '' : ' empty'}`}>
                        {plan.idea.trim() || 'No idea. You wrote the steps yourself.'}
                    </div>
                    {plan.summary && <Markdown className="plan-summary plan-idea-summary" text={plan.summary} />}
                </>
            )}
            {plan.highlights && plan.highlights.length > 0 && (
                <dl className="plan-highlights">
                    {plan.highlights.map(item => (
                        <div key={item.label} className="plan-highlight">
                            <dt className="flow-label">{item.label}</dt>
                            <dd>{item.text}</dd>
                        </div>
                    ))}
                </dl>
            )}
            {full && (
                <div className="plan-write-up">
                    {plan.idea.trim() && (
                        <>
                            <div className="flow-label">Your idea</div>
                            <div className="plan-idea-body open">{plan.idea}</div>
                        </>
                    )}
                    {plan.summary && (
                        <>
                            <div className="flow-label">The answer of the agent</div>
                            <Markdown className="plan-summary" text={plan.summary} />
                        </>
                    )}
                </div>
            )}
            {plan.agent && (
                <div className="plan-idea-note">
                    {plan.agent} read {repoNames} and proposed the steps. It did not change files.
                </div>
            )}
        </>
    );
}

/** The decisions of the agent. The user confirms each one, or asks the agent to change it. */
function DecisionList({
    decisions,
    disabled,
    onConfirm,
    onReopen,
    onChange
}: {
    decisions: PlanDecision[];
    disabled: boolean;
    onConfirm(id: string): void;
    onReopen(id: string): void;
    onChange(decision: PlanDecision, change: string): void;
}) {
    const [changing, setChanging] = useState<string>();
    const [change, setChange] = useState('');
    const submit = (decision: PlanDecision) => {
        if (!change.trim()) return;
        onChange(decision, change);
        setChanging(undefined);
        setChange('');
    };
    return (
        <Card as="section" className="plan-decisions" id={DECISIONS_ID}>
            <CardBody>
                <div className="plan-card-head">
                    <h3 className="plan-card-title">Decisions to confirm</h3>
                    <span className="plan-section-note">To change a decision, the agent revises the steps that it affects.</span>
                </div>
                <ul className="plan-decision-list">
                    {decisions.map(decision => (
                        <li key={decision.id} className={`plan-decision${decision.confirmed ? ' confirmed' : ''}`}>
                            <div className="plan-decision-row">
                                <span className="plan-decision-mark" aria-hidden="true">
                                    {decision.confirmed ? <Check size={12} strokeWidth={3} /> : '?'}
                                </span>
                                <div className="plan-decision-text">
                                    <div>{decision.text}</div>
                                    {decision.detail && <div className="plan-decision-detail">{decision.detail}</div>}
                                </div>
                                <div className="plan-decision-tools">
                                    {decision.confirmed ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            title="Open the decision again"
                                            disabled={disabled}
                                            onClick={() => onReopen(decision.id)}
                                        >
                                            Confirmed
                                        </Button>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                disabled={disabled}
                                                aria-expanded={changing === decision.id}
                                                onClick={() => {
                                                    setChanging(current => (current === decision.id ? undefined : decision.id));
                                                    setChange('');
                                                }}
                                            >
                                                Change
                                            </Button>
                                            <Button size="sm" variant="primary" disabled={disabled} onClick={() => onConfirm(decision.id)}>
                                                Confirm
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>
                            {changing === decision.id && (
                                <div className="plan-decision-change">
                                    <TextArea
                                        className="plan-feedback"
                                        value={change}
                                        autoFocus
                                        disabled={disabled}
                                        aria-label={`What you want instead of: ${decision.text}`}
                                        placeholder="What do you want instead?"
                                        onChange={event => setChange(event.target.value)}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                                event.preventDefault();
                                                submit(decision);
                                            }
                                            if (event.key === 'Escape') setChanging(undefined);
                                        }}
                                    />
                                    <div className="plan-idea-buttons">
                                        <Button size="sm" onClick={() => setChanging(undefined)}>
                                            Cancel
                                        </Button>
                                        <Button size="sm" icon={<Sparkles size={13} />} disabled={disabled || !change.trim()} onClick={() => submit(decision)}>
                                            Revise the plan
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            </CardBody>
        </Card>
    );
}

/** The steps of each repository as squares. A filled square is a reviewed step. A click opens the step. */
function WhatWillRun({ groups, repoLabel, onStep }: { groups: RepoGroup[]; repoLabel(repo: string): string; onStep(id: string): void }) {
    return (
        <Card as="section" className="flow-card">
            <CardBody className="flow-card-body">
                <h3 className="plan-card-title">What will run</h3>
                {groups.map(group => {
                    const active = group.steps.filter(({ step }) => !step.skip);
                    if (active.length === 0) return null;
                    const prs = active.filter(({ step }) => step.pullRequest).length;
                    const prText = prs === 0 ? 'No pull request' : prs === 1 ? '1 PR' : `${prs} stacked PRs`;
                    return (
                        <div key={group.repo ?? ''} className="plan-run-repo">
                            <div className="plan-run-repo-head">
                                <span>{group.repo ? repoLabel(group.repo) : 'No repository'}</span>
                                <span className="plan-section-note">{prText}</span>
                            </div>
                            <div className="plan-run-squares" style={repoStyle(group)}>
                                {active.map(({ step, index }) => (
                                    <button
                                        key={step.id}
                                        type="button"
                                        className={`plan-run-square${step.reviewed ? ' reviewed' : ''}${step.pullRequest ? '' : ' experiment'}`}
                                        title={`Step ${index + 1}: ${step.title || 'No title'}${step.reviewed ? ' (reviewed)' : ''}`}
                                        aria-label={`Step ${index + 1}: ${step.title || 'No title'}`}
                                        onClick={() => onStep(step.id)}
                                    />
                                ))}
                            </div>
                        </div>
                    );
                })}
                <div className="flow-field-note">
                    Each square is one step. A filled square is a reviewed step. The steps run in order, and the steps in one repository stack.
                </div>
            </CardBody>
        </Card>
    );
}

/** The settings of a draft as a short list. "Edit" shows the fields. */
function RunSettings({
    draft,
    disabled,
    canCreateTasks,
    onChange
}: {
    draft: Plan;
    disabled: boolean;
    canCreateTasks: boolean;
    onChange(patch: Partial<Plan>): void;
}) {
    const [editing, setEditing] = useState(false);
    const connections = useQuery(connectionsQueryOptions());
    const target = draft.taskTarget;
    const connection = connections.data?.list.find(item => item.id === target?.connectionId);
    const tasks = target ? [connection?.name, target.collectionName].filter(Boolean).join(' · ') || 'Selected' : 'No task manager';
    const mode = draft.agentMode ? (AGENT_MODES.find(item => item.mode === draft.agentMode)?.label ?? draft.agentMode) : "The agent's own setting";
    const pullRequests = [draft.draftPullRequests ? 'Drafts' : 'Ready for review', draft.noPrGroup ? 'no PR group' : 'in a PR group'].join(', ');
    return (
        <Card as="section" className="flow-card">
            <CardBody className="flow-card-body">
                <div className="plan-card-head">
                    <h3 className="plan-card-title">Run settings</h3>
                    <Button size="sm" disabled={disabled} onClick={() => setEditing(value => !value)}>
                        {editing ? 'Done' : 'Edit'}
                    </Button>
                </div>
                {!editing && (
                    <dl className="plan-settings-list">
                        <div>
                            <dt>Tasks</dt>
                            <dd title={tasks}>{tasks}</dd>
                        </div>
                        <div>
                            <dt>Agent mode</dt>
                            <dd>{mode}</dd>
                        </div>
                        <div>
                            <dt>Pull requests</dt>
                            <dd>{pullRequests}</dd>
                        </div>
                        <div>
                            <dt>Isolation</dt>
                            <dd>New worktree per step</dd>
                        </div>
                    </dl>
                )}
            </CardBody>
            {editing && <PlanSettings draft={draft} disabled={disabled} canCreateTasks={canCreateTasks} onChange={onChange} />}
        </Card>
    );
}

/** The card that says what the user must still do before the plan can run. */
function ReviewGate({
    plan,
    review,
    problems,
    hasSteps,
    error,
    onProblem,
    onDecisions,
    onNextStep
}: {
    plan: Plan;
    review: PlanReview;
    problems: PlanProblem[];
    hasSteps: boolean;
    error: string | undefined;
    onProblem(stepId: string): void;
    onDecisions(): void;
    onNextStep(): void;
}) {
    const steps = review.steps - review.reviewedSteps;
    const ready = hasSteps && review.complete && problems.length === 0;
    const title = !hasSteps
        ? 'No steps yet'
        : ready
          ? 'Ready to run'
          : [
                steps > 0 ? `${pluralize(steps, 'step')} not reviewed` : '',
                review.openDecisions > 0 ? `${pluralize(review.openDecisions, 'decision')} open` : '',
                problems.length > 0 ? `${pluralize(problems.length, 'problem')} to fix` : ''
            ]
                .filter(Boolean)
                .join(', ');
    return (
        <Card as="section" className={`flow-card plan-gate${ready ? ' ready' : ''}`}>
            <CardBody className="flow-card-body">
                <h3 className="plan-card-title">{title}</h3>
                <div className="flow-field-note">
                    {!hasSteps
                        ? 'Explore the idea with an agent, or add the steps yourself.'
                        : ready
                          ? 'Each step gets a new worktree and a new agent. Use "Execute plan" at the top.'
                          : review.complete
                            ? executeNote(plan, problems)
                            : `${reviewText(review)} You must read each step and confirm each decision.`}
                </div>
                {hasSteps && !review.complete && (
                    <div className="flow-actions">
                        {review.openDecisions > 0 && (
                            <Button size="sm" onClick={onDecisions}>
                                Show the decisions
                            </Button>
                        )}
                        {steps > 0 && (
                            <Button size="sm" onClick={onNextStep}>
                                Review the next step
                            </Button>
                        )}
                    </div>
                )}
                {problems.length > 0 && (
                    <div className="flow-problems">
                        <div className="flow-problems-title">{pluralize(problems.length, 'thing')} to fix before the run</div>
                        <ul>
                            {problems.map(problem => (
                                <li key={problem.message}>
                                    {problem.stepId ? (
                                        <button type="button" className="flow-problem-link" onClick={() => onProblem(problem.stepId as string)}>
                                            {problem.message} <ArrowRight size={12} />
                                        </button>
                                    ) : (
                                        problem.message
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {error && <div className="form-error">{error}</div>}
            </CardBody>
        </Card>
    );
}

/** The ID of the element of a step, so that the list of problems can scroll to it. */
function stepElementId(stepId: string): string {
    return `plan-step-${stepId}`;
}

/** The line under the "Execute plan" button. */
function executeNote(plan: Plan, problems: readonly PlanProblem[]): string {
    if (problems.length === 0) return 'Each step gets a new worktree and a new agent.';
    const numbers = [...new Set(problems.flatMap(problem => (problem.stepId ? [plan.steps.findIndex(step => step.id === problem.stepId) + 1] : [])))];
    if (numbers.length === 0 || problems.some(problem => !problem.stepId)) return 'Fix the problems above to run.';
    return `Fix ${numbers.length === 1 ? 'step' : 'steps'} ${listText(numbers.map(String))} to run.`;
}

/** The settings of a draft: the collection for new tasks, the agent mode and draft pull requests. */
function PlanSettings({
    draft,
    disabled,
    canCreateTasks,
    onChange
}: {
    draft: Plan;
    disabled: boolean;
    canCreateTasks: boolean;
    onChange(patch: Partial<Plan>): void;
}) {
    const target = draft.taskTarget;
    const [connectionId, setConnectionId] = useState(target?.connectionId);
    const connections = useQuery(connectionsQueryOptions());
    const collections = useQuery({ ...collectionsQueryOptions(connectionId), enabled: !!connectionId, staleTime: 5 * 60_000 });
    const setTarget = (taskTarget: PlanTaskTarget | undefined) => onChange({ taskTarget });
    return (
        <CardBody className="flow-card-body plan-settings">
            <div className="flow-field">
                <div className="flow-field-label">Task manager</div>
                <Select
                    aria-label="Task manager"
                    value={connectionId ?? ''}
                    disabled={disabled}
                    options={[
                        { value: '', label: connections.isPending ? 'Loading…' : 'No task manager' },
                        ...(connections.data?.list ?? []).map(connection => ({ value: connection.id, label: connection.name }))
                    ]}
                    onChange={id => {
                        setConnectionId(id || undefined);
                        setTarget(undefined);
                    }}
                />
                {connectionId && (
                    <Combobox
                        className="plan-collection-picker"
                        value={target?.collectionId}
                        disabled={disabled}
                        groups={sortedGroups(
                            collections.data?.list ?? [],
                            collection => collection.path ?? '',
                            collection => ({ value: collection.id, label: collection.name })
                        )}
                        placeholder={collections.isPending ? 'Loading…' : (target?.collectionName ?? 'Select a collection')}
                        searchPlaceholder="Search collections"
                        onChange={id => {
                            const collection = collections.data?.list.find(item => item.id === id);
                            if (collection) setTarget({ connectionId, collectionId: collection.id, collectionName: collection.name });
                        }}
                    />
                )}
                {collections.error && <div className="form-error">{errorText(collections.error)}</div>}
                <div className="flow-field-note">
                    {target && !canCreateTasks
                        ? 'This task manager cannot make tasks. You can link existing tasks.'
                        : 'New tasks of the steps go into this collection. You can also link existing tasks from it.'}
                </div>
            </div>
            <div className="flow-field">
                <div className="flow-field-label">Agent mode</div>
                <Select
                    aria-label="Agent mode"
                    value={draft.agentMode ?? ''}
                    disabled={disabled}
                    options={[{ value: '', label: "The agent's own setting" }, ...AGENT_MODES.map(item => ({ value: item.mode, label: item.label }))]}
                    onChange={mode => onChange({ agentMode: (mode || undefined) as AgentMode | undefined })}
                />
                <div className="flow-field-note">A mode without questions runs the plan without you.</div>
            </div>
            <div className="flow-toggle-row">
                <span className="flow-field-label">Open pull requests as drafts</span>
                <Switch
                    title="Open pull requests as drafts"
                    checked={draft.draftPullRequests}
                    disabled={disabled}
                    onChange={value => onChange({ draftPullRequests: value })}
                />
            </div>
            <div className="flow-toggle-row">
                <span className="flow-field-label">Put the pull requests in a PR group</span>
                <Switch
                    title="Put the pull requests of the plan in a PR group with the title of the plan"
                    checked={!draft.noPrGroup}
                    disabled={disabled}
                    onChange={value => onChange({ noPrGroup: value ? undefined : true })}
                />
            </div>
        </CardBody>
    );
}

type TaskChoice = StepTask['kind'];

const TASK_CHOICES: { value: TaskChoice; label: string }[] = [
    { value: 'none', label: 'No task' },
    { value: 'new', label: 'New task' },
    { value: 'existing', label: 'Existing task' }
];

/** The number of a step and the line to the next step. The line has a color when the next step stacks on this one. */
function StepRail({ index, last, nextStacks }: { index: number; last: boolean; nextStacks: boolean }) {
    return (
        <div className="plan-step-rail">
            <span className="plan-step-number">{index + 1}</span>
            {!last && <span className={`plan-step-line${nextStacks ? ' stacked' : ''}`} />}
        </div>
    );
}

/** The chips of a step: the repository, the stack, the pull request and the task. */
function StepChips({
    step,
    stackedOn,
    repoLabel,
    target
}: {
    step: PlanStep;
    stackedOn: number;
    repoLabel(repo: string): string;
    target: PlanTaskTarget | undefined;
}) {
    return (
        <div className="plan-step-chips">
            {step.skip && <Chip>Skipped</Chip>}
            {step.repo ? <Chip>{repoLabel(step.repo)}</Chip> : <Chip tone="warning">No repository</Chip>}
            {stackedOn >= 0 && (
                <Chip tone="info" icon={<Layers size={12} />} title="This step starts from the branch of the earlier step.">
                    Stacks on step {stackedOn + 1}
                </Chip>
            )}
            <Chip title={step.pullRequest ? undefined : 'An experiment. Its branch stays on this Mac.'}>
                {step.pullRequest ? '1 pull request' : 'Experiment'}
            </Chip>
            {step.task.kind === 'new' && <Chip>New task</Chip>}
            {step.task.kind === 'existing' && <Chip mono={!!step.task.link.key}>{step.task.link.key ?? step.task.link.title}</Chip>}
            {step.task.kind === 'none' && target && (
                <Chip
                    tone="warning"
                    icon={<CircleAlert size={12} />}
                    title="This step has no task. Edit the step to make a new task or to link an existing task."
                >
                    No task
                </Chip>
            )}
        </div>
    );
}

/** The number of a step in a circle. A reviewed step has a green circle. */
function StepNumber({ index, reviewed }: { index: number; reviewed: boolean }) {
    return <span className={`plan-step-number${reviewed ? ' reviewed' : ''}`}>{index + 1}</span>;
}

/** The text under the title of a closed step: the repository, the stack, the task and the pull request. */
function stepMetaText(step: PlanStep, stackedOn: number, repoLabel: (repo: string) => string): string {
    const task = step.task.kind === 'new' ? 'New task' : step.task.kind === 'existing' ? (step.task.link.key ?? step.task.link.title) : undefined;
    return [
        step.repo ? repoLabel(step.repo) : 'No repository',
        stackedOn >= 0 ? `stacks on ${stackedOn + 1}` : '',
        task,
        step.pullRequest ? 'Pull request' : 'Experiment'
    ]
        .filter(Boolean)
        .join(' · ');
}

/**
 * One step of a draft. A closed step shows one line. An open step shows its summary, the files it changes and the
 * prompt of the agent. The user reviews each step: "Looks good" marks it and opens the next step. "Edit" opens the editor.
 */
function StepCard({
    step,
    index,
    count,
    stackedOn,
    next,
    problems,
    repos,
    repoLabel,
    target,
    disabled,
    open,
    editing,
    onOpen,
    onEditing,
    onChange,
    onLooksGood,
    onSkipForNow,
    onMove,
    onRemove
}: {
    step: PlanStep;
    index: number;
    count: number;
    /** The index of the step that this step stacks on, or -1. */
    stackedOn: number;
    /** The next step that needs a review. */
    next: PlanStep | undefined;
    problems: PlanProblem[];
    repos: string[];
    repoLabel(repo: string): string;
    target: PlanTaskTarget | undefined;
    disabled: boolean;
    open: boolean;
    /** True: the step shows the editor. False: the step shows read-only text. */
    editing: boolean;
    onOpen(open: boolean): void;
    onEditing(editing: boolean): void;
    onChange(patch: Partial<PlanStep>): void;
    onLooksGood(): void;
    onSkipForNow(): void;
    onMove(delta: number): void;
    onRemove(): void;
}) {
    // "Existing" without a link shows the picker. The step keeps no task until the user picks one.
    const [choice, setChoice] = useState<TaskChoice>(step.task.kind);
    const [prompt, setPrompt] = useState(false);
    const repoProblem = problems.some(problem => problem.field === 'repo');
    const reviewed = !!step.reviewed && !step.skip;
    const classes = ['plan-step-row', step.skip ? 'skipped' : '', problems.length > 0 ? 'invalid' : '', open ? 'open' : '', reviewed ? 'reviewed' : '']
        .filter(Boolean)
        .join(' ');
    const title = step.title.trim() || 'No title';

    if (!open) {
        return (
            <div className={classes} id={stepElementId(step.id)}>
                <Card className="plan-step flow-card">
                    <button type="button" className="plan-step-closed" aria-expanded={false} onClick={() => onOpen(true)}>
                        <StepNumber index={index} reviewed={reviewed} />
                        <div className="plan-step-heading">
                            <div className={`plan-step-name${step.title.trim() ? '' : ' empty'}`}>{title}</div>
                            <div className="plan-step-meta">{stepMetaText(step, stackedOn, repoLabel)}</div>
                        </div>
                        {problems.length > 0 && <Chip tone="warning">{pluralize(problems.length, 'problem')}</Chip>}
                        {step.skip && <Chip>Skipped</Chip>}
                        {!step.skip && step.task.kind === 'none' && target && (
                            <Chip tone="warning" icon={<CircleAlert size={12} />}>
                                No task
                            </Chip>
                        )}
                        {reviewed && <span className="plan-step-reviewed">Reviewed</span>}
                        <ChevronDown size={16} className="plan-step-chevron" aria-hidden="true" />
                    </button>
                </Card>
            </div>
        );
    }

    const menu = async (anchor: Element) => {
        const choice = await showContextMenu(
            [
                ...(index > 0 ? [{ id: 'up', label: 'Move up' }] : []),
                ...(index < count - 1 ? [{ id: 'down', label: 'Move down' }] : []),
                { id: 'skip', label: step.skip ? 'Include the step' : 'Skip the step' },
                ...(reviewed ? [{ id: 'unreview', label: 'Mark as not reviewed' }] : []),
                { id: 'remove', label: 'Remove the step', danger: true }
            ],
            anchor
        );
        if (choice === 'up') onMove(-1);
        if (choice === 'down') onMove(1);
        if (choice === 'skip') onChange({ skip: !step.skip });
        if (choice === 'unreview') onChange({ reviewed: false });
        if (choice === 'remove') onRemove();
    };
    const problemLines = problems.map(problem => (
        <div key={problem.message} className="plan-step-problem">
            <CircleAlert size={14} /> {problem.hint ?? problem.message}
        </div>
    ));

    return (
        <div className={`${classes}${editing ? ' editing' : ''}`} id={stepElementId(step.id)}>
            <Card className="plan-step flow-card">
                <CardBody className="plan-step-body">
                    <div className="plan-step-head">
                        <StepNumber index={index} reviewed={reviewed} />
                        {editing ? (
                            <input
                                className="plan-step-title"
                                value={step.title}
                                maxLength={MAX_TITLE_LENGTH}
                                placeholder="Step title"
                                disabled={disabled}
                                aria-label={`Title of step ${index + 1}`}
                                onChange={event => onChange({ title: event.target.value })}
                            />
                        ) : (
                            <button type="button" className="plan-step-toggle" aria-expanded={true} title="Close the step" onClick={() => onOpen(false)}>
                                <span className={`plan-step-name${step.title.trim() ? '' : ' empty'}`}>{title}</span>
                            </button>
                        )}
                        <div className="plan-step-tools">
                            {editing ? (
                                <Button size="sm" onClick={() => onEditing(false)}>
                                    Done
                                </Button>
                            ) : (
                                <Button size="sm" icon={<Pencil size={13} />} disabled={disabled} onClick={() => onEditing(true)}>
                                    Edit
                                </Button>
                            )}
                            <IconButton
                                size="sm"
                                label="More"
                                icon={<MoreHorizontal size={14} />}
                                disabled={disabled}
                                onClick={event => void menu(event.currentTarget)}
                            />
                        </div>
                    </div>
                    <div className="plan-step-content">
                        {!editing && <StepChips step={step} stackedOn={stackedOn} repoLabel={repoLabel} target={target} />}
                        {problemLines}
                        {editing ? (
                            <>
                                <div className="plan-step-fields">
                                    <span className="flow-field-label muted">Repository</span>
                                    <Select
                                        className="plan-repo-select"
                                        invalid={!!repoProblem}
                                        aria-label="Repository"
                                        value={step.repo ?? ''}
                                        disabled={disabled}
                                        placeholder="Choose repository"
                                        options={[
                                            { value: '', label: 'Choose repository', disabled: true },
                                            ...repos.map(repo => ({ value: repo, label: repoLabel(repo) }))
                                        ]}
                                        onChange={repo => onChange({ repo })}
                                    />
                                </div>
                                <TextArea
                                    className="plan-step-summary-input"
                                    value={step.summary ?? ''}
                                    placeholder="A short summary for you. The agent does not get it."
                                    disabled={disabled}
                                    aria-label={`Summary of step ${index + 1}`}
                                    onChange={event => onChange({ summary: event.target.value || undefined })}
                                />
                                <TextArea
                                    mono
                                    className="plan-step-description"
                                    value={step.description}
                                    placeholder="What the agent must do in this step, in Markdown."
                                    disabled={disabled}
                                    aria-label={`Instructions of step ${index + 1}`}
                                    onChange={event => onChange({ description: event.target.value })}
                                />
                                <div className="plan-step-fields">
                                    <span className="flow-field-label muted">Task</span>
                                    <Select
                                        className="plan-task-select"
                                        aria-label="Task"
                                        value={choice}
                                        disabled={disabled}
                                        options={TASK_CHOICES}
                                        onChange={value => {
                                            setChoice(value);
                                            if (value !== 'existing') onChange({ task: { kind: value } as StepTask });
                                        }}
                                    />
                                    {choice === 'existing' && (
                                        <TaskPicker
                                            target={target}
                                            value={step.task.kind === 'existing' ? step.task.link : undefined}
                                            disabled={disabled}
                                            onChange={link => onChange({ task: { kind: 'existing', link } })}
                                        />
                                    )}
                                    <Checkbox
                                        className="plan-check"
                                        title="Off: the step is an experiment. Its branch stays on this Mac."
                                        label="Open a pull request"
                                        checked={step.pullRequest}
                                        disabled={disabled}
                                        onChange={value => onChange({ pullRequest: value })}
                                    />
                                </div>
                            </>
                        ) : (
                            <>
                                {step.summary?.trim() && <div className="plan-step-summary">{step.summary}</div>}
                                {step.touches && step.touches.length > 0 && (
                                    <div>
                                        <div className="flow-label">Touches</div>
                                        <div className="plan-step-touches">
                                            {step.touches.map(item => (
                                                <Chip key={item} mono>
                                                    {item}
                                                </Chip>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {!step.description.trim() ? (
                                    <div className="plan-step-text empty">No instructions. Edit the step to tell the agent what to do.</div>
                                ) : step.summary?.trim() && !prompt ? (
                                    <Button variant="link" className="plan-step-prompt-toggle" onClick={() => setPrompt(true)}>
                                        Show the full agent prompt
                                    </Button>
                                ) : (
                                    <div>
                                        {step.summary?.trim() && <div className="flow-label">What the agent does</div>}
                                        <Markdown className="plan-summary plan-step-text" text={step.description} />
                                        {step.summary?.trim() && (
                                            <Button variant="link" className="plan-step-prompt-toggle" onClick={() => setPrompt(false)}>
                                                Hide the agent prompt
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </CardBody>
                <div className="plan-step-footer">
                    {step.skip ? (
                        <>
                            <span className="plan-step-footer-note">The plan does not run this step. It needs no review.</span>
                            <Button size="sm" disabled={disabled} onClick={() => onChange({ skip: false })}>
                                Include the step
                            </Button>
                        </>
                    ) : reviewed ? (
                        <>
                            <span className="plan-step-footer-note reviewed">
                                <CircleCheck size={14} /> Reviewed
                            </span>
                            <Button size="sm" disabled={disabled} onClick={() => onChange({ reviewed: false })}>
                                Mark as not reviewed
                            </Button>
                        </>
                    ) : (
                        <>
                            <span className="plan-step-footer-note">
                                {next ? `Next: ${next.title.trim() || 'No title'}` : 'This is the last step to review.'}
                            </span>
                            {next && (
                                <Button size="sm" disabled={disabled} onClick={onSkipForNow}>
                                    Skip for now
                                </Button>
                            )}
                            <Button size="sm" variant="primary" icon={<Check size={14} />} disabled={disabled || problems.length > 0} onClick={onLooksGood}>
                                {next ? 'Looks good, next step' : 'Looks good'}
                            </Button>
                        </>
                    )}
                </div>
            </Card>
        </div>
    );
}

/** A search field for an open task of the collection of the plan. */
function TaskPicker({
    target,
    value,
    disabled,
    onChange
}: {
    target: PlanTaskTarget | undefined;
    value: TaskLink | undefined;
    disabled: boolean;
    onChange(link: TaskLink): void;
}) {
    const tasks = useQuery({
        queryKey: [...keyRoots.plans, 'tasks', target?.connectionId, target?.collectionId],
        queryFn: () => loadCollectionTasks(target?.connectionId as string, target?.collectionId as string),
        enabled: !!target,
        staleTime: 5 * 60_000
    });
    if (!target) return <span className="plan-hint">Select a task manager and a collection in Settings.</span>;
    const open = (tasks.data?.tasks ?? []).filter(task => task.status.category !== 'done' && task.status.category !== 'canceled');
    const label = (task: { key?: string; title: string }) => (task.key ? `${task.key} ${task.title}` : task.title);
    return (
        <Combobox
            className="plan-task-picker"
            value={value?.taskId}
            disabled={disabled}
            groups={[{ label: '', items: open.map(task => ({ value: task.id, label: label(task) })) }]}
            placeholder={value ? label(value) : tasks.isPending ? 'Loading…' : 'Select a task'}
            searchPlaceholder="Search tasks"
            onChange={id => {
                const task = open.find(item => item.id === id);
                const pluginId = tasks.data?.source.pluginId;
                if (!task || !pluginId) return;
                onChange({
                    connectionId: target.connectionId,
                    pluginId,
                    taskId: task.id,
                    title: task.title,
                    ...(task.key ? { key: task.key } : {}),
                    ...(task.url ? { url: task.url } : {})
                });
            }}
        />
    );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Run                                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

function PlanRun({ plan, repoLabel, onOpenWorktree, onClosed, onOpenPlan, onOpenGroup }: Props) {
    const [error, setError] = useState<string>();
    const act = async (work: () => Promise<unknown>) => {
        setError(undefined);
        try {
            await work();
        } catch (err) {
            setError(errorText(err));
        }
    };
    const withPullRequests = plan.steps.filter(step => step.pullRequest && step.status !== 'skipped');
    const group = usePlanGroup(plan.id);
    const finished = plan.status === 'done';
    const done = plan.steps.filter(step => step.status === 'done').length;
    const ran = plan.steps.filter(step => step.status !== 'skipped').length;
    return (
        <div className="flow-page plan-page">
            <PlanHeader
                stage="run"
                finished={finished}
                title={<h2 className="flow-title">{plan.title}</h2>}
                status={<Chip tone={PLAN_STATUS_TONES[plan.status]}>{PLAN_STATUS_LABELS[plan.status]}</Chip>}
                actions={
                    <IconButton
                        label="More"
                        icon={<MoreHorizontal size={14} />}
                        onClick={event => void planMenu(plan, event.currentTarget, { onClosed, onOpenPlan, onOpenGroup })}
                    />
                }
            />

            <div className="flow-layout">
                <div className="flow-main">
                    {(plan.idea.trim() || plan.summary) && (
                        <Card as="section" className="plan-idea-card">
                            <CardBody>
                                {plan.idea.trim() && (
                                    <>
                                        <div className="flow-label">Idea</div>
                                        <div className="plan-idea-body">{plan.idea}</div>
                                    </>
                                )}
                                {plan.summary && <Markdown className="plan-summary plan-idea-summary" text={plan.summary} />}
                            </CardBody>
                        </Card>
                    )}

                    <section className="plan-steps-section">
                        <div className="plan-section-head">
                            <h3>Steps</h3>
                            <span className="plan-section-note">Each step runs in its own worktree with a new agent.</span>
                        </div>
                        <div className="plan-steps">
                            {plan.steps.map((step, index) => (
                                <StepRun
                                    key={step.id}
                                    plan={plan}
                                    step={step}
                                    index={index}
                                    finished={finished}
                                    repoLabel={repoLabel}
                                    onOpenWorktree={onOpenWorktree}
                                    act={act}
                                />
                            ))}
                        </div>
                    </section>
                </div>

                <aside className="flow-side">
                    <Card as="section">
                        <CardHeader
                            title={finished ? 'Run finished' : 'Run'}
                            description={[
                                `${done} of ${pluralize(ran, 'step')} done`,
                                plan.executedAt ? `started ${formatAgo(new Date(plan.executedAt).toISOString())}` : '',
                                plan.finishedAt ? `finished ${formatAgo(new Date(plan.finishedAt).toISOString())}` : ''
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        />
                        {(error || plan.status === 'running' || plan.status === 'paused') && (
                            <CardBody className="flow-card-body">
                                {error && <div className="form-error">{error}</div>}
                                <div className="flow-actions">
                                    {plan.status === 'running' && (
                                        <Button
                                            icon={<Pause size={14} />}
                                            title="Stop after the current step"
                                            onClick={() => void act(() => planRunner.pause(plan.id))}
                                        >
                                            Pause
                                        </Button>
                                    )}
                                    {plan.status === 'paused' && (
                                        <Button variant="primary" icon={<Play size={14} />} onClick={() => void act(() => planRunner.resume(plan.id))}>
                                            Resume
                                        </Button>
                                    )}
                                </div>
                            </CardBody>
                        )}
                        {withPullRequests.length > 0 && (
                            <CardBody className="flow-card-body">
                                <div className="flow-field-label">Merge order</div>
                                <div className="flow-field-note">A stacked pull request targets the branch of the step before it.</div>
                                <ol className="plan-merge-list">
                                    {withPullRequests.map(step => (
                                        <li key={step.id}>
                                            <span className="plan-merge-number">{plan.steps.indexOf(step) + 1}</span>
                                            <StepStatusChip step={step} />
                                            <div className="plan-merge-text">
                                                <div className="plan-merge-title">{step.title}</div>
                                                <div className="flow-field-note">
                                                    {step.repo ? repoLabel(step.repo) : ''}
                                                    {step.pr && ` · into ${step.pr.base}`}
                                                </div>
                                            </div>
                                            <div className="plan-merge-tools">
                                                {step.pr && (
                                                    <Button size="sm" icon={<GitPullRequest size={14} />} onClick={() => openLink(step.pr?.url ?? '')}>
                                                        #{step.pr.number}
                                                    </Button>
                                                )}
                                                {step.worktreePath && (
                                                    <Button
                                                        size="sm"
                                                        icon={<ArrowUpRight size={14} />}
                                                        title={`Open the worktree: ${step.worktreePath}`}
                                                        aria-label="Open the worktree"
                                                        onClick={() => onOpenWorktree(step.worktreePath as string, step.sessionId)}
                                                    />
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                </ol>
                                {group && (
                                    <div className="flow-actions">
                                        <Button
                                            size="sm"
                                            icon={<Layers size={14} />}
                                            title={`Open the PR group "${group.name}". An agent can review all pull requests of the plan together.`}
                                            onClick={() => onOpenGroup(group.id)}
                                        >
                                            PR group
                                        </Button>
                                    </div>
                                )}
                            </CardBody>
                        )}
                    </Card>
                </aside>
            </div>
        </div>
    );
}

/** The status chip of a step in the merge order, for example "Needs you". */
function StepStatusChip({ step }: { step: PlanStep }) {
    const status = useStepStatus(step);
    return (
        <Chip className="plan-merge-chip" tone={status.tone}>
            {status.label}
        </Chip>
    );
}

function StepRun({
    plan,
    step,
    index,
    finished,
    repoLabel,
    onOpenWorktree,
    act
}: {
    plan: Plan;
    step: PlanStep;
    index: number;
    finished: boolean;
    repoLabel(repo: string): string;
    onOpenWorktree(path: string, sessionId?: string): void;
    act(work: () => Promise<unknown>): Promise<void>;
}) {
    const link = step.task.kind === 'existing' ? step.task.link : undefined;
    const status = useStepStatus(step);
    const open = step.status === 'running' || step.status === 'attention' || step.status === 'failed';
    return (
        <div className={`plan-step-row run ${step.status}`}>
            <StepRail index={index} last={index === plan.steps.length - 1} nextStacks={stackedOnIndex(plan.steps, index + 1) === index} />
            <Card className="plan-step">
                <CardBody className="plan-step-body">
                    <div className="plan-step-head">
                        <div className="plan-step-heading">
                            <div className="plan-step-name">
                                <Chip tone={status.tone}>{status.label}</Chip> {step.title}
                            </div>
                            <div className="plan-step-meta">
                                {step.repo ? repoLabel(step.repo) : 'No repository'}
                                {step.branch && (
                                    <>
                                        {' · '}
                                        <code>{step.branch}</code>
                                        {step.baseBranch && (
                                            <>
                                                {' from '}
                                                <code>{step.baseBranch}</code>
                                            </>
                                        )}
                                    </>
                                )}
                                {!step.pullRequest && ' · experiment'}
                            </div>
                        </div>
                        <div className="plan-step-tools">
                            {step.pr && (
                                <Button size="sm" title={step.pr.url} icon={<GitPullRequest size={14} />} onClick={() => openLink(step.pr?.url ?? '')}>
                                    #{step.pr.number}
                                </Button>
                            )}
                            {link && (
                                <Button
                                    size="sm"
                                    title={link.url ?? link.title}
                                    icon={<SquareCheck size={14} />}
                                    disabled={!link.url}
                                    onClick={() => link.url && openLink(link.url)}
                                >
                                    {link.key ?? 'Task'}
                                </Button>
                            )}
                            {step.worktreePath && (
                                <Button
                                    size="sm"
                                    title={step.worktreePath}
                                    icon={<ArrowUpRight size={14} />}
                                    onClick={() => onOpenWorktree(step.worktreePath as string, step.sessionId)}
                                >
                                    Open
                                </Button>
                            )}
                        </div>
                    </div>
                    {step.detail && <div className="plan-step-detail">{step.detail}</div>}
                    {step.description.trim() && (
                        <details className="plan-step-details">
                            <summary>Instructions</summary>
                            <Markdown className="plan-summary" text={step.description} />
                        </details>
                    )}
                    {!finished && (open || step.status === 'pending') && (
                        <div className="plan-step-actions">
                            {step.status === 'attention' && step.worktreePath && (
                                <Button variant="accent" icon={<Check size={14} />} onClick={() => void act(() => planRunner.continueStep(plan.id, step.id))}>
                                    Continue
                                </Button>
                            )}
                            {step.status === 'attention' && step.worktreePath && (
                                <Button icon={<Send size={14} />} onClick={() => void act(() => planRunner.resendPrompt(plan.id, step.id))}>
                                    Send the prompt again
                                </Button>
                            )}
                            {step.status === 'running' && (
                                <Button
                                    title="Check the worktree for a new commit now"
                                    icon={<RotateCcw size={14} />}
                                    onClick={() => void act(() => planRunner.continueStep(plan.id, step.id))}
                                >
                                    Check now
                                </Button>
                            )}
                            {step.status === 'failed' && (
                                <Button
                                    variant="accent"
                                    icon={<RotateCcw size={14} />}
                                    onClick={() => void act(() => planRunner.continueStep(plan.id, step.id))}
                                >
                                    Try again
                                </Button>
                            )}
                            {open && (
                                <Button
                                    title="Continue with the next step. This step gets no pull request."
                                    icon={<CircleCheck size={14} />}
                                    onClick={() => void act(() => planRunner.markDone(plan.id, step.id))}
                                >
                                    Mark done
                                </Button>
                            )}
                            <Button icon={<SkipForward size={14} />} onClick={() => void act(() => planRunner.skipStep(plan.id, step.id))}>
                                Skip
                            </Button>
                        </div>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
