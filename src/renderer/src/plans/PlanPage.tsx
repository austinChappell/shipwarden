import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    ArrowDown,
    ArrowUp,
    ArrowUpRight,
    Check,
    CircleCheck,
    Loader2,
    EyeOff,
    GitPullRequest,
    MoreHorizontal,
    Pause,
    Play,
    Plus,
    RotateCcw,
    Send,
    SkipForward,
    Sparkles,
    SquareCheck,
    Trash2,
    X
} from 'lucide-react';
import { AGENT_MODES, type AgentMode } from '@shared/agent-modes';
import {
    MAX_TITLE_LENGTH,
    PLAN_STATUS_LABELS,
    STEP_STATUS_LABELS,
    duplicatePlan,
    newStep,
    planCounts,
    planProblems,
    type Plan,
    type PlanStep,
    type PlanTaskTarget,
    type PromptRepo,
    type StepTask
} from '@shared/plans';
import type { Project } from '@shared/projects';
import type { TaskLink } from '@shared/tasks';
import { Combobox, sortedGroups } from '../components/Combobox';
import { confirmDialog } from '../components/ConfirmDialog';
import { showContextMenu } from '../components/ContextMenu';
import { Markdown } from '../components/Markdown';
import { Select } from '../components/Select';
import { SettingsGroup, SettingsRow } from '../components/settings-ui';
import { collectionsQueryOptions, connectionsQueryOptions } from '../components/tasks/use-task-source';
import { taskQueryKeys } from '../components/tasks/task-view-logic';
import { loadCollectionTasks } from '../automations/engine';
import { openLink } from '../links';
import { keyRoots } from '../query-client';
import { errorText, timeAgo } from '../util';
import { cancelExplore, explorePlan } from './plan-explore';
import { cachedPlan, createPlan, removePlan, updatePlan, useExploreState } from './plan-queries';
import { planRunner } from './plan-runner';

const api = window.shipwarden;

/** The local changes of a draft go to the file after this pause in the typing. */
const SAVE_DELAY_MS = 400;

interface Props {
    plan: Plan;
    project: Project;
    repoLabel(repo: string): string;
    onOpenWorktree(path: string, sessionId?: string): void;
    /** The plan was deleted. */
    onClosed(): void;
    onOpenPlan(id: string): void;
}

/** One plan: the editor of a draft, or the steps of a plan that ran. */
export function PlanPage(props: Props) {
    return props.plan.status === 'draft' ? <PlanEditor {...props} /> : <PlanRun {...props} />;
}

