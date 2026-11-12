import { useId, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronRight, CircleAlert, Filter, GitFork, Info, Play, Plus, Trash2, Zap } from 'lucide-react';
import {
    ACTION_TYPES,
    MANUAL_ENTITIES,
    SECRET_NAME_PATTERN,
    TRIGGER_TYPES,
    TOKEN_LIMIT_MAX,
    TOKEN_LIMIT_MIN,
    TOKEN_LIMIT_STEP,
    USAGE_LIMIT_MAX,
    USAGE_LIMIT_MIN,
    USAGE_LIMIT_STEP,
    actionAllowed,
    actsOnTasks,
    actsOnWorktrees,
    bindingProblems,
    defaultAction,
    defaultTrigger,
    flattenActions,
    needsRepo,
    normalizeAutomation,
    triggerVariables,
    usedSecrets,
    type Automation,
    type AutomationAction,
    type AutomationStatus,
    type LabelRepo,
    type ManualEntity,
    type Trigger,
    type TriggerType
} from '@shared/automations';
import type { AgentDefinition } from '@shared/settings';
import type { TaskCollection } from '@shared/tasks';
import { Button, ButtonGroup, Card, CardBody, CardHeader, Checkbox, Combobox, IconButton, Input, Select, sortedGroups } from '../components/ui';
import { collectionsQueryOptions, connectionsQueryOptions } from '../components/tasks/use-task-source';
import { SettingsGroup, SettingsRow } from '../components/settings-ui';
import { TRIGGER_EVENTS, automationSummary, labelWarning } from './automation-summary';
import { radioGroupKeys } from '../components/keyboard';
import { errorText } from '../util';
import { LimitField } from './LimitField';
import { ActionList } from './AutomationActions';
import { ConditionEditor } from './ConditionEditor';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const STATUS_OPTIONS: { id: AutomationStatus; label: string; title: string }[] = [
    { id: 'on', label: 'On', title: 'The automation runs.' },
    { id: 'dry-run', label: 'Dry run', title: 'The automation records what it would do, and does nothing.' },
    { id: 'off', label: 'Off', title: 'The automation does not run.' }
];

interface Props {
    initial: Automation;
    /** The ID of the saved file, for a change of a saved automation. */
    previousId?: string;
    /** True for an automation from an import. It saves with the status "off". */
    imported?: boolean;
    /** The repositories of all projects. */
    repos: string[];
    repoLabel(repo: string): string;
    agents: AgentDefinition[];
    onSave(automation: Automation, previousId?: string): Promise<void>;
    onCancel(): void;
}

/** Splits a list of names at commas. */
function splitNames(text: string): string[] | undefined {
    const list = text
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    return list.length > 0 ? list : undefined;
}

