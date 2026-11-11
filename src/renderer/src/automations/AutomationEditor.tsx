import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
    ACTION_TRIGGERS,
    ACTION_TYPES,
    TRIGGER_TYPES,
    TRIGGER_VARIABLES,
    TOKEN_LIMIT_MAX,
    TOKEN_LIMIT_MIN,
    TOKEN_LIMIT_STEP,
    USAGE_LIMIT_MAX,
    USAGE_LIMIT_MIN,
    USAGE_LIMIT_STEP,
    bindingProblems,
    defaultAction,
    defaultTrigger,
    isWorktreeTrigger,
    needsRepo,
    normalizeAutomation,
    unknownVariables,
    type ActionType,
    type Automation,
    type AutomationAction,
    type AutomationStatus,
    type LabelRepo,
    type Trigger,
    type TriggerType
} from '@shared/automations';
import type { AgentDefinition } from '@shared/settings';
import type { TaskCollection } from '@shared/tasks';
import { Combobox, sortedGroups } from '../components/Combobox';
import { collectionsQueryOptions, connectionsQueryOptions } from '../components/tasks/use-task-source';
import { SettingsGroup, SettingsRow } from '../components/settings-ui';
import { Select } from '../components/Select';
import { errorText } from '../util';
import { LimitField } from './LimitField';

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
    const change = (patch: Partial<Automation>) => setDraft(current => ({ ...current, ...patch }));
    const trigger = draft.trigger;
    const problems = bindingProblems(draft, repos);

    const setTriggerType = (type: TriggerType) => {
        // Keep the actions that can follow the new trigger. A trigger without a valid action gets one.
        const actions = draft.actions.filter(action => ACTION_TRIGGERS[action.type].includes(type));
        const fallback = (Object.keys(ACTION_TRIGGERS) as ActionType[]).find(action => ACTION_TRIGGERS[action].includes(type)) ?? 'notify';
        change({ trigger: defaultTrigger(type), actions: actions.length > 0 ? actions : [defaultAction(fallback)] });
    };
    const setTrigger = (patch: Partial<Trigger>) => change({ trigger: { ...trigger, ...patch } as Trigger });
    const setAction = (index: number, action: AutomationAction) => change({ actions: draft.actions.map((item, i) => (i === index ? action : item)) });
    const moveAction = (index: number, step: -1 | 1) => {
        const actions = [...draft.actions];
        const [item] = actions.splice(index, 1);
        actions.splice(index + step, 0, item);
        change({ actions });
    };
    const allowedActions = ACTION_TYPES.filter(item => ACTION_TRIGGERS[item.type].includes(trigger.type));

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

    const singleRepo = trigger.type === 'task.new' || trigger.type === 'schedule';
    const repoChoices = [...new Set([...repos, ...(draft.binding.repos ?? [])])];

    return (
        <div className="settings-page automation-editor">
            <div className="automation-editor-head">
                <h2>{previousId ? 'Change the automation' : imported ? 'Import an automation' : 'New automation'}</h2>
                {imported && (
                    <p className="automation-note">
                        An imported automation starts "Off". Read the trigger, the prompts and the actions. Then save it and turn it on in the list.
                    </p>
                )}
            </div>

            <SettingsGroup title="General" card>
                <SettingsRow label="Name">
                    <input className="settings-input" value={draft.name} maxLength={80} onChange={event => change({ name: event.target.value })} />
                </SettingsRow>
                <SettingsRow label="Description" description="Optional. The list shows it under the name.">
                    <input
                        className="settings-input"
                        value={draft.description ?? ''}
                        maxLength={1000}
                        onChange={event => change({ description: event.target.value || undefined })}
                    />
                </SettingsRow>
                {!imported && (
                    <SettingsRow
                        label="Status"
                        description="Start with a dry run. It records what the automation would do."
                        control={
                            <div className="segmented compact">
                                {STATUS_OPTIONS.map(option => (
                                    <button
                                        key={option.id}
                                        type="button"
                                        title={option.title}
                                        className={draft.status === option.id ? 'selected' : ''}
                                        onClick={() => change({ status: option.id })}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        }
                    />
                )}
            </SettingsGroup>

            <SettingsGroup title="When" card>
                <SettingsRow
                    label="Trigger"
                    description={TRIGGER_TYPES.find(item => item.type === trigger.type)?.description}
                    control={
                        <Select
                            className="settings-input"
                            value={trigger.type}
                            options={TRIGGER_TYPES.map(item => ({ value: item.type, label: item.label }))}
                            onChange={setTriggerType}
                        />
                    }
                />
                {trigger.type === 'pr.comment' && (
                    <>
                        <SettingsRow
                            label="Only reviews"
                            description={'Only reviews, for example "Changes requested". Not single comments.'}
                            control={
                                <input
                                    type="checkbox"
                                    checked={!!trigger.reviewsOnly}
                                    onChange={event => setTrigger({ reviewsOnly: event.target.checked || undefined })}
                                />
                            }
                        />
                        <SettingsRow label="Ignore these authors" description="GitHub logins, separated by commas.">
                            <input
                                className="settings-input"
                                defaultValue={trigger.ignoreAuthors?.join(', ') ?? ''}
                                onBlur={event => setTrigger({ ignoreAuthors: splitNames(event.target.value) })}
                            />
                        </SettingsRow>
                    </>
                )}
                {trigger.type === 'agent.done' && (
                    <SettingsRow
                        label="Only without a pull request"
                        description="Only when the branch of the worktree has no open pull request."
                        control={
                            <input
                                type="checkbox"
                                checked={!!trigger.withoutPullRequest}
                                onChange={event => setTrigger({ withoutPullRequest: event.target.checked || undefined })}
                            />
                        }
                    />
                )}
                {trigger.type === 'task.new' && <TaskSourceFields draft={draft} change={change} />}
                {trigger.type === 'task.new' && (
                    <>
                        <SettingsRow label="Labels" description="Only tasks with one of these labels, separated by commas. Empty: all labels.">
                            <input
                                className="settings-input"
                                defaultValue={trigger.labels?.join(', ') ?? ''}
                                onBlur={event => setTrigger({ labels: splitNames(event.target.value) })}
                            />
                        </SettingsRow>
                        <SettingsRow
                            label="Assigned to me"
                            description="Only tasks that are assigned to you in the task manager."
                            control={
                                <input
                                    type="checkbox"
                                    checked={!!trigger.assignedToMe}
                                    onChange={event => setTrigger({ assignedToMe: event.target.checked || undefined })}
                                />
                            }
                        />
                        <SettingsRow label="Status" description={'Only tasks with this status, for example "To do". Empty: all statuses.'}>
                            <input
                                className="settings-input"
                                value={trigger.status ?? ''}
                                onChange={event => setTrigger({ status: event.target.value || undefined })}
                            />
                        </SettingsRow>
                    </>
                )}
                {trigger.type === 'schedule' && (
                    <SettingsRow
                        label="Days and time"
                        description="Local time. A time that passes while ShipWarden is closed does not run later."
                        control={
                            <div className="automation-schedule">
                                {DAY_NAMES.map((day, index) => (
                                    <label key={day} className="automation-day">
                                        <input
                                            type="checkbox"
                                            checked={trigger.days.includes(index)}
                                            onChange={event =>
                                                setTrigger({
                                                    days: event.target.checked ? [...trigger.days, index].sort() : trigger.days.filter(item => item !== index)
                                                })
                                            }
                                        />
                                        {day}
                                    </label>
                                ))}
                                <input
                                    type="time"
                                    className="settings-input automation-time"
                                    value={trigger.time}
                                    onChange={event => setTrigger({ time: event.target.value })}
                                />
                            </div>
                        }
                    />
                )}
            </SettingsGroup>

            <SettingsGroup
                title="Where"
                description={
                    singleRepo
                        ? 'The repository of the new worktrees and of the agents.'
                        : 'The repositories of the worktrees. The automation acts only on worktrees with a branch, not on the main worktree.'
                }
                card
            >
                {singleRepo ? (
                    <SettingsRow
                        label={trigger.type === 'task.new' ? 'Default repository' : 'Repository'}
                        description={
                            trigger.type === 'task.new'
                                ? 'The repository of a task when no label rule below matches. Empty: a task without a matching label does not run.'
                                : needsRepo(draft)
                                  ? undefined
                                  : 'Optional for these actions.'
                        }
                        control={
                            <Select
                                className="settings-input"
                                value={draft.binding.repos?.[0] ?? ''}
                                options={[
                                    { value: '', label: 'Select a repository' },
                                    ...repoChoices.map(repo => ({ value: repo, label: repos.includes(repo) ? repoLabel(repo) : `${repo} (not in a project)` }))
                                ]}
                                onChange={repo => change({ binding: { ...draft.binding, repos: repo ? [repo] : undefined } })}
                            />
                        }
                    />
                ) : (
                    <SettingsRow label="Repositories" description="No selection: all repositories of all projects.">
                        <div className="automation-repos">
                            {repoChoices.map(repo => (
                                <label key={repo} className="automation-check">
                                    <input
                                        type="checkbox"
                                        checked={draft.binding.repos?.includes(repo) ?? false}
                                        onChange={event => {
                                            const current = draft.binding.repos ?? [];
                                            const next = event.target.checked ? [...current, repo] : current.filter(item => item !== repo);
                                            change({ binding: { ...draft.binding, repos: next.length > 0 ? next : undefined } });
                                        }}
                                    />
                                    {repos.includes(repo) ? repoLabel(repo) : `${repo} (not in a project)`}
                                </label>
                            ))}
                        </div>
                    </SettingsRow>
                )}
                {trigger.type === 'task.new' && (
                    <LabelRepoFields
                        rules={draft.binding.labelRepos ?? []}
                        repos={repoChoices}
                        repoLabel={repo => (repos.includes(repo) ? repoLabel(repo) : `${repo} (not in a project)`)}
                        onChange={rules => change({ binding: { ...draft.binding, labelRepos: rules.length > 0 ? rules : undefined } })}
                    />
                )}
                {isWorktreeTrigger(trigger.type) && (
                    <SettingsRow
                        label="Branches"
                        description='Only branches that match this pattern. "*" matches any text, for example "eng-*". Empty: all branches.'
                    >
                        <input
                            className="settings-input mono"
                            value={draft.conditions?.branchPattern ?? ''}
                            onChange={event => change({ conditions: event.target.value ? { branchPattern: event.target.value } : undefined })}
                        />
                    </SettingsRow>
                )}
            </SettingsGroup>

            <SettingsGroup title="Then" description="The actions run in this order. A failed action stops the run." card>
                {draft.actions.map((action, index) => (
                    <ActionFields
                        // biome-ignore lint/suspicious/noArrayIndexKey: The actions have no IDs. The index is their place in the list.
                        key={index}
                        index={index}
                        count={draft.actions.length}
                        action={action}
                        trigger={trigger.type}
                        allowed={allowedActions.map(item => item.type)}
                        agents={agents}
                        onChange={next => setAction(index, next)}
                        onMove={step => moveAction(index, step)}
                        onRemove={() => change({ actions: draft.actions.filter((_, i) => i !== index) })}
                    />
                ))}
                <SettingsRow
                    label="Add an action"
                    control={
                        <Select<ActionType | ''>
                            className="settings-input"
                            value=""
                            options={[{ value: '', label: 'Select an action' }, ...allowedActions.map(item => ({ value: item.type, label: item.label }))]}
                            onChange={type => {
                                if (type) change({ actions: [...draft.actions, defaultAction(type)] });
                            }}
                        />
                    }
                />
            </SettingsGroup>

            <SettingsGroup title="Limits" card>
                <SettingsRow
                    label="Approval"
                    description='"Ask first": each run waits for you in the Automations view, and a notification tells you.'
                    control={
                        <div className="segmented compact">
                            {(['auto', 'ask'] as const).map(value => (
                                <button
                                    key={value}
                                    type="button"
                                    className={draft.limits.approval === value ? 'selected' : ''}
                                    onClick={() => change({ limits: { ...draft.limits, approval: value } })}
                                >
                                    {value === 'auto' ? 'Run at once' : 'Ask first'}
                                </button>
                            ))}
                        </div>
                    }
                />
                <SettingsRow
                    label="Tokens each day"
                    description="The most tokens of this automation from midnight. Then it starts no runs until the next day. Only Claude Code reports tokens."
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
                <SettingsRow
                    label="Pause at plan usage"
                    description="This automation starts no runs while the plan usage of Claude or Codex is at or above this percent. The limit for all automations also applies."
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
                <SettingsRow
                    label="Runs for each target"
                    description="The most runs for one pull request, worktree or task. This stops a loop, for example fix, fail, fix."
                    control={
                        <input
                            type="number"
                            min={1}
                            max={100}
                            className="settings-input automation-number"
                            value={draft.limits.maxRunsPerTarget}
                            onChange={event => change({ limits: { ...draft.limits, maxRunsPerTarget: Number(event.target.value) } })}
                        />
                    }
                />
                {draft.actions.some(action => action.type === 'startAgent') && (
                    <SettingsRow
                        label="Agents at the same time"
                        description="The most agents of this automation that work at the same time. More runs wait."
                        control={
                            <input
                                type="number"
                                min={1}
                                max={100}
                                className="settings-input automation-number"
                                value={draft.limits.maxRunning}
                                onChange={event => change({ limits: { ...draft.limits, maxRunning: Number(event.target.value) } })}
                            />
                        }
                    />
                )}
            </SettingsGroup>

            {problems.length > 0 && <div className="automation-warning">{problems.join(' ')}</div>}
            {error && <div className="form-error">{error}</div>}
            <div className="automation-editor-actions">
                <button type="button" className="button" onClick={onCancel}>
                    Cancel
                </button>
                <button type="button" className="button primary-solid" disabled={saving} onClick={() => void save()}>
                    {saving ? 'Saving…' : 'Save'}
                </button>
            </div>
        </div>
    );
}

/** The task manager and the collection of a "task.new" trigger. */
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
            <SettingsRow
                label="Task manager"
                control={
                    <Select
                        className="settings-input"
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
                }
            />
            {connectionId && (
                <SettingsRow
                    label="Collections"
                    description="ShipWarden reads the tasks of each collection every 5 minutes. The tasks that match when the automation starts do not run. Only later tasks run."
                    control={
                        <Combobox
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
                    }
                />
            )}
            {collections.error && <div className="form-error">{errorText(collections.error)}</div>}
        </>
    );
}

