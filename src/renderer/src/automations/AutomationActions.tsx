import { useId, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import type { ChatChannel } from '@shared/tasks';
import { Button, Card, CardBody, Checkbox, Combobox, IconButton, Input, Select, TextArea, sortedGroups } from '../components/ui';
import { errorText } from '../util';
import { chatChannelsQueryOptions, chatConnectionsQueryOptions } from './chat-queries';
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
    const id = useId();
    return (
        <Card className={`automation-action${action.type === 'if' ? ' automation-action-if' : ''}`}>
            <div className="card-header automation-action-head">
                <span className="automation-action-number">{label}</span>
                <Select
                    className="automation-type-select"
                    aria-label="The type of the action"
                    value={action.type}
                    options={allowed.map(type => ({ value: type, label: ACTION_TYPES.find(item => item.type === type)?.label ?? type }))}
                    onChange={type => onChange(defaultAction(type))}
                />
                <span className="automation-action-description">{info?.description}</span>
                {action.type === 'moveTask' && (
                    <>
                        <span className="automation-joiner">to status</span>
                        <Input
                            className="automation-status-input"
                            aria-label="Status"
                            placeholder="in progress"
                            value={action.status}
                            onChange={event => onChange({ ...action, status: event.target.value })}
                        />
                    </>
                )}
                <div className="automation-action-tools">
                    {!first && <IconButton size="sm" label="Move up" icon={<ArrowUp size={14} />} onClick={() => onMove(-1)} />}
                    {!last && <IconButton size="sm" label="Move down" icon={<ArrowDown size={14} />} onClick={() => onMove(1)} />}
                    <IconButton size="sm" tone="danger" label="Remove the action" icon={<Trash2 size={14} />} disabled={!removable} onClick={onRemove} />
                </div>
            </div>
            <CardBody className="automation-action-body">
                {(action.type === 'sendToAgent' || action.type === 'startAgent') && (
                    <div className="automation-field-grid">
                        {action.type === 'startAgent' && (
                            <div className="flow-field">
                                <span className="automation-field-label">Agent</span>
                                <Select
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
                            <div className="flow-field">
                                <label className="automation-field-label" htmlFor={`${id}-branch`}>
                                    Branch
                                </label>
                                <Input
                                    id={`${id}-branch`}
                                    mono
                                    placeholder="automation/{{date}}-{{time}}"
                                    value={action.branch ?? ''}
                                    onChange={event => onChange({ ...action, branch: event.target.value || undefined })}
                                />
                            </div>
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
                    <Checkbox
                        label={'Save the answer as a note in the folder "Automations"'}
                        checked={!!action.saveNote}
                        onChange={checked => onChange({ ...action, saveNote: checked || undefined })}
                    />
                )}
                {action.type === 'removeWorktree' && (
                    <Checkbox
                        label="Also delete the local branch when it is merged"
                        checked={!!action.deleteBranch}
                        onChange={checked => onChange({ ...action, deleteBranch: checked || undefined })}
                    />
                )}
                {action.type === 'notify' && (
                    <>
                        <div className="automation-inline">
                            <span className="automation-field">
                                <label htmlFor={`${id}-title`}>Title</label>
                                <Input id={`${id}-title`} value={action.title} onChange={event => onChange({ ...action, title: event.target.value })} />
                            </span>
                            <span className="automation-field">
                                <label htmlFor={`${id}-text`}>Text</label>
                                <Input
                                    id={`${id}-text`}
                                    value={action.body ?? ''}
                                    onChange={event => onChange({ ...action, body: event.target.value || undefined })}
                                />
                            </span>
                        </div>
                        <TemplateWarnings texts={[action.title, action.body ?? '']} trigger={trigger} />
                    </>
                )}
                {action.type === 'postMessage' && <PostMessageFields action={action} trigger={trigger} onChange={onChange} />}
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
                            <span className="automation-field">
                                <label htmlFor={`${id}-reason`}>Reason</label>
                                <Input
                                    id={`${id}-reason`}
                                    placeholder="Optional. The run history shows it."
                                    value={action.reason ?? ''}
                                    onChange={event => onChange({ ...action, reason: event.target.value || undefined })}
                                />
                            </span>
                        </div>
                        <Checkbox
                            label="Mark the run as failed"
                            checked={!!action.fail}
                            onChange={checked => onChange({ ...action, fail: checked || undefined })}
                        />
                    </>
                )}
            </CardBody>
        </Card>
    );
}

interface PostMessageProps {
    action: Extract<AutomationAction, { type: 'postMessage' }>;
    trigger: Trigger;
    onChange(action: AutomationAction): void;
}

/**
 * The fields of a "Post to a chat channel" action: the task manager, the channel and the message. The task manager
 * select shows only when more than one task manager has chat channels.
 */