/** The form that makes or changes an automation. */
export function AutomationEditor({ initial, previousId, imported, repos, repoLabel, agents, onSave, onCancel }: Props) {
    const [draft, setDraft] = useState<Automation>(initial);
    const [error, setError] = useState<string>();
    const [saving, setSaving] = useState(false);
    const id = useId();
    const change = (patch: Partial<Automation>) => setDraft(current => ({ ...current, ...patch }));
    /** Changes the branch pattern or the condition. An empty field goes away. */
    const setConditions = (patch: Partial<NonNullable<Automation['conditions']>>) =>
        setDraft(current => {
            const next = { ...current.conditions, ...patch };
            const clean = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
            return { ...current, conditions: Object.keys(clean).length > 0 ? clean : undefined };
        });
    const trigger = draft.trigger;
    const problems = bindingProblems(draft, repos);
    const connections = useQuery(connectionsQueryOptions());
    const connectionName = connections.data?.list.find(item => item.id === draft.binding.connectionId)?.name;

    /** Sets a new trigger. Keeps the actions that can follow it. A trigger without a valid action gets one. */
    const applyTrigger = (next: Trigger) => {
        const actions = keepAllowed(draft.actions, next);
        const fallback = ACTION_TYPES.find(item => actionAllowed(item.type, next))?.type ?? 'notify';
        change({ trigger: next, actions: actions.length > 0 ? actions : [defaultAction(fallback)] });
    };
    const setTriggerType = (type: TriggerType) => applyTrigger(defaultTrigger(type));
    const setTrigger = (patch: Partial<Trigger>) => change({ trigger: { ...trigger, ...patch } as Trigger });
    const manual = trigger.type === 'manual';
    const secretNames = Object.keys(draft.binding.secrets ?? {});
    const showSecrets = secretNames.length > 0 || flattenActions(draft.actions).some(action => action.type === 'http');
    const hasStartAgent = flattenActions(draft.actions).some(action => action.type === 'startAgent');

    const save = async () => {
        setError(undefined);
        try {
            const value = normalizeAutomation({ ...draft, status: imported ? 'off' : draft.status });
            if (value.status !== 'off' && problems.length > 0) {
                throw new Error(`${problems.join(' ')} Or set the status to "Off".`);
            }
            setSaving(true);
            await onSave(value, previousId);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSaving(false);
        }
    };

    const singleRepo = !actsOnWorktrees(trigger);
    const repoChoices = [...new Set([...repos, ...(draft.binding.repos ?? [])])];
    const choiceLabel = (repo: string) => (repos.includes(repo) ? repoLabel(repo) : `${repo} (not in a project)`);
    const hasConditions = !!draft.conditions?.when;
    const warning = labelWarning(draft);

    return (
        <div className="flow-page automation-editor">
            <header className="flow-header automation-editor-head">
                <div className="flow-title-row">
                    <div className="automation-editor-names">
                        <input
                            className="flow-title-input"
                            value={draft.name}
                            maxLength={80}
                            aria-label="Name"
                            placeholder="Name of the automation"
                            onChange={event => change({ name: event.target.value })}
                        />
                        <input
                            className="automation-description-input"
                            value={draft.description ?? ''}
                            maxLength={1000}
                            aria-label="Description"
                            placeholder="Add a description. The list shows it under the name."
                            onChange={event => change({ description: event.target.value || undefined })}
                        />
                    </div>
                    {!imported && (
                        <ButtonGroup className="automation-status-switch" role="radiogroup" label="Status" onKeyDown={radioGroupKeys}>
                            {STATUS_OPTIONS.map(option => (
                                <Button
                                    key={option.id}
                                    role="radio"
                                    aria-checked={draft.status === option.id}
                                    title={option.title}
                                    className={`status-${option.id}`}
                                    icon={option.id === 'on' ? <span className="automation-status-dot" /> : undefined}
                                    onClick={() => change({ status: option.id })}
                                >
                                    {option.label}
                                </Button>
                            ))}
                        </ButtonGroup>
                    )}
                    <Button onClick={onCancel}>Cancel</Button>
                    <Button variant="primary" disabled={saving} onClick={() => void save()}>
                        {saving ? 'Saving…' : imported ? 'Import' : 'Save'}
                    </Button>
                </div>
                {imported && (
                    <p className="automation-note">
                        An imported automation starts "Off". Read the trigger, the prompts and the actions. Then save it and turn it on in the list.
                    </p>
                )}
                {error && <div className="form-error">{error}</div>}
            </header>

            <div className="flow-layout">
                <div className="flow-main">
                    <FlowSection icon={<Zap size={15} />} kind="when">
                        <FlowCard>
                            <SectionHead tag="When" text={TRIGGER_EVENTS[trigger.type]} />
                            <div className="automation-trigger-line">
                                <Select
                                    className="automation-type-select"
                                    aria-label="Trigger"
                                    value={trigger.type}
                                    options={TRIGGER_TYPES.map(item => ({ value: item.type, label: item.label }))}
                                    onChange={setTriggerType}
                                />
                                {trigger.type === 'task.new' && <TaskSourceFields draft={draft} change={change} />}
                                {trigger.type === 'manual' && (
                                    <>
                                        <span className="automation-joiner">on</span>
                                        <Select<ManualEntity>
                                            className="automation-auto-select"
                                            aria-label="Button on"
                                            value={trigger.entity}
                                            options={MANUAL_ENTITIES.map(item => ({ value: item.entity, label: item.label }))}
                                            onChange={entity => applyTrigger({ ...trigger, entity })}
                                        />
                                    </>
                                )}
                            </div>
                            {trigger.type === 'task.new' && (
                                <div className="automation-field-grid">
                                    <div className="flow-field">
                                        <label className="automation-field-label" htmlFor={`${id}-field-1`}>
                                            Label is any of
                                        </label>
                                        <Input
                                            id={`${id}-field-1`}
                                            placeholder="Any label"
                                            defaultValue={trigger.labels?.join(', ') ?? ''}
                                            onBlur={event => setTrigger({ labels: splitNames(event.target.value) })}
                                        />
                                    </div>
                                    <div className="flow-field">
                                        <label className="automation-field-label" htmlFor={`${id}-field-2`}>
                                            Status is
                                        </label>
                                        <Input
                                            id={`${id}-field-2`}
                                            placeholder="Any status"
                                            value={trigger.status ?? ''}
                                            onChange={event => setTrigger({ status: event.target.value || undefined })}
                                        />
                                    </div>
                                    <div className="flow-field">
                                        <span className="automation-field-label">Assignee</span>
                                        <Checkbox
                                            className="automation-check-field"
                                            label="Assigned to me"
                                            checked={!!trigger.assignedToMe}
                                            onChange={checked => setTrigger({ assignedToMe: checked || undefined })}
                                        />
                                    </div>
                                </div>
                            )}
                            {trigger.type === 'pr.comment' && (
                                <div className="automation-field-grid">
                                    <div className="flow-field">
                                        <label className="automation-field-label" htmlFor={`${id}-field-3`}>
                                            Ignore these authors
                                        </label>
                                        <Input
                                            id={`${id}-field-3`}
                                            placeholder="GitHub logins, separated by commas"
                                            defaultValue={trigger.ignoreAuthors?.join(', ') ?? ''}
                                            onBlur={event => setTrigger({ ignoreAuthors: splitNames(event.target.value) })}
                                        />
                                    </div>
                                    <div className="flow-field">
                                        <span className="automation-field-label">Kind</span>
                                        <Checkbox
                                            className="automation-check-field"
                                            title={'Only reviews, for example "Changes requested". Not single comments.'}
                                            label="Only reviews"
                                            checked={!!trigger.reviewsOnly}
                                            onChange={checked => setTrigger({ reviewsOnly: checked || undefined })}
                                        />
                                    </div>
                                </div>
                            )}
                            {trigger.type === 'agent.done' && (
                                <Checkbox
                                    label="Only when the branch has no open pull request"
                                    checked={!!trigger.withoutPullRequest}
                                    onChange={checked => setTrigger({ withoutPullRequest: checked || undefined })}
                                />
                            )}
                            {trigger.type === 'schedule' && (
                                <div className="automation-schedule">
                                    {DAY_NAMES.map((day, index) => (
                                        <label key={day} className={`automation-day${trigger.days.includes(index) ? ' on' : ''}`}>
                                            <input
                                                type="checkbox"
                                                checked={trigger.days.includes(index)}
                                                onChange={event =>
                                                    setTrigger({
                                                        days: event.target.checked
                                                            ? [...trigger.days, index].sort()
                                                            : trigger.days.filter(item => item !== index)
                                                    })
                                                }
                                            />
                                            {day}
                                        </label>
                                    ))}
                                    <span className="automation-joiner">at</span>
                                    <Input type="time" aria-label="Time" value={trigger.time} onChange={event => setTrigger({ time: event.target.value })} />
                                </div>
                            )}
                            {trigger.type === 'manual' && trigger.entity !== 'none' && (
                                <div className="flow-field automation-narrow-field">
                                    <label className="automation-field-label" htmlFor={`${id}-field-4`}>
                                        Button text
                                    </label>
                                    <Input
                                        id={`${id}-field-4`}
                                        value={trigger.button ?? ''}
                                        maxLength={40}
                                        placeholder={draft.name}
                                        onChange={event => setTrigger({ button: event.target.value || undefined })}
                                    />
                                </div>
                            )}
                            <div className="automation-info">
                                <Info size={13} />
                                <span>{triggerNote(trigger)}</span>
                            </div>
                        </FlowCard>
                    </FlowSection>

                    <FlowSection icon={<GitFork size={15} />} kind="where">
                        <FlowCard>
                            <SectionHead
                                tag="Where"
                                text={
                                    actsOnTasks(trigger)
                                        ? 'pick the repository by label. The first match wins.'
                                        : singleRepo
                                          ? 'the repository of the new worktrees and of the agents'
                                          : manual
                                            ? 'the repositories of the worktrees that show the button'
                                            : 'the worktrees with a branch. The main worktree never counts.'
                                }
                            />
                            {actsOnTasks(trigger) ? (
                                <LabelRepoFields
                                    rules={draft.binding.labelRepos ?? []}
                                    repos={repoChoices}
                                    repoLabel={choiceLabel}
                                    fallback={draft.binding.repos?.[0] ?? ''}
                                    onFallback={repo => change({ binding: { ...draft.binding, repos: repo ? [repo] : undefined } })}
                                    onChange={rules => change({ binding: { ...draft.binding, labelRepos: rules.length > 0 ? rules : undefined } })}
                                />
                            ) : singleRepo ? (
                                <div className="automation-trigger-line">
                                    <Select
                                        className="automation-wide-select"
                                        aria-label="Repository"
                                        value={draft.binding.repos?.[0] ?? ''}
                                        options={[
                                            { value: '', label: 'Select a repository' },
                                            ...repoChoices.map(repo => ({ value: repo, label: choiceLabel(repo) }))
                                        ]}
                                        onChange={repo => change({ binding: { ...draft.binding, repos: repo ? [repo] : undefined } })}
                                    />
                                    {!needsRepo(draft) && <span className="automation-joiner">Optional for these actions.</span>}
                                </div>
                            ) : (
                                <div className="automation-repos">
                                    {repoChoices.map(repo => {
                                        const checked = draft.binding.repos?.includes(repo) ?? false;
                                        return (
                                            <label key={repo} className={`automation-chip${checked ? ' on' : ''}`}>
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={event => {
                                                        const current = draft.binding.repos ?? [];
                                                        const next = event.target.checked ? [...current, repo] : current.filter(item => item !== repo);
                                                        change({ binding: { ...draft.binding, repos: next.length > 0 ? next : undefined } });
                                                    }}
                                                />
                                                {choiceLabel(repo)}
                                            </label>
                                        );
                                    })}
                                    <span className="automation-joiner">
                                        {draft.binding.repos?.length ? '' : 'None selected: all repositories of all projects.'}
                                    </span>
                                </div>
                            )}
                            {actsOnWorktrees(trigger) && (
                                <div className="flow-field automation-narrow-field">
                                    <label className="automation-field-label" htmlFor={`${id}-field-5`}>
                                        Branches
                                    </label>
                                    <Input
                                        id={`${id}-field-5`}
                                        mono
                                        placeholder="All branches, or a pattern such as eng-*"
                                        value={draft.conditions?.branchPattern ?? ''}
                                        onChange={event => setConditions({ branchPattern: event.target.value || undefined })}
                                    />
                                </div>
                            )}
                        </FlowCard>
                    </FlowSection>

                    <FlowSection icon={<Filter size={14} />} kind="only-if">
                        <FlowCard>
                            <SectionHead
                                tag="Only if"
                                text={
                                    hasConditions
                                        ? manual
                                            ? 'the button shows only when these conditions agree'
                                            : 'the automation runs only when these conditions agree'
                                        : manual
                                          ? 'No conditions. The button always shows.'
                                          : 'No conditions. Each match runs.'
                                }
                            />
                            <ConditionEditor value={draft.conditions?.when} variables={triggerVariables(trigger)} onChange={when => setConditions({ when })} />
                        </FlowCard>
                    </FlowSection>

                    <FlowSection icon={<Play size={13} />} kind="then" last>
                        <div className="automation-then">
                            <SectionHead tag="Then" text="in order. A failed action stops the run." />
                            <ActionList
                                actions={draft.actions}
                                trigger={trigger}
                                agents={agents}
                                secrets={secretNames}
                                required
                                onChange={actions => change({ actions })}
                            />
                        </div>
                    </FlowSection>

                    {showSecrets && (
                        <SecretFields
                            secrets={draft.binding.secrets ?? {}}
                            used={usedSecrets(draft)}
                            onChange={secrets => change({ binding: { ...draft.binding, secrets: Object.keys(secrets).length > 0 ? secrets : undefined } })}
                        />
                    )}
                </div>

                <aside className="flow-side automation-side">
                    <Card as="section">
                        <CardHeader title="In short" />
                        <CardBody className="flow-card-body">
                            <p className="automation-summary">{automationSummary(draft, connectionName)}</p>
                            {draft.status === 'dry-run' && !imported && (
                                <p className="flow-field-note">Dry run: the automation records what it would do, and does nothing.</p>
                            )}
                            {[...problems, ...(warning ? [warning] : [])].map(problem => (
                                <div key={problem} className="automation-side-warning">
                                    <CircleAlert size={14} />
                                    <span>{problem}</span>
                                </div>
                            ))}
                        </CardBody>
                    </Card>

                    {(!manual || hasStartAgent) && (
                        <Card as="section">
                            <CardHeader
                                title="Limits"
                                description={manual ? 'A click is the approval, so a manual automation has no approval and no run limits.' : undefined}
                            />
                            {!manual && (
                                <>
                                    <CardBody className="flow-card-body automation-limit-row">
                                        <div className="flow-field-label">Approval</div>
                                        <ButtonGroup role="radiogroup" label="Approval" onKeyDown={radioGroupKeys}>
                                            {(['auto', 'ask'] as const).map(value => (
                                                <Button
                                                    key={value}
                                                    role="radio"
                                                    aria-checked={draft.limits.approval === value}
                                                    onClick={() => change({ limits: { ...draft.limits, approval: value } })}
                                                >
                                                    {value === 'auto' ? 'Run at once' : 'Ask first'}
                                                </Button>
                                            ))}
                                        </ButtonGroup>
                                        <div className="flow-field-note">
                                            "Ask first": each run waits for you in the Automations view, and a notification tells you.
                                        </div>
                                    </CardBody>
                                    <LimitRow
                                        label="Tokens each day"
                                        note="Claude Code only. No runs start after the limit until midnight."
                                        control={
                                            <LimitField
                                                value={draft.limits.dailyTokens ?? null}
                                                fallback={1_000_000}
                                                min={TOKEN_LIMIT_MIN}
                                                max={TOKEN_LIMIT_MAX}
                                                step={TOKEN_LIMIT_STEP}
                                                unit="tokens"
                                                label="Tokens each day for this automation"
                                                onSave={dailyTokens => change({ limits: { ...draft.limits, dailyTokens: dailyTokens ?? undefined } })}
                                            />
                                        }
                                    />
                                    <LimitRow
                                        label="Pause at plan usage"
                                        note="Claude or Codex, in percent. The limit for all automations also applies."
                                        control={
                                            <LimitField
                                                value={draft.limits.pauseAtUsage ?? null}
                                                fallback={70}
                                                min={USAGE_LIMIT_MIN}
                                                max={USAGE_LIMIT_MAX}
                                                step={USAGE_LIMIT_STEP}
                                                unit="%"
                                                label="Pause this automation at plan usage, in percent"
                                                onSave={pauseAtUsage => change({ limits: { ...draft.limits, pauseAtUsage: pauseAtUsage ?? undefined } })}
                                            />
                                        }
                                    />
                                    <LimitRow
                                        label="Runs for each target"
                                        note="For one pull request, worktree or task. This stops a loop such as fix, fail, fix."
                                        control={
                                            <Input
                                                type="number"
                                                min={1}
                                                max={100}
                                                aria-label="Runs for each target"
                                                className="automation-number"
                                                value={draft.limits.maxRunsPerTarget}
                                                onChange={event => change({ limits: { ...draft.limits, maxRunsPerTarget: Number(event.target.value) } })}
                                            />
                                        }
                                    />
                                </>
                            )}
                            {hasStartAgent && (
                                <LimitRow
                                    label="Agents at the same time"
                                    note="More runs wait."
                                    control={
                                        <Input
                                            type="number"
                                            min={1}
                                            max={100}
                                            aria-label="Agents at the same time"
                                            className="automation-number"
                                            value={draft.limits.maxRunning}
                                            onChange={event => change({ limits: { ...draft.limits, maxRunning: Number(event.target.value) } })}
                                        />
                                    }
                                />
                            )}
                        </Card>
                    )}
                </aside>
            </div>
        </div>
    );
}

