import { useRef } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
    ACTION_TYPES,
    HTTP_METHODS,
    HTTP_TIMEOUT_DEFAULT,
    HTTP_TIMEOUT_MAX,
    HTTP_VARIABLES,
    actionAllowed,
    defaultAction,
    triggerVariables,
    unknownVariables,
    type ActionType,
    type AutomationAction,
    type HttpHeader,
    type HttpMethod,
    type Trigger,
    type VariableInfo
} from '@shared/automations';
import { unknownFilters } from '@shared/automation-templates';
import { AGENT_MODES, type AgentMode } from '@shared/agent-modes';
import type { AgentDefinition } from '@shared/settings';
import { Select } from '../components/Select';
import { ConditionEditor } from './ConditionEditor';

interface ListProps {
    actions: AutomationAction[];
    trigger: Trigger;
    agents: AgentDefinition[];
    /** The names of the secrets of the automation. */
    secrets: string[];
    onChange(actions: AutomationAction[]): void;
    /** True for the top list. It must keep one action. A nested list can be empty. */
    required?: boolean;
    /** The text before the number of each action, for a nested list. */
    prefix?: string;
}

/** A list of actions: the top list of the automation, or the "then" or "else" list of an "If" action. */
export function ActionList({ actions, trigger, agents, secrets, onChange, required, prefix = '' }: ListProps) {
    const allowed = ACTION_TYPES.filter(item => actionAllowed(item.type, trigger));
    const setAction = (index: number, action: AutomationAction) => onChange(actions.map((item, i) => (i === index ? action : item)));
    const moveAction = (index: number, step: -1 | 1) => {
        const next = [...actions];
        const [item] = next.splice(index, 1);
        next.splice(index + step, 0, item);
        onChange(next);
    };
    return (
        <>
            {actions.map((action, index) => (
                <ActionFields
                    // biome-ignore lint/suspicious/noArrayIndexKey: The actions have no IDs. The index is their place in the list.
                    key={index}
                    label={`${prefix}${index + 1}`}
                    first={index === 0}
                    last={index === actions.length - 1}
                    removable={!required || actions.length > 1}
                    action={action}
                    trigger={trigger}
                    allowed={allowed.map(item => item.type)}
                    agents={agents}
                    secrets={secrets}
                    onChange={next => setAction(index, next)}
                    onMove={step => moveAction(index, step)}
                    onRemove={() => onChange(actions.filter((_, i) => i !== index))}
                />
            ))}
            <Select<ActionType | ''>
                className="automation-add-action"
                aria-label="Add an action"
                value=""
                options={allowed.map(item => ({ value: item.type, label: item.label }))}
                onChange={type => {
                    if (type) onChange([...actions, defaultAction(type)]);
                }}
            >
                <Plus size={14} /> {prefix ? 'Add an action here' : 'Add an action'}
            </Select>
        </>
    );
}

interface ActionProps {
    label: string;
    first: boolean;
    last: boolean;
    removable: boolean;
    action: AutomationAction;
    trigger: Trigger;
    allowed: ActionType[];
    agents: AgentDefinition[];
    secrets: string[];
    onChange(action: AutomationAction): void;
    onMove(step: -1 | 1): void;
    onRemove(): void;
}

