import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
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
import { Combobox, sortedGroups } from '../components/Combobox';
import { collectionsQueryOptions, connectionsQueryOptions } from '../components/tasks/use-task-source';
import { SettingsGroup, SettingsRow } from '../components/settings-ui';
import { Select } from '../components/Select';
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
                {trigger.type === 'manual' && (
                    <>
                        <SettingsRow
                            label="Button on"
                            description={MANUAL_ENTITIES.find(item => item.entity === trigger.entity)?.description}
                            control={
                                <Select<ManualEntity>
                                    className="settings-input"
                                    value={trigger.entity}
                                    options={MANUAL_ENTITIES.map(item => ({ value: item.entity, label: item.label }))}
                                    onChange={entity => applyTrigger({ ...trigger, entity })}
                                />
                            }
                        />
                        {trigger.entity !== 'none' && (
                            <SettingsRow label="Button text" description="Optional. Without it, the button shows the name of the automation.">
                                <input
                                    className="settings-input"
                                    value={trigger.button ?? ''}
                                    maxLength={40}
                                    placeholder={draft.name}
                                    onChange={event => setTrigger({ button: event.target.value || undefined })}
                                />
                            </SettingsRow>
                        )}
                    </>
                )}
            </SettingsGroup>

            <SettingsGroup
                title="Where"
                description={
                    singleRepo
                        ? 'The repository of the new worktrees and of the agents.'
                        : manual
                          ? 'The repositories of the worktrees that show the button.'
                          : 'The repositories of the worktrees. The automation acts only on worktrees with a branch, not on the main worktree.'
                }
                card
            >
                {singleRepo ? (
                    <SettingsRow
                        label={actsOnTasks(trigger) ? 'Default repository' : 'Repository'}
                        description={
                            actsOnTasks(trigger)
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
                {actsOnTasks(trigger) && (
                    <LabelRepoFields
                        rules={draft.binding.labelRepos ?? []}
                        repos={repoChoices}
                        repoLabel={repo => (repos.includes(repo) ? repoLabel(repo) : `${repo} (not in a project)`)}
                        onChange={rules => change({ binding: { ...draft.binding, labelRepos: rules.length > 0 ? rules : undefined } })}
                    />
                )}
                {actsOnWorktrees(trigger) && (
                    <SettingsRow
                        label="Branches"
                        description='Only branches that match this pattern. "*" matches any text, for example "eng-*". Empty: all branches.'
                    >
                        <input
                            className="settings-input mono"
                            value={draft.conditions?.branchPattern ?? ''}
                            onChange={event => setConditions({ branchPattern: event.target.value || undefined })}
                        />
                    </SettingsRow>
                )}
            </SettingsGroup>

            <SettingsGroup
                title="Only if"
                description={
                    manual
                        ? 'The button shows only when these conditions agree. They use the variables of the trigger. Use an "If" action for the answer of an HTTP request.'
                        : 'The automation runs only when these conditions agree. They use the variables of the trigger. Use an "If" action for the checks or the answer of an HTTP request.'
                }
                card
            >
                <div className="settings-row">
                    <ConditionEditor
                        value={draft.conditions?.when}
                        variables={triggerVariables(trigger)}
                        emptyText="No conditions."
                        onChange={when => setConditions({ when })}
                    />
                </div>
            </SettingsGroup>

            <SettingsGroup title="Then" description="The actions run in this order. A failed action stops the run." card>
                <ActionList
                    actions={draft.actions}
                    trigger={trigger}
                    agents={agents}
                    secrets={secretNames}
                    required
                    onChange={actions => change({ actions })}
                />
            </SettingsGroup>

            {showSecrets && (
                <SecretFields
                    secrets={draft.binding.secrets ?? {}}
                    used={usedSecrets(draft)}
                    onChange={secrets => change({ binding: { ...draft.binding, secrets: Object.keys(secrets).length > 0 ? secrets : undefined } })}
                />
            )}

            {(!manual || hasStartAgent) && (
                <SettingsGroup
                    title="Limits"
                    description={manual ? 'A click is the approval, so a manual automation has no approval and no run limits.' : undefined}
                    card
                >
                    {!manual && (
                        <>
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
                        </>
                    )}
                    {hasStartAgent && (
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
            )}

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
                        <input
                            type="password"
                            className="settings-input mono"
                            aria-label={`The value of ${name}`}
                            placeholder="Value"
                            autoComplete="off"
                            value={secrets[name] ?? ''}
                            onChange={event => set(name, event.target.value)}
                        />
                        <button type="button" className="icon-button" title="Remove the secret" aria-label="Remove the secret" onClick={() => remove(name)}>
                            <Trash2 size={14} strokeWidth={1.7} />
                        </button>
                    </div>
                </SettingsRow>
            ))}
            <SettingsRow label="Add a secret" description="Type the name and the value. Then use {{secret.NAME}} in an HTTP request.">
                <div className="automation-secret-add">
                    <div className="automation-label-repo">
                        <input
                            className="settings-input mono"
                            aria-label="The name of the new secret"
                            placeholder="TOKEN"
                            autoComplete="off"
                            spellCheck={false}
                            value={newName}
                            onChange={event => setNewName(event.target.value.trim())}
                            onKeyDown={event => event.key === 'Enter' && add()}
                        />
                        <input
                            type="password"
                            className="settings-input mono"
                            aria-label="The value of the new secret"
                            placeholder="Value"
                            autoComplete="off"
                            value={newValue}
                            onChange={event => setNewValue(event.target.value)}
                            onKeyDown={event => event.key === 'Enter' && add()}
                        />
                        <button type="button" className="button" disabled={!canAdd} onClick={add}>
                            <Plus size={13} strokeWidth={1.8} />
                            Add
                        </button>
                    </div>
                    {nameProblem && <div className="automation-warning">{nameProblem}</div>}
                </div>
            </SettingsRow>
        </SettingsGroup>
    );
}