/** The note under the controls of a trigger. */
function triggerNote(trigger: Trigger): string {
    switch (trigger.type) {
        case 'task.new':
            return 'ShipWarden reads the tasks every 5 minutes. Tasks that match when you turn this on do not run, and done tasks never count. Empty filters match all tasks.';
        case 'schedule':
            return 'Local time. A time that passes while ShipWarden is closed does not run later.';
        case 'manual':
            return MANUAL_ENTITIES.find(item => item.entity === trigger.entity)?.description ?? '';
        default:
            return TRIGGER_TYPES.find(item => item.type === trigger.type)?.description ?? '';
    }
}

/** A section of the editor, with an icon on the line at the left. */
function FlowSection({ icon, kind, last, children }: { icon: ReactNode; kind: string; last?: boolean; children: ReactNode }) {
    return (
        <section className={`flow-section ${kind}`}>
            <div className="flow-rail">
                <span className="flow-icon">{icon}</span>
                {!last && <span className="flow-line" />}
            </div>
            <div className="flow-body">{children}</div>
        </section>
    );
}

/** A card in a section of the editor. A combobox popover can show outside the card. */
function FlowCard({ children }: { children: ReactNode }) {
    return (
        <Card className="flow-card">
            <CardBody className="flow-card-body">{children}</CardBody>
        </Card>
    );
}