/** Shows the variables of a text that the trigger does not give, and the filters that are not known. */
function TemplateWarnings({ texts, trigger, secrets }: { texts: string[]; trigger: Trigger; secrets?: string[] }) {
    const unknown = [...new Set(texts.flatMap(text => unknownVariables(text, trigger, secrets ? { secrets } : {})))];
    const missingSecrets = secrets
        ? [...new Set(texts.flatMap(text => [...text.matchAll(/\{\{\s*secret\.([\w-]+)/g)].map(match => match[1])))].filter(name => !secrets.includes(name))
        : [];
    const filters = [...new Set(texts.flatMap(unknownFilters))];
    return (
        <>
            {unknown.length > 0 && (
                <div className="automation-warning">
                    This trigger does not give {unknown.map(name => `{{${name}}}`).join(', ')}. These variables become empty text.
                </div>
            )}
            {missingSecrets.length > 0 && (
                <div className="automation-warning">The automation has no secret {missingSecrets.join(', ')}. Add it under "Secrets".</div>
            )}
            {filters.length > 0 && <div className="automation-warning">The filter {filters.join(', ')} is not known. Use "json" or "url".</div>}
        </>
    );
}

/** The group of a variable, by the part before the first dot. */
function variableGroup(name: string): string {
    const head = name.split('.')[0];
    return ['task', 'pr', 'comment', 'agent', 'http', 'secret'].includes(head) ? head : 'run';
}

const GROUP_LABELS: Record<string, string> = {
    task: 'Task',
    pr: 'Pull request',
    comment: 'Comment',
    agent: 'Agent',
    run: 'Run',
    http: 'HTTP',
    secret: 'Secret'
};

/**
 * The variables of the trigger as buttons, in groups. A click puts the variable into the last text field that had the
 * focus, at the cursor.
 */
function VariableHint({ trigger, secrets, onInsert }: { trigger: Trigger; secrets?: string[]; onInsert?(variable: string): void }) {
    const all: VariableInfo[] = [
        ...triggerVariables(trigger),
        ...HTTP_VARIABLES,
        ...(secrets ?? []).map(name => ({ name: `secret.${name}`, description: 'A secret of this automation. Only HTTP requests can use it.' }))
    ];
    const groups = [...new Set(all.map(variable => variableGroup(variable.name)))];
    return (
        <div className="automation-variable-box">
            {groups.map(group => (
                <div key={group} className="automation-variable-group">
                    <span className="automation-variable-label">{GROUP_LABELS[group]}</span>
                    <span className="automation-variable-chips">
                        {all
                            .filter(variable => variableGroup(variable.name) === group)
                            .map(variable => (
                                <button
                                    key={variable.name}
                                    type="button"
                                    className="automation-variable"
                                    title={`${variable.description}. Click to insert {{${variable.name}}}.`}
                                    disabled={!onInsert}
                                    onMouseDown={event => event.preventDefault()}
                                    onClick={() => onInsert?.(`{{${variable.name}}}`)}
                                >
                                    {group === 'run' ? variable.name : variable.name.slice(group.length + 1)}
                                </button>
                            ))}
                    </span>
                </div>
            ))}
            <div className="automation-variable-filters">
                Filters: <code title="A JSON string with quotes, for a JSON body">|json</code> <code title="The value encoded for a web address">|url</code>
            </div>
        </div>
    );
}

/** Puts `text` into the field at its cursor, and returns the new value. The cursor goes after the text. */
function insertAt(field: HTMLTextAreaElement | HTMLInputElement | null, value: string, text: string): string {
    if (!field) return value + text;
    const start = field.selectionStart ?? value.length;
    const end = field.selectionEnd ?? value.length;
    requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(start + text.length, start + text.length);
    });
    return value.slice(0, start) + text + value.slice(end);
}