interface LabelRepoProps {
    rules: LabelRepo[];
    repos: string[];
    repoLabel(repo: string): string;
    onChange(rules: LabelRepo[]): void;
}

/** The rules that select the repository of a task by its label. */
function LabelRepoFields({ rules, repos, repoLabel, onChange }: LabelRepoProps) {
    const setRule = (index: number, patch: Partial<LabelRepo>) => onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    return (
        <SettingsRow
            label="Repository by label"
            description='A task with the label goes to the repository. For example, the label "api" selects the repository of the API. The first rule that matches applies.'
        >
            <div className="automation-label-repos">
                {rules.map((rule, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: The rules have no IDs. The index is their place in the list.
                    <div key={index} className="automation-label-repo">
                        <input
                            className="settings-input"
                            placeholder="Label"
                            aria-label="Label"
                            value={rule.label}
                            onChange={event => setRule(index, { label: event.target.value })}
                        />
                        <Select
                            className="settings-input"
                            aria-label="Repository"
                            value={rule.repo}
                            options={[{ value: '', label: 'Select a repository' }, ...repos.map(repo => ({ value: repo, label: repoLabel(repo) }))]}
                            onChange={repo => setRule(index, { repo })}
                        />
                        <button
                            type="button"
                            className="icon-button"
                            title="Remove the rule"
                            aria-label="Remove the rule"
                            onClick={() => onChange(rules.filter((_, i) => i !== index))}
                        >
                            <Trash2 size={14} strokeWidth={1.7} />
                        </button>
                    </div>
                ))}
                <button type="button" className="button" onClick={() => onChange([...rules, { label: '', repo: '' }])}>
                    <Plus size={13} strokeWidth={1.8} />
                    Add a rule
                </button>
            </div>
        </SettingsRow>
    );
}