function SectionHead({ tag, text }: { tag: string; text: string }) {
    return (
        <div className="flow-section-head">
            <span className="flow-tag">{tag}</span>
            <span className="flow-section-text">{text}</span>
        </div>
    );
}

function LimitRow({ label, note, control }: { label: string; note: string; control: ReactNode }) {
    return (
        <CardBody className="flow-card-body automation-limit-row">
            <div className="automation-limit-text">
                <div className="flow-field-label">{label}</div>
                <div className="flow-field-note">{note}</div>
            </div>
            {control}
        </CardBody>
    );
}

/** The task manager and the collections of a "task.new" trigger, in the line of the trigger. */
function TaskSourceFields({ draft, change }: { draft: Automation; change(patch: Partial<Automation>): void }) {
    const connections = useQuery(connectionsQueryOptions());
    const connectionId = draft.binding.connectionId;
    const collections = useQuery({ ...collectionsQueryOptions(connectionId), enabled: !!connectionId, staleTime: 5 * 60_000 });
    const selected = draft.binding.collections ?? [];
    const list = collections.data?.list ?? [];
    // A selected collection that the task manager does not show now stays in the list, so you can remove it.
    const choices: TaskCollection[] = [
        ...list,
        ...selected.filter(item => !list.some(other => other.id === item.id)).map(item => ({ id: item.id, name: item.name ?? item.id }))
    ];
    return (
        <>
            <span className="automation-joiner">in</span>
            <Select
                className="automation-auto-select"
                aria-label="Task manager"
                value={connectionId ?? ''}
                options={[
                    { value: '', label: connections.isPending ? 'Loading…' : 'Select a task manager' },
                    ...(connections.data?.list ?? []).map(connection => ({ value: connection.id, label: connection.name }))
                ]}
                onChange={id =>
                    change({
                        binding: { ...draft.binding, connectionId: id || undefined, collections: undefined }
                    })
                }
            />
            {connectionId && (
                <>
                    <ChevronRight size={14} className="automation-joiner" aria-hidden="true" />
                    <Combobox
                        className="automation-collections"
                        value={undefined}
                        values={selected.map(item => item.id)}
                        groups={sortedGroups(
                            choices,
                            collection => collection.path ?? '',
                            collection => ({ value: collection.id, label: collection.name })
                        )}
                        placeholder={collections.isPending ? 'Loading…' : 'Select collections'}
                        searchPlaceholder="Search collections"
                        onChange={id => {
                            const next = selected.some(item => item.id === id)
                                ? selected.filter(item => item.id !== id)
                                : [...selected, { id, name: list.find(item => item.id === id)?.name }];
                            change({ binding: { ...draft.binding, collections: next.length > 0 ? next : undefined } });
                        }}
                    />
                </>
            )}
            {collections.error && <div className="form-error">{errorText(collections.error)}</div>}
        </>
    );
}