/** The fields of one action. */
function ActionFields({ label, first, last, removable, action, trigger, allowed, agents, secrets, onChange, onMove, onRemove }: ActionProps) {
    const info = ACTION_TYPES.find(item => item.type === action.type);
    const promptRef = useRef<HTMLTextAreaElement>(null);
    return (
        <div className={`automation-action${action.type === 'if' ? ' automation-action-if' : ''}`}>
            <div className="automation-action-head">
                <span className="automation-action-number">{label}</span>
                <Select
                    className="settings-input automation-strong-select"
                    aria-label="The type of the action"
                    value={action.type}
                    options={allowed.map(type => ({ value: type, label: ACTION_TYPES.find(item => item.type === type)?.label ?? type }))}
                    onChange={type => onChange(defaultAction(type))}
                />
                <span className="automation-action-description">{info?.description}</span>
                {action.type === 'moveTask' && (
                    <>
                        <span className="automation-joiner">to status</span>
                        <input
                            className="settings-input automation-status-input"
                            aria-label="Status"
                            placeholder="in progress"
                            value={action.status}
                            onChange={event => onChange({ ...action, status: event.target.value })}
                        />
                    </>
                )}
                <div className="automation-action-tools">
                    {!first && (
                        <button type="button" className="icon-button" title="Move up" onClick={() => onMove(-1)}>
                            <ArrowUp size={15} />
                        </button>
                    )}
                    {!last && (
                        <button type="button" className="icon-button" title="Move down" onClick={() => onMove(1)}>
                            <ArrowDown size={15} />
                        </button>
                    )}
                    <button type="button" className="icon-button" title="Remove the action" disabled={!removable} onClick={onRemove}>
                        <Trash2 size={15} />
                    </button>
                </div>
            </div>
            <div className="automation-action-body">
                {(action.type === 'sendToAgent' || action.type === 'startAgent') && (
                    <div className="automation-field-grid">
                        {action.type === 'startAgent' && (
                            <div className="flow-field">
                                <span className="automation-field-label">Agent</span>
                                <Select
                                    className="settings-input"
                                    aria-label="Agent"
                                    value={action.agentId ?? ''}
                                    options={[{ value: '', label: "The repository's agent" }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))]}
                                    onChange={agentId => onChange({ ...action, agentId: agentId || undefined })}
                                />
                            </div>
                        )}
                        <div className="flow-field" title={AGENT_MODES.find(item => item.mode === action.mode)?.description}>
                            <span className="automation-field-label">Mode</span>
                            <Select<AgentMode | ''>
                                className="settings-input"
                                aria-label="Mode"
                                value={action.mode ?? ''}
                                options={[{ value: '', label: 'Default agent setting' }, ...AGENT_MODES.map(item => ({ value: item.mode, label: item.label }))]}
                                onChange={mode => {
                                    const { mode: _mode, ...rest } = action;
                                    onChange(mode ? { ...rest, mode } : rest);
                                }}
                            />
                        </div>
                        {action.type === 'startAgent' && trigger.type !== 'task.new' && !(trigger.type === 'manual' && trigger.entity === 'task') && (
                            <label className="flow-field">
                                <span className="automation-field-label">Branch</span>
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
                {'prompt' in action && (
                    <>
                        <div className="automation-prompt-box">
                            <div className="automation-prompt-head">Prompt</div>
                            <textarea
                                ref={promptRef}
                                className="automation-prompt"
                                aria-label="Prompt"
                                value={action.prompt}
                                spellCheck={false}
                                placeholder="The prompt. Click a variable below to insert it."
                                onChange={event => onChange({ ...action, prompt: event.target.value })}
                            />
                            <VariableHint
                                trigger={trigger}
                                onInsert={variable => onChange({ ...action, prompt: insertAt(promptRef.current, action.prompt, variable) })}
                            />
                        </div>
                        <TemplateWarnings texts={[action.prompt]} trigger={trigger} />
                    </>
                )}
                {action.type === 'sendToAgent' && action.mode && (
                    <div className="automation-variables">
                        A new agent starts in this mode. A running Claude Code agent changes to it before the prompt. Other running agents cannot change their
                        mode, so the run fails.
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
                    <>
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
                        <TemplateWarnings texts={[action.title, action.body ?? '']} trigger={trigger} />
                    </>
                )}
                {action.type === 'http' && <HttpFields action={action} trigger={trigger} secrets={secrets} onChange={onChange} />}
                {action.type === 'if' && (
                    <>
                        <ConditionEditor
                            value={action.condition}
                            variables={triggerVariables(trigger)}
                            emptyText="No condition: the 'then' actions always run."
                            onChange={condition => onChange({ ...action, condition: condition ?? { all: [] } })}
                        />
                        <div className="automation-branch">
                            <div className="automation-branch-title">Then</div>
                            <ActionList
                                actions={action.then}
                                trigger={trigger}
                                agents={agents}
                                secrets={secrets}
                                prefix={`${label}.`}
                                onChange={then => onChange({ ...action, then })}
                            />
                        </div>
                        <div className="automation-branch">
                            <div className="automation-branch-title">Else</div>
                            <ActionList
                                actions={action.else ?? []}
                                trigger={trigger}
                                agents={agents}
                                secrets={secrets}
                                prefix={`${label}.else.`}
                                onChange={otherwise => {
                                    const { else: _else, ...rest } = action;
                                    onChange(otherwise.length > 0 ? { ...rest, else: otherwise } : rest);
                                }}
                            />
                        </div>
                    </>
                )}
                {action.type === 'stop' && (
                    <>
                        <div className="automation-inline">
                            <label>
                                Reason{' '}
                                <input
                                    className="settings-input"
                                    placeholder="Optional. The run history shows it."
                                    value={action.reason ?? ''}
                                    onChange={event => onChange({ ...action, reason: event.target.value || undefined })}
                                />
                            </label>
                        </div>
                        <label className="automation-check">
                            <input
                                type="checkbox"
                                checked={!!action.fail}
                                onChange={event => onChange({ ...action, fail: event.target.checked || undefined })}
                            />
                            Mark the run as failed
                        </label>
                    </>
                )}
            </div>
        </div>
    );
}

interface HttpProps {
    action: Extract<AutomationAction, { type: 'http' }>;
    trigger: Trigger;
    secrets: string[];
    onChange(action: AutomationAction): void;
}

/** The fields of an "HTTP request" action. */
function HttpFields({ action, trigger, secrets, onChange }: HttpProps) {
    const headers = action.headers ?? [];
    const setHeaders = (next: HttpHeader[]) => {
        const { headers: _headers, ...rest } = action;
        onChange(next.length > 0 ? { ...rest, headers: next } : rest);
    };
    const setHeader = (index: number, patch: Partial<HttpHeader>) => setHeaders(headers.map((header, i) => (i === index ? { ...header, ...patch } : header)));
    const texts = [action.url, action.body ?? '', ...headers.map(header => header.value)];
    /** The text field that had the focus last. A variable button inserts into it. */
    const lastField = useRef<{ element: HTMLInputElement | HTMLTextAreaElement; insert(text: string): void }>(undefined);
    const track =
        (insert: (element: HTMLInputElement | HTMLTextAreaElement, text: string) => void) =>
        (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
            const element = event.currentTarget;
            lastField.current = { element, insert: text => insert(element, text) };
        };
    return (
        <>
            <div className="automation-http-line">
                <Select<HttpMethod>
                    className="settings-input"
                    aria-label="Method"
                    value={action.method}
                    options={HTTP_METHODS.map(method => ({ value: method, label: method }))}
                    onChange={method => {
                        const { body, ...rest } = action;
                        onChange(method === 'GET' ? { ...rest, method } : { ...rest, method, ...(body !== undefined ? { body } : {}) });
                    }}
                />
                <input
                    className="settings-input mono automation-http-url"
                    aria-label="Web address"
                    placeholder="https://example.com/hooks/{{branch|url}}"
                    value={action.url}
                    spellCheck={false}
                    onChange={event => onChange({ ...action, url: event.target.value })}
                    onFocus={track((element, text) => onChange({ ...action, url: insertAt(element, action.url, text) }))}
                />
            </div>
            <div className="automation-http-headers">
                {headers.map((header, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: The headers have no IDs. The index is their place in the list.
                    <div key={index} className="automation-http-header">
                        <input
                            className="settings-input mono"
                            aria-label="Header name"
                            placeholder="Authorization"
                            value={header.name}
                            spellCheck={false}
                            onChange={event => setHeader(index, { name: event.target.value })}
                        />
                        <input
                            className="settings-input mono"
                            aria-label="Header value"
                            placeholder="Bearer {{secret.TOKEN}}"
                            value={header.value}
                            spellCheck={false}
                            onChange={event => setHeader(index, { value: event.target.value })}
                            onFocus={track((element, text) => setHeader(index, { value: insertAt(element, header.value, text) }))}
                        />
                        <button
                            type="button"
                            className="icon-button"
                            title="Remove the header"
                            aria-label="Remove the header"
                            onClick={() => setHeaders(headers.filter((_, i) => i !== index))}
                        >
                            <Trash2 size={14} strokeWidth={1.7} />
                        </button>
                    </div>
                ))}
                <button type="button" className="button" onClick={() => setHeaders([...headers, { name: '', value: '' }])}>
                    <Plus size={13} strokeWidth={1.8} />
                    Add a header
                </button>
            </div>
            {action.method !== 'GET' && (
                <textarea
                    className="settings-input mono automation-prompt"
                    aria-label="Body"
                    value={action.body ?? ''}
                    spellCheck={false}
                    placeholder={'The body. For JSON, use {{name|json}}, for example {"text": {{pr.title|json}}}.'}
                    onChange={event => onChange({ ...action, body: event.target.value || undefined })}
                    onFocus={track((element, text) => onChange({ ...action, body: insertAt(element, action.body ?? '', text) }))}
                />
            )}
            <div className="automation-inline">
                <label className="automation-check">
                    <input
                        type="checkbox"
                        checked={!!action.allowFailure}
                        onChange={event => onChange({ ...action, allowFailure: event.target.checked || undefined })}
                    />
                    Continue when the status is not 200 to 299
                </label>
                <label>
                    Time limit{' '}
                    <input
                        type="number"
                        min={1}
                        max={HTTP_TIMEOUT_MAX}
                        className="settings-input automation-number"
                        value={action.timeoutSeconds ?? HTTP_TIMEOUT_DEFAULT}
                        onChange={event => {
                            const seconds = Number(event.target.value);
                            const { timeoutSeconds: _timeout, ...rest } = action;
                            onChange(seconds && seconds !== HTTP_TIMEOUT_DEFAULT ? { ...rest, timeoutSeconds: seconds } : rest);
                        }}
                    />{' '}
                    seconds
                </label>
            </div>
            <VariableHint
                trigger={trigger}
                secrets={secrets}
                onInsert={variable => (lastField.current ? lastField.current.insert(variable) : onChange({ ...action, url: action.url + variable }))}
            />
            <TemplateWarnings texts={texts} trigger={trigger} secrets={secrets} />
        </>
    );
}