interface ActionProps {
    index: number;
    count: number;
    action: AutomationAction;
    trigger: TriggerType;
    allowed: ActionType[];
    agents: AgentDefinition[];
    onChange(action: AutomationAction): void;
    onMove(step: -1 | 1): void;
    onRemove(): void;
}

/** The fields of one action. */
function ActionFields({ index, count, action, trigger, allowed, agents, onChange, onMove, onRemove }: ActionProps) {
    const unknown = 'prompt' in action ? unknownVariables(action.prompt, trigger) : [];
    return (
        <div className="settings-row automation-action">
            <div className="settings-row-main">
                <div className="settings-row-text">
                    <div className="settings-row-label">
                        {index + 1}. {ACTION_TYPES.find(item => item.type === action.type)?.label}
                    </div>
                    <div className="settings-row-description">{ACTION_TYPES.find(item => item.type === action.type)?.description}</div>
                </div>
                <div className="settings-row-control automation-action-tools">
                    <Select
                        className="settings-input"
                        value={action.type}
                        options={allowed.map(type => ({ value: type, label: ACTION_TYPES.find(item => item.type === type)?.label ?? type }))}
                        onChange={type => onChange(defaultAction(type))}
                    />
                    <button type="button" className="icon-button" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
                        <ArrowUp size={14} />
                    </button>
                    <button type="button" className="icon-button" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
                        <ArrowDown size={14} />
                    </button>
                    <button type="button" className="icon-button" title="Remove the action" disabled={count === 1} onClick={onRemove}>
                        <Trash2 size={14} />
                    </button>
                </div>
            </div>
            <div className="settings-row-body automation-action-body">
                {'prompt' in action && (
                    <>
                        <textarea
                            className="settings-input mono automation-prompt"
                            value={action.prompt}
                            spellCheck={false}
                            placeholder="The prompt. Use variables such as {{pr.url}}."
                            onChange={event => onChange({ ...action, prompt: event.target.value })}
                        />
                        <div className="automation-variables">
                            Variables:{' '}
                            {TRIGGER_VARIABLES[trigger].map(variable => (
                                <code key={variable.name} title={variable.description}>{`{{${variable.name}}}`}</code>
                            ))}
                        </div>
                        {unknown.length > 0 && (
                            <div className="automation-warning">
                                This trigger does not give {unknown.map(name => `{{${name}}}`).join(', ')}. These variables become empty text.
                            </div>
                        )}
                    </>
                )}
                {action.type === 'startAgent' && (
                    <div className="automation-inline">
                        <span className="automation-field">
                            Agent{' '}
                            <Select
                                className="settings-input"
                                aria-label="Agent"
                                value={action.agentId ?? ''}
                                options={[
                                    { value: '', label: 'The agent of the repository' },
                                    ...agents.map(agent => ({ value: agent.id, label: agent.name }))
                                ]}
                                onChange={agentId => onChange({ ...action, agentId: agentId || undefined })}
                            />
                        </span>
                        {trigger === 'schedule' && (
                            <label>
                                Branch{' '}
                                <input
                                    className="settings-input mono"
                                    placeholder="automation/{{date}}-{{time}}"
                                    value={action.branch ?? ''}
                                    onChange={event => onChange({ ...action, branch: event.target.value || undefined })}
                                />
                            </label>
                        )}
                    </div>
                )}
                {action.type === 'runHeadless' && (
                    <label className="automation-check">
                        <input
                            type="checkbox"
                            checked={!!action.saveNote}
                            onChange={event => onChange({ ...action, saveNote: event.target.checked || undefined })}
                        />
                        Save the answer as a note in the folder "Automations"
                    </label>
                )}
                {action.type === 'moveTask' && (
                    <label className="automation-inline">
                        Status{' '}
                        <input className="settings-input" value={action.status} onChange={event => onChange({ ...action, status: event.target.value })} />
                    </label>
                )}
                {action.type === 'removeWorktree' && (
                    <label className="automation-check">
                        <input
                            type="checkbox"
                            checked={!!action.deleteBranch}
                            onChange={event => onChange({ ...action, deleteBranch: event.target.checked || undefined })}
                        />
                        Also delete the local branch when it is merged
                    </label>
                )}
                {action.type === 'notify' && (
                    <div className="automation-inline">
                        <label>
                            Title{' '}
                            <input className="settings-input" value={action.title} onChange={event => onChange({ ...action, title: event.target.value })} />
                        </label>
                        <label>
                            Text{' '}
                            <input
                                className="settings-input"
                                value={action.body ?? ''}
                                onChange={event => onChange({ ...action, body: event.target.value || undefined })}
                            />
                        </label>
                    </div>
                )}
            </div>
        </div>
    );
}