function PostMessageFields({ action, trigger, onChange }: PostMessageProps) {
    const messageRef = useRef<HTMLTextAreaElement>(null);
    const connections = useQuery(chatConnectionsQueryOptions());
    const list = connections.data ?? [];
    const connectionId = action.connectionId ?? (list.length === 1 ? list[0].id : undefined);
    const channels = useQuery({ ...chatChannelsQueryOptions(connectionId), enabled: !!connectionId });
    const loaded = channels.data ?? [];
    // A selected channel that the task manager does not show now stays in the list, so the button shows its name.
    const choices: ChatChannel[] =
        action.channel.id && !loaded.some(item => item.id === action.channel.id)
            ? [...loaded, { id: action.channel.id, name: action.channel.name ?? action.channel.id }]
            : loaded;
    const showConnections = list.length > 1 || (!!action.connectionId && !list.some(item => item.id === action.connectionId));
    return (
        <>
            <div className="automation-field-grid">
                {showConnections && (
                    <div className="flow-field">
                        <span className="automation-field-label">Task manager</span>
                        <Select
                            aria-label="Task manager"
                            value={action.connectionId ?? ''}
                            options={[
                                { value: '', label: 'Select a task manager' },
                                ...list.map(connection => ({ value: connection.id, label: connection.name })),
                                ...(action.connectionId && !list.some(item => item.id === action.connectionId)
                                    ? [{ value: action.connectionId, label: `${action.connectionId} (not available)` }]
                                    : [])
                            ]}
                            onChange={id => {
                                const { connectionId: _connection, ...rest } = action;
                                onChange({ ...rest, ...(id ? { connectionId: id } : {}), channel: { id: '' } });
                            }}
                        />
                    </div>
                )}
                <div className="flow-field">
                    <span className="automation-field-label">Channel</span>
                    <Combobox
                        value={action.channel.id || undefined}
                        groups={sortedGroups(
                            choices,
                            channel => channel.path ?? '',
                            channel => ({ value: channel.id, label: `#${channel.name}` })
                        )}
                        placeholder={
                            connections.isPending || channels.isFetching
                                ? 'Loading…'
                                : connectionId
                                  ? 'Select a channel'
                                  : list.length === 0
                                    ? 'No task manager has channels'
                                    : 'Select a task manager first'
                        }
                        searchPlaceholder="Search channels"
                        disabled={!connectionId}
                        onChange={id => {
                            const channel = loaded.find(item => item.id === id);
                            onChange({ ...action, ...(connectionId ? { connectionId } : {}), channel: { id, ...(channel ? { name: channel.name } : {}) } });
                        }}
                    />
                </div>
            </div>
            {channels.error && <div className="form-error">{errorText(channels.error)}</div>}
            {connections.isSuccess && list.length === 0 && (
                <div className="automation-warning">No task manager has chat channels. Add a ClickUp connection in Settings › Task managers.</div>
            )}
            <div className="automation-prompt-box">
                <div className="automation-prompt-head">Message</div>
                <textarea
                    ref={messageRef}
                    className="automation-prompt"
                    aria-label="Message"
                    value={action.message}
                    spellCheck={false}
                    placeholder="The message, in Markdown. Click a variable below to insert it."
                    onChange={event => onChange({ ...action, message: event.target.value })}
                />
                <VariableHint
                    trigger={trigger}
                    onInsert={variable => onChange({ ...action, message: insertAt(messageRef.current, action.message, variable) })}
                />
            </div>
            <TemplateWarnings texts={[action.message]} trigger={trigger} />
        </>
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
    const id = useId();
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
                    aria-label="Method"
                    value={action.method}
                    options={HTTP_METHODS.map(method => ({ value: method, label: method }))}
                    onChange={method => {
                        const { body, ...rest } = action;
                        onChange(method === 'GET' ? { ...rest, method } : { ...rest, method, ...(body !== undefined ? { body } : {}) });
                    }}
                />
                <Input
                    mono
                    className="automation-http-url"
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
                        <Input
                            mono
                            aria-label="Header name"
                            placeholder="Authorization"
                            value={header.name}
                            spellCheck={false}
                            onChange={event => setHeader(index, { name: event.target.value })}
                        />
                        <Input
                            mono
                            aria-label="Header value"
                            placeholder="Bearer {{secret.TOKEN}}"
                            value={header.value}
                            spellCheck={false}
                            onChange={event => setHeader(index, { value: event.target.value })}
                            onFocus={track((element, text) => setHeader(index, { value: insertAt(element, header.value, text) }))}
                        />
                        <IconButton
                            size="sm"
                            tone="danger"
                            label="Remove the header"
                            icon={<Trash2 size={14} strokeWidth={1.7} />}
                            onClick={() => setHeaders(headers.filter((_, i) => i !== index))}
                        />
                    </div>
                ))}
                <Button icon={<Plus size={13} strokeWidth={1.8} />} onClick={() => setHeaders([...headers, { name: '', value: '' }])}>
                    Add a header
                </Button>
            </div>
            {action.method !== 'GET' && (
                <TextArea
                    mono
                    className="automation-http-body"
                    aria-label="Body"
                    value={action.body ?? ''}
                    spellCheck={false}
                    placeholder={'The body. For JSON, use {{name|json}}, for example {"text": {{pr.title|json}}}.'}
                    onChange={event => onChange({ ...action, body: event.target.value || undefined })}
                    onFocus={track((element, text) => onChange({ ...action, body: insertAt(element, action.body ?? '', text) }))}
                />
            )}
            <div className="automation-inline">
                <Checkbox
                    label="Continue when the status is not 200 to 299"
                    checked={!!action.allowFailure}
                    onChange={checked => onChange({ ...action, allowFailure: checked || undefined })}
                />
                <span className="automation-field">
                    <label htmlFor={`${id}-timeout`}>Time limit</label>
                    <Input
                        id={`${id}-timeout`}
                        type="number"
                        min={1}
                        max={HTTP_TIMEOUT_MAX}
                        className="automation-number"
                        value={action.timeoutSeconds ?? HTTP_TIMEOUT_DEFAULT}
                        onChange={event => {
                            const seconds = Number(event.target.value);
                            const { timeoutSeconds: _timeout, ...rest } = action;
                            onChange(seconds && seconds !== HTTP_TIMEOUT_DEFAULT ? { ...rest, timeoutSeconds: seconds } : rest);
                        }}
                    />{' '}
                    seconds
                </span>
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