interface LabelRepoProps {
    rules: LabelRepo[];
    repos: string[];
    repoLabel(repo: string): string;
    /** The repository of a task when no rule matches. Empty: the task does not run. */
    fallback: string;
    onFallback(repo: string): void;
    onChange(rules: LabelRepo[]): void;
}

/** The rules that select the repository of a task by its label, and the repository for any other label. */
function LabelRepoFields({ rules, repos, repoLabel, fallback, onFallback, onChange }: LabelRepoProps) {
    const setRule = (index: number, patch: Partial<LabelRepo>) => onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    const repoOptions = repos.map(repo => ({ value: repo, label: repoLabel(repo) }));
    return (
        <div className="automation-label-repos">
            {rules.length > 0 && (
                <div className="automation-label-repo automation-label-repo-head">
                    <span>If the label is</span>
                    <span />
                    <span>use repository</span>
                </div>
            )}
            {rules.map((rule, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: The rules have no IDs. The index is their place in the list.
                <div key={index} className="automation-label-repo">
                    <Input placeholder="Label" aria-label="Label" value={rule.label} onChange={event => setRule(index, { label: event.target.value })} />
                    <ArrowRight size={14} className="automation-joiner" aria-hidden="true" />
                    <Select
                        aria-label="Repository"
                        value={rule.repo}
                        options={[{ value: '', label: 'Select a repository' }, ...repoOptions]}
                        onChange={repo => setRule(index, { repo })}
                    />
                    <IconButton
                        size="sm"
                        tone="danger"
                        label="Remove the rule"
                        icon={<Trash2 size={14} strokeWidth={1.7} />}
                        onClick={() => onChange(rules.filter((_, i) => i !== index))}
                    />
                </div>
            ))}
            <div className={`automation-label-repo automation-label-fallback${rules.length > 0 ? ' divided' : ''}`}>
                <span className="automation-any-label">{rules.length > 0 ? 'Any other label' : 'Any task'}</span>
                <ArrowRight size={14} className="automation-joiner" aria-hidden="true" />
                <Select
                    aria-label={rules.length > 0 ? 'Repository for any other label' : 'Repository'}
                    value={fallback}
                    options={[{ value: '', label: "Don't run" }, ...repoOptions]}
                    onChange={onFallback}
                />
                <span />
            </div>
            <div>
                <Button icon={<Plus size={13} strokeWidth={1.8} />} onClick={() => onChange([...rules, { label: '', repo: '' }])}>
                    Add a rule
                </Button>
            </div>
        </div>
    );
}