/** The "More" menu of a plan: duplicate and delete. */
async function planMenu(plan: Plan, anchor: Element, onClosed: () => void, onOpenPlan: (id: string) => void): Promise<void> {
    const choice = await showContextMenu(
        [
            { id: 'duplicate', label: plan.status === 'draft' ? 'Duplicate' : 'Duplicate as a new draft' },
            { id: 'delete', label: 'Delete…', danger: true }
        ],
        anchor
    );
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
/* Draft                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

function PlanEditor({ plan, project, repoLabel, onClosed, onOpenPlan }: Props) {
    const explore = useExploreState(plan.id);
    const [draft, setDraft] = useState(plan);
    const [feedback, setFeedback] = useState('');
    const [error, setError] = useState<string>();
    const [starting, setStarting] = useState(false);
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
        edit(current => ({ ...current, steps: current.steps.map(step => (step.id === id ? { ...step, ...patch } : step)) }));

    // biome-ignore lint/correctness/useExhaustiveDependencies: Each change of the draft starts the timer again.
    useEffect(() => {
        if (!dirty.current) return;
        const timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
        return () => clearTimeout(timer);
    }, [draft]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Save the last changes when the page closes.
    useEffect(() => () => void flush(), []);

    // An exploration replaces the steps in the file. Then the page shows them.
    const wasExploring = useRef(explore.running);
    useEffect(() => {
        if (wasExploring.current && !explore.running) {
            const fresh = cachedPlan(plan.id);
            if (fresh) {
                dirty.current = false;
                setDraft(fresh);
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
    const counts = planCounts(draft);
    const locked = explore.running || starting;

    const runExplore = async (withFeedback?: string) => {
        setError(undefined);
        if (!draft.idea.trim() && !withFeedback) {
            setError('Write the idea first.');
            return;
        }
        if (!withFeedback && draft.steps.length > 0) {
            const ok = await confirmDialog({
                title: 'Explore the idea again?',
                message: 'The new proposal replaces the current steps. To keep the steps and change them, write feedback under "Revise" instead.',
                confirmLabel: 'Explore again'
            });
            if (!ok) return;
        }
        await flush();
        setFeedback('');
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

    return (
        <div className="settings-page plan-page">
            <div className="plan-title-row">
                <input
                    className="settings-input plan-title-input"
                    value={draft.title}
                    maxLength={MAX_TITLE_LENGTH}
                    aria-label="Plan title"
                    onChange={event => edit(current => ({ ...current, title: event.target.value }))}
                />
                <span className="plan-status draft">{PLAN_STATUS_LABELS.draft}</span>
                <button type="button" className="icon-button" title="More" onClick={event => void planMenu(draft, event.currentTarget, onClosed, onOpenPlan)}>
                    <MoreHorizontal size={14} />
                </button>
            </div>

            <SettingsGroup
                title="Idea"
                description={
                    project.repos.length === 0
                        ? `${project.name} has no repositories. Add a repository to the project first.`
                        : `What do you want to try? The agent reads the repositories of ${project.name} and does not change files.`
                }
            >
                <textarea
                    className="settings-input plan-idea"
                    value={draft.idea}
                    disabled={locked}
                    placeholder="For example: Add a dark mode to the web app and the API settings, with a toggle in the user menu."
                    onChange={event => edit(current => ({ ...current, idea: event.target.value }))}
                />
                <div className="plan-explore-row">
                    {explore.running ? (
                        <>
                            <span className="plan-explore-note">
                                <Loader2 size={14} className="spin" aria-hidden="true" /> The agent reads the repositories. This can take a few minutes. You can
                                leave this page.
                            </span>
                            <button type="button" className="button" onClick={() => void cancelExplore(plan.id)}>
                                <X size={14} /> Cancel
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            className="button primary-solid"
                            disabled={locked || project.repos.length === 0}
                            onClick={() => void runExplore()}
                        >
                            <Sparkles size={14} /> {draft.steps.length > 0 ? 'Explore again' : 'Explore with an agent'}
                        </button>
                    )}
                </div>
                {explore.error && <div className="form-error">{explore.error}</div>}
            </SettingsGroup>

            {draft.summary && (
                <SettingsGroup title="Approach" description={draft.agent ? `Proposed by ${draft.agent}.` : undefined}>
                    <Markdown className="plan-summary" text={draft.summary} />
                </SettingsGroup>
            )}

            <SettingsGroup
                title="Steps"
                description={
                    draft.steps.length === 0
                        ? 'Explore the idea with an agent, or add the steps yourself.'
                        : 'The steps run in this order. Steps in the same repository stack on the step before them.'
                }
                actions={
                    <button
                        type="button"
                        className="button"
                        disabled={locked}
                        onClick={() =>
                            edit(current => ({ ...current, steps: [...current.steps, newStep(project.repos.length === 1 ? project.repos[0] : undefined)] }))
                        }
                    >
                        <Plus size={14} /> Add step
                    </button>
                }
            >
                <div className="plan-steps">
                    {draft.steps.map((step, index) => (
                        <StepEditor
                            key={step.id}
                            step={step}
                            index={index}
                            count={draft.steps.length}
                            repos={project.repos}
                            repoLabel={repoLabel}
                            target={target}
                            disabled={locked}
                            onChange={patch => editStep(step.id, patch)}
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
                    ))}
                </div>
            </SettingsGroup>

            {draft.steps.length > 0 && (
                <SettingsGroup title="Revise" description="Tell the agent what to change. It keeps the steps that need no change.">
                    <textarea
                        className="settings-input plan-feedback"
                        value={feedback}
                        disabled={locked}
                        placeholder="For example: Merge steps 2 and 3. Put the API change first."
                        onChange={event => setFeedback(event.target.value)}
                    />
                    <div className="plan-explore-row">
                        <button type="button" className="button" disabled={locked || !feedback.trim()} onClick={() => void runExplore(feedback)}>
                            <Send size={14} /> Revise the plan
                        </button>
                    </div>
                </SettingsGroup>
            )}

            <PlanSettings draft={draft} disabled={locked} canCreateTasks={canCreateTasks} onChange={patch => edit(current => ({ ...current, ...patch }))} />

            <div className="plan-footer">
                {problems.length > 0 && (
                    <ul className="plan-problems">
                        {problems.map(problem => (
                            <li key={problem}>{problem}</li>
                        ))}
                    </ul>
                )}
                {error && <div className="form-error">{error}</div>}
                <button type="button" className="button primary-solid plan-execute" disabled={locked || problems.length > 0} onClick={() => void execute()}>
                    <Play size={14} /> {starting ? 'Starting…' : 'Execute plan'}
                </button>
            </div>
        </div>
    );
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
        <SettingsGroup title="Settings" card>
            <SettingsRow
                label="Task manager"
                description={
                    target && !canCreateTasks
                        ? 'This task manager cannot make tasks. You can link existing tasks.'
                        : 'New tasks of the steps go into this collection. You can also link existing tasks from it.'
                }
                control={
                    <div className="plan-inline">
                        <Select
                            className="settings-input"
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
                    </div>
                }
            />
            {collections.error && <div className="form-error">{errorText(collections.error)}</div>}
            <SettingsRow
                label="Agent mode"
                description="The permission mode of the agents of the steps. A mode without questions lets the plan run without you."
                control={
                    <Select
                        className="settings-input"
                        value={draft.agentMode ?? ''}
                        disabled={disabled}
                        options={[{ value: '', label: 'The setting of the agent' }, ...AGENT_MODES.map(item => ({ value: item.mode, label: item.label }))]}
                        onChange={mode => onChange({ agentMode: (mode || undefined) as AgentMode | undefined })}
                    />
                }
            />
            <SettingsRow
                label="Draft pull requests"
                description="Open the pull requests as drafts."
                control={
                    <label className="switch">
                        <input
                            type="checkbox"
                            checked={draft.draftPullRequests}
                            disabled={disabled}
                            onChange={event => onChange({ draftPullRequests: event.target.checked })}
                        />
                        <span />
                    </label>
                }
            />
        </SettingsGroup>
    );
}

type TaskChoice = StepTask['kind'];

const TASK_CHOICES: { value: TaskChoice; label: string }[] = [
    { value: 'none', label: 'No task' },
    { value: 'new', label: 'New task' },
    { value: 'existing', label: 'Existing task' }
];

/** The editor of one step of a draft. */
function StepEditor({
    step,
    index,
    count,
    repos,
    repoLabel,
    target,
    disabled,
    onChange,
    onMove,
    onRemove
}: {
    step: PlanStep;
    index: number;
    count: number;
    repos: string[];
    repoLabel(repo: string): string;
    target: PlanTaskTarget | undefined;
    disabled: boolean;
    onChange(patch: Partial<PlanStep>): void;
    onMove(delta: number): void;
    onRemove(): void;
}) {
    // "Existing" without a link shows the picker. The step keeps no task until the user picks one.
    const [choice, setChoice] = useState<TaskChoice>(step.task.kind);
    return (
        <div className={`plan-step${step.skip ? ' skipped' : ''}`}>
            <div className="plan-step-head">
                <span className="plan-step-number">{index + 1}</span>
                <input
                    className="settings-input plan-step-title"
                    value={step.title}
                    maxLength={MAX_TITLE_LENGTH}
                    placeholder="Step title"
                    disabled={disabled}
                    aria-label={`Title of step ${index + 1}`}
                    onChange={event => onChange({ title: event.target.value })}
                />
                <div className="plan-step-tools">
                    <button type="button" className="icon-button" title="Move up" disabled={disabled || index === 0} onClick={() => onMove(-1)}>
                        <ArrowUp size={14} />
                    </button>
                    <button type="button" className="icon-button" title="Move down" disabled={disabled || index === count - 1} onClick={() => onMove(1)}>
                        <ArrowDown size={14} />
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        title={step.skip ? 'Include the step' : 'Skip the step'}
                        aria-pressed={step.skip}
                        disabled={disabled}
                        onClick={() => onChange({ skip: !step.skip })}
                    >
                        <EyeOff size={14} />
                    </button>
                    <button type="button" className="icon-button" title="Remove the step" disabled={disabled} onClick={onRemove}>
                        <Trash2 size={14} />
                    </button>
                </div>
            </div>
            <textarea
                className="settings-input plan-step-description"
                value={step.description}
                placeholder="What the agent must do in this step, in Markdown."
                disabled={disabled}
                onChange={event => onChange({ description: event.target.value })}
            />
            <div className="plan-step-fields">
                <Select
                    className="settings-input"
                    aria-label="Repository"
                    value={step.repo ?? ''}
                    disabled={disabled}
                    options={[{ value: '', label: 'Select a repository', disabled: true }, ...repos.map(repo => ({ value: repo, label: repoLabel(repo) }))]}
                    onChange={repo => onChange({ repo })}
                />
                <Select
                    className="settings-input"
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
                <label className="plan-check" title="Off: the step is an experiment. Its branch stays on this Mac.">
                    <input type="checkbox" checked={step.pullRequest} disabled={disabled} onChange={event => onChange({ pullRequest: event.target.checked })} />
                    Open a pull request
                </label>
            </div>
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

function PlanRun({ plan, repoLabel, onOpenWorktree, onClosed, onOpenPlan }: Props) {
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
    const finished = plan.status === 'done';
    return (
        <div className="settings-page plan-page">
            <div className="plan-title-row">
                <h2 className="plan-title">{plan.title}</h2>
                <span className={`plan-status ${plan.status}`}>{PLAN_STATUS_LABELS[plan.status]}</span>
                {plan.status === 'running' && (
                    <button type="button" className="button" title="Stop after the current step" onClick={() => void act(() => planRunner.pause(plan.id))}>
                        <Pause size={14} /> Pause
                    </button>
                )}
                {plan.status === 'paused' && (
                    <button type="button" className="button primary-solid" onClick={() => void act(() => planRunner.resume(plan.id))}>
                        <Play size={14} /> Resume
                    </button>
                )}
                <button type="button" className="icon-button" title="More" onClick={event => void planMenu(plan, event.currentTarget, onClosed, onOpenPlan)}>
                    <MoreHorizontal size={14} />
                </button>
            </div>
            <div className="plan-dates">
                {plan.executedAt ? `Started ${timeAgo(new Date(plan.executedAt).toISOString())}` : ''}
                {plan.finishedAt ? ` · finished ${timeAgo(new Date(plan.finishedAt).toISOString())}` : ''}
            </div>
            {error && <div className="form-error">{error}</div>}

            {plan.idea.trim() && (
                <SettingsGroup title="Idea">
                    <Markdown className="plan-summary" text={plan.idea} />
                </SettingsGroup>
            )}
            {plan.summary && (
                <SettingsGroup title="Approach">
                    <Markdown className="plan-summary" text={plan.summary} />
                </SettingsGroup>
            )}

            {withPullRequests.length > 0 && (
                <SettingsGroup
                    title="Merge order"
                    description="Merge the pull requests in this order. A stacked pull request targets the branch of the step before it."
                    card
                >
                    {withPullRequests.map(step => (
                        <div key={step.id} className="settings-row plan-merge-row">
                            <div className="settings-row-main">
                                <div className="settings-row-text">
                                    <div className="settings-row-label">
                                        {plan.steps.indexOf(step) + 1}. {step.title}
                                    </div>
                                    <div className="settings-row-description">
                                        {step.repo ? repoLabel(step.repo) : ''}
                                        {step.pr ? ` · into ${step.pr.base}` : ` · ${STEP_STATUS_LABELS[step.status].toLowerCase()}`}
                                    </div>
                                </div>
                                {step.pr && (
                                    <button type="button" className="button" onClick={() => openLink(step.pr?.url ?? '')}>
                                        <GitPullRequest size={14} /> #{step.pr.number}
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </SettingsGroup>
            )}

            <SettingsGroup title="Steps">
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
            </SettingsGroup>
        </div>
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
    const open = step.status === 'running' || step.status === 'attention' || step.status === 'failed';
    return (
        <div className={`plan-step run ${step.status}`}>
            <div className="plan-step-head">
                <span className="plan-step-number">{index + 1}</span>
                <div className="plan-step-heading">
                    <div className="plan-step-name">
                        <span className={`step-status ${step.status}`}>{STEP_STATUS_LABELS[step.status]}</span> {step.title}
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
                        <button type="button" className="button" title={step.pr.url} onClick={() => openLink(step.pr?.url ?? '')}>
                            <GitPullRequest size={14} /> #{step.pr.number}
                        </button>
                    )}
                    {link && (
                        <button
                            type="button"
                            className="button"
                            title={link.url ?? link.title}
                            disabled={!link.url}
                            onClick={() => link.url && openLink(link.url)}
                        >
                            <SquareCheck size={14} /> {link.key ?? 'Task'}
                        </button>
                    )}
                    {step.worktreePath && (
                        <button
                            type="button"
                            className="button"
                            title={step.worktreePath}
                            onClick={() => onOpenWorktree(step.worktreePath as string, step.sessionId)}
                        >
                            <ArrowUpRight size={14} /> Open
                        </button>
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
                        <button type="button" className="button primary-solid" onClick={() => void act(() => planRunner.continueStep(plan.id, step.id))}>
                            <Check size={14} /> Continue
                        </button>
                    )}
                    {step.status === 'attention' && step.worktreePath && (
                        <button type="button" className="button" onClick={() => void act(() => planRunner.resendPrompt(plan.id, step.id))}>
                            <Send size={14} /> Send the prompt again
                        </button>
                    )}
                    {step.status === 'running' && (
                        <button
                            type="button"
                            className="button"
                            title="Check the worktree for a new commit now"
                            onClick={() => void act(() => planRunner.continueStep(plan.id, step.id))}
                        >
                            <RotateCcw size={14} /> Check now
                        </button>
                    )}
                    {step.status === 'failed' && (
                        <button type="button" className="button primary-solid" onClick={() => void act(() => planRunner.continueStep(plan.id, step.id))}>
                            <RotateCcw size={14} /> Try again
                        </button>
                    )}
                    {open && (
                        <button
                            type="button"
                            className="button"
                            title="Continue with the next step. This step gets no pull request."
                            onClick={() => void act(() => planRunner.markDone(plan.id, step.id))}
                        >
                            <CircleCheck size={14} /> Mark done
                        </button>
                    )}
                    <button type="button" className="button" onClick={() => void act(() => planRunner.skipStep(plan.id, step.id))}>
                        <SkipForward size={14} /> Skip
                    </button>
                </div>
            )}
        </div>
    );
}