/** Returns the actions that can follow the trigger, also in the lists of "If" actions. */
function keepAllowed(actions: AutomationAction[], trigger: Trigger): AutomationAction[] {
    return actions
        .filter(action => actionAllowed(action.type, trigger))
        .map(action =>
            action.type === 'if'
                ? // biome-ignore lint/suspicious/noThenProperty: "then" is a list of actions, not a function, so the object is not a promise.
                  { ...action, then: keepAllowed(action.then, trigger), ...(action.else ? { else: keepAllowed(action.else, trigger) } : {}) }
                : action
        );
}

interface SecretProps {
    secrets: Record<string, string>;
    /** The names that the HTTP requests use. */
    used: string[];
    onChange(secrets: Record<string, string>): void;
}

/**
 * The secrets of the HTTP requests. They stay on this Mac, in the automation file. An export does not contain them.
 * The names that the requests use and that have no value show first.
 */
function SecretFields({ secrets, used, onChange }: SecretProps) {
    const [newName, setNewName] = useState('');
    const [newValue, setNewValue] = useState('');
    const names = [...new Set([...Object.keys(secrets), ...used])];
    const taken = names.includes(newName);
    const canAdd = SECRET_NAME_PATTERN.test(newName) && !taken && newValue !== '';
    const set = (name: string, value: string) => onChange({ ...secrets, [name]: value });
    const add = () => {
        if (!canAdd) return;
        set(newName, newValue);
        setNewName('');
        setNewValue('');
    };
    const nameProblem =
        newName === ''
            ? undefined
            : taken
              ? `The automation has a secret ${newName} already. Change its value above.`
              : SECRET_NAME_PATTERN.test(newName)
                ? undefined
                : 'The name must start with a letter or _, then have letters, digits and _ only.';
    const remove = (name: string) => onChange(Object.fromEntries(Object.entries(secrets).filter(([key]) => key !== name)));
    return (
        <SettingsGroup
            title="Secrets"
            description="Values for the HTTP requests, for example a token. Use {{secret.NAME}} in the address, a header or the body. They stay on this Mac in the automation file. An export does not contain them, and the run history shows •••."
            card
        >
            {names.map(name => (
                <SettingsRow key={name} label={name} description={used.includes(name) ? undefined : 'No HTTP request uses this secret.'}>
                    <div className="automation-label-repo">
                        <Input
                            type="password"
                            mono
                            aria-label={`The value of ${name}`}
                            placeholder="Value"
                            autoComplete="off"
                            value={secrets[name] ?? ''}
                            onChange={event => set(name, event.target.value)}
                        />
                        <IconButton
                            size="sm"
                            tone="danger"
                            label="Remove the secret"
                            icon={<Trash2 size={14} strokeWidth={1.7} />}
                            onClick={() => remove(name)}
                        />
                    </div>
                </SettingsRow>
            ))}
            <SettingsRow label="Add a secret" description="Type the name and the value. Then use {{secret.NAME}} in an HTTP request.">
                <div className="automation-secret-add">
                    <div className="automation-label-repo">
                        <Input
                            mono
                            aria-label="The name of the new secret"
                            placeholder="TOKEN"
                            autoComplete="off"
                            spellCheck={false}
                            value={newName}
                            onChange={event => setNewName(event.target.value.trim())}
                            onKeyDown={event => event.key === 'Enter' && add()}
                        />
                        <Input
                            type="password"
                            mono
                            aria-label="The value of the new secret"
                            placeholder="Value"
                            autoComplete="off"
                            value={newValue}
                            onChange={event => setNewValue(event.target.value)}
                            onKeyDown={event => event.key === 'Enter' && add()}
                        />
                        <Button icon={<Plus size={13} strokeWidth={1.8} />} disabled={!canAdd} onClick={add}>
                            Add
                        </Button>
                    </div>
                    {nameProblem && <div className="automation-warning">{nameProblem}</div>}
                </div>
            </SettingsRow>
        </SettingsGroup>
    );
}
