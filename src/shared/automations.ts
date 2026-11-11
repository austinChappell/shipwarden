import type { Task } from './tasks';
import { PROVIDER_NAMES, type ProviderUsage } from './usage';
import { AGENT_MODES, isAgentMode, type AgentMode } from './agent-modes';
import {
    ConditionError,
    MAX_NESTING,
    conditionHolds,
    conditionTexts,
    globRegex,
    normalizeCondition,
    templateVariables,
    type Condition
} from './automation-templates';

export { renderTemplate } from './automation-templates';

/**
 * Automations: rules of the form "when this event occurs, do these actions".
 *
 * Each automation is one JSON file in ~/.shipwarden/automations. A file has two parts:
 * - The definition is portable: the trigger, the conditions, the actions and the limits. An export contains only this part.
 * - The binding and the status are local to this Mac: the repositories, the task connection and the collection.
 *   An import asks for them, and an imported automation always starts "off".
 *
 * The functions of this module use no Electron API and no browser API. The main process and the page both use them.
 */

/** The version of the file format. A file with a larger version is from a newer ShipWarden. */
export const AUTOMATION_FORMAT_VERSION = 1;

/** The value of the "kind" field. It marks a JSON text as a ShipWarden automation. */
export const AUTOMATION_KIND = 'shipwarden.automation';

export type TriggerType = 'ci.failed' | 'pr.comment' | 'pr.conflict' | 'pr.merged' | 'agent.done' | 'task.new' | 'schedule' | 'manual';

/**
 * The thing that a manual automation acts on. Its button shows in the view of that thing:
 * - worktree: the header of the worktree.
 * - pullRequest: the pull request panel of a worktree.
 * - task: the details of a task.
 * - none: only the play button in the Automations view.
 */
export type ManualEntity = 'worktree' | 'pullRequest' | 'task' | 'none';

export const MANUAL_ENTITIES: { entity: ManualEntity; label: string; description: string }[] = [
    { entity: 'worktree', label: 'Worktree', description: 'A button in the header of each worktree.' },
    { entity: 'pullRequest', label: 'Pull request', description: 'A button in the pull request panel of each worktree.' },
    { entity: 'task', label: 'Task', description: 'A button in the details of each task.' },
    { entity: 'none', label: 'Nothing', description: 'Only the play button in the Automations view.' }
];

export type Trigger =
    /** The user clicks the button of the automation in the view of the entity, or the play button. */
    | { type: 'manual'; entity: ManualEntity; button?: string }
    /** The checks of the pull request of a worktree branch went from waiting to a failure. */
    | { type: 'ci.failed' }
    /** Another person commented on, or reviewed, the pull request of a worktree branch. */
    | { type: 'pr.comment'; reviewsOnly?: boolean; ignoreAuthors?: string[] }
    /** The pull request of a worktree branch has merge conflicts. */
    | { type: 'pr.conflict' }
    /** The pull request of a worktree branch was merged. */
    | { type: 'pr.merged' }
    /** An agent ended its turn. With `withoutPullRequest`, only when the branch has no open pull request. */
    | { type: 'agent.done'; withoutPullRequest?: boolean }
    /** A task of the bound collection agrees with the filters for the first time. */
    | { type: 'task.new'; labels?: string[]; assignedToMe?: boolean; status?: string }
    /** A time of day on the selected days of the week. `days` has 0 (Sunday) to 6 (Saturday). `time` is "HH:MM". */
    | { type: 'schedule'; days: number[]; time: string };

export type ActionType = 'sendToAgent' | 'startAgent' | 'runHeadless' | 'moveTask' | 'removeWorktree' | 'notify' | 'http' | 'if' | 'stop';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A header of an HTTP request. The value can contain variables and secrets. */
export interface HttpHeader {
    name: string;
    value: string;
}

/** The default and the largest time limit of an HTTP request, in seconds. */
export const HTTP_TIMEOUT_DEFAULT = 30;
export const HTTP_TIMEOUT_MAX = 300;

export type AutomationAction =
    /**
     * Sends an HTTP request from the main process. The address, the headers and the body can contain variables and
     * secrets ("{{secret.NAME}}"). The later actions get the answer as "http.*" variables. A status outside 200 to 299
     * stops the run, unless `allowFailure` is true.
     */
    | {
          type: 'http';
          method: HttpMethod;
          url: string;
          headers?: HttpHeader[];
          body?: string;
          allowFailure?: boolean;
          timeoutSeconds?: number;
      }
    /** Runs the `then` actions when the condition agrees, else the `else` actions. */
    | { type: 'if'; condition: Condition; then: AutomationAction[]; else?: AutomationAction[] }
    /** Stops the run. With `fail`, the run fails. `reason` goes into the run history. */
    | { type: 'stop'; reason?: string; fail?: boolean }
    /**
     * Sends the prompt to the agent of the worktree. ShipWarden starts the agent of the repository when no agent runs.
     * With `mode`, the agent works in that permission mode. See `AgentMode`.
     */
    | { type: 'sendToAgent'; prompt: string; mode?: AgentMode }
    /**
     * Makes a new worktree and sends the prompt to a new agent in it. For a task, the branch comes from the task.
     * For a schedule, `branch` is the branch name, with variables. With `mode`, the agent starts in that permission mode.
     */
    | { type: 'startAgent'; prompt: string; agentId?: string; branch?: string; mode?: AgentMode }
    /** Runs the agent in print mode. The agent does not change files. With `saveNote`, the answer goes into a note. */
    | { type: 'runHeadless'; prompt: string; saveNote?: boolean }
    /** Moves the task of the worktree, or the matching task, to the status with this name. */
    | { type: 'moveTask'; status: string }
    /** Removes the worktree. Git refuses a worktree with changes. With `deleteBranch`, also deletes a merged local branch. */
    | { type: 'removeWorktree'; deleteBranch?: boolean }
    /** Shows a macOS notification. */
    | { type: 'notify'; title: string; body?: string };

export type Approval = 'auto' | 'ask';

export interface AutomationLimits {
    /** "ask": each run waits for the user's approval. "auto": the run starts at once. */
    approval: Approval;
    /** The most runs for one target, for example one pull request or one task. Then the automation stops for that target. */
    maxRunsPerTarget: number;
    /** The most agents that this automation started and that still work. A "startAgent" run waits for a free place. */
    maxRunning: number;
    /**
     * The most tokens that the runs of this automation can use in one day (local time). When they used more, the
     * automation starts no runs until the next day. Undefined: no limit. See `countedTokens` for what counts.
     */
    dailyTokens?: number;
    /**
     * The plan usage in percent at which this automation starts no runs. The check uses each usage window of Claude
     * and Codex. Undefined: only the limit for all automations applies.
     */
    pauseAtUsage?: number;
}

export interface AutomationConditions {
    /** Only branches that match this pattern. "*" matches any text. Empty: all branches. */
    branchPattern?: string;
    /**
     * The run starts only when this condition agrees. It uses the variables that the event gives without a request:
     * not "checks", not "http.*" and not the details of the task of a worktree. An "If" action can use all variables.
     * For a manual automation, the button shows only when the condition agrees.
     */
    when?: Condition;
}

/** The portable part of an automation. An export contains only these fields. */
export interface AutomationDefinition {
    version: number;
    id: string;
    name: string;
    description?: string;
    trigger: Trigger;
    conditions?: AutomationConditions;
    actions: AutomationAction[];
    limits: AutomationLimits;
}

/** "on": the automation runs. "dry-run": it records what it would do, and does nothing. "off": it does not run. */
export type AutomationStatus = 'on' | 'dry-run' | 'off';

/** A collection (for example a ClickUp list) of a "task.new" binding. */
export interface BoundCollection {
    id: string;
    /** The display name of the collection, for the UI. */
    name?: string;
}

/** A rule of a "task.new" binding: a task with the label goes to the repository. */
export interface LabelRepo {
    label: string;
    repo: string;
}

/** The local part of an automation. An export does not contain it. */
export interface AutomationBinding {
    /**
     * The repository folders. Pull request and agent triggers: only these repositories (empty: all).
     * Tasks and schedules: the first one. For tasks, it is the repository when no rule of `labelRepos` matches.
     */
    repos?: string[];
    /** The task connection of a "task.new" trigger. */
    connectionId?: string;
    /** The collections of a "task.new" trigger. ShipWarden reads the tasks of each one. */
    collections?: BoundCollection[];
    /** The repository of a task by its label, for a "task.new" trigger. The first rule with a label of the task applies. */
    labelRepos?: LabelRepo[];
    /**
     * The secret values of the HTTP requests, by name. "{{secret.NAME}}" gives the value, only in the fields of an HTTP
     * request. An export never contains them.
     */
    secrets?: Record<string, string>;
}

export interface Automation extends AutomationDefinition {
    status: AutomationStatus;
    binding: AutomationBinding;
}

/** A file in the automations folder that ShipWarden could not read. */
export interface AutomationProblem {
    file: string;
    error: string;
}

export interface AutomationList {
    /** The folder of the automation files. */
    folder: string;
    automations: Automation[];
    problems: AutomationProblem[];
}

export const TRIGGER_TYPES: { type: TriggerType; label: string; description: string }[] = [
    { type: 'ci.failed', label: 'CI failed', description: 'The checks of the pull request of a worktree branch failed.' },
    { type: 'pr.comment', label: 'New pull request comment', description: 'Another person commented on or reviewed the pull request of a worktree branch.' },
    { type: 'pr.conflict', label: 'Merge conflicts', description: 'The pull request of a worktree branch has merge conflicts.' },
    { type: 'pr.merged', label: 'Pull request merged', description: 'The pull request of a worktree branch was merged.' },
    { type: 'agent.done', label: 'Agent finished', description: 'An agent ended its turn.' },
    {
        type: 'task.new',
        label: 'Task matches',
        description:
            'A task of a collection agrees with the filters for the first time: a new task, or a task that gets the label, the assignee or the status. A done task never counts.'
    },
    { type: 'schedule', label: 'Schedule', description: 'A time of day on the selected days.' },
    {
        type: 'manual',
        label: 'Manual (a button)',
        description: 'You click a button in the view of a worktree, a pull request or a task. The automation does not run by itself.'
    }
];

export const ACTION_TYPES: { type: ActionType; label: string; description: string }[] = [
    { type: 'sendToAgent', label: 'Send to the agent', description: 'Sends a prompt to the agent of the worktree.' },
    { type: 'startAgent', label: 'Start an agent', description: 'Makes a new worktree and gives the prompt to a new agent.' },
    { type: 'runHeadless', label: 'Ask an agent', description: 'Runs the agent in print mode. The agent does not change files.' },
    { type: 'moveTask', label: 'Move the task', description: 'Moves the task to a status.' },
    { type: 'removeWorktree', label: 'Remove the worktree', description: 'Removes the worktree. Git refuses a worktree with changes.' },
    { type: 'notify', label: 'Show a notification', description: 'Shows a macOS notification.' },
    {
        type: 'http',
        label: 'Send an HTTP request',
        description: 'Sends a request to a web address. The next actions get the answer as {{http.status}}, {{http.body}} and {{http.json.…}}.'
    },
    { type: 'if', label: 'If', description: 'Runs some actions when a condition agrees, and other actions when it does not agree.' },
    { type: 'stop', label: 'Stop', description: 'Stops the run. The next actions do not run.' }
];

/** The triggers of events about a worktree branch. */
const WORKTREE_TRIGGERS: readonly TriggerType[] = ['ci.failed', 'pr.comment', 'pr.conflict', 'pr.merged', 'agent.done'];

/**
 * The triggers that each action can follow. An action needs the data of its trigger, for example a worktree.
 * A manual trigger uses `MANUAL_ACTIONS` instead, by its entity.
 */
export const ACTION_TRIGGERS: Record<ActionType, readonly TriggerType[]> = {
    sendToAgent: ['ci.failed', 'pr.comment', 'pr.conflict', 'agent.done'],
    startAgent: ['task.new', 'schedule'],
    runHeadless: ['ci.failed', 'pr.comment', 'pr.conflict', 'pr.merged', 'agent.done', 'task.new', 'schedule'],
    moveTask: ['ci.failed', 'pr.comment', 'pr.conflict', 'pr.merged', 'agent.done', 'task.new'],
    removeWorktree: ['pr.merged'],
    notify: ['ci.failed', 'pr.comment', 'pr.conflict', 'pr.merged', 'agent.done', 'task.new', 'schedule'],
    http: ['ci.failed', 'pr.comment', 'pr.conflict', 'pr.merged', 'agent.done', 'task.new', 'schedule'],
    if: ['ci.failed', 'pr.comment', 'pr.conflict', 'pr.merged', 'agent.done', 'task.new', 'schedule'],
    stop: ['ci.failed', 'pr.comment', 'pr.conflict', 'pr.merged', 'agent.done', 'task.new', 'schedule']
};

/** The entities of a manual trigger that each action can act on. */
const MANUAL_ACTIONS: Record<ActionType, readonly ManualEntity[]> = {
    sendToAgent: ['worktree', 'pullRequest'],
    startAgent: ['task', 'none'],
    runHeadless: ['worktree', 'pullRequest', 'task', 'none'],
    moveTask: ['worktree', 'pullRequest', 'task'],
    removeWorktree: ['worktree', 'pullRequest'],
    notify: ['worktree', 'pullRequest', 'task', 'none'],
    http: ['worktree', 'pullRequest', 'task', 'none'],
    if: ['worktree', 'pullRequest', 'task', 'none'],
    stop: ['worktree', 'pullRequest', 'task', 'none']
};

/** True when the action can follow the trigger. */
export function actionAllowed(type: ActionType, trigger: Trigger): boolean {
    return trigger.type === 'manual' ? MANUAL_ACTIONS[type].includes(trigger.entity) : ACTION_TRIGGERS[type].includes(trigger.type);
}

/** True when the trigger is about a worktree branch. These triggers use `binding.repos` as a filter. */
export function isWorktreeTrigger(type: TriggerType): boolean {
    return WORKTREE_TRIGGERS.includes(type);
}

/** True when the trigger acts on worktrees: a pull request or agent trigger, or a manual worktree or pull request button. */
export function actsOnWorktrees(trigger: Trigger): boolean {
    return isWorktreeTrigger(trigger.type) || (trigger.type === 'manual' && (trigger.entity === 'worktree' || trigger.entity === 'pullRequest'));
}

/** True when the trigger acts on tasks: "task.new", or a manual task button. */
export function actsOnTasks(trigger: Trigger): boolean {
    return trigger.type === 'task.new' || (trigger.type === 'manual' && trigger.entity === 'task');
}

/** Returns all actions, also the actions in "If" actions, in order. */
export function flattenActions(actions: readonly AutomationAction[]): AutomationAction[] {
    return actions.flatMap(action => (action.type === 'if' ? [action, ...flattenActions(action.then), ...flattenActions(action.else ?? [])] : [action]));
}

/** Returns all texts of an automation that can contain variables: the prompts, the fields of the actions and the conditions. */
export function automationTexts(automation: Pick<AutomationDefinition, 'actions' | 'conditions'>): string[] {
    const texts = flattenActions(automation.actions).flatMap(action => {
        switch (action.type) {
            case 'sendToAgent':
            case 'runHeadless':
                return [action.prompt];
            case 'startAgent':
                return [action.prompt, action.branch ?? ''];
            case 'notify':
                return [action.title, action.body ?? ''];
            case 'http':
                return [action.url, action.body ?? '', ...(action.headers ?? []).map(header => header.value)];
            case 'if':
                return conditionTexts(action.condition);
            case 'stop':
                return [action.reason ?? ''];
            default:
                return [];
        }
    });
    return automation.conditions?.when ? [...texts, ...conditionTexts(automation.conditions.when)] : texts;
}

/** True when a text of the automation uses a variable with this name or this prefix, for example "task." or "checks". */
export function usesVariable(automation: Pick<AutomationDefinition, 'actions' | 'conditions'>, prefix: string): boolean {
    return automationTexts(automation).some(text => templateVariables(text).some(name => name === prefix || name.startsWith(prefix)));
}

/** The names of the secrets that the HTTP requests of the automation use. */
export function usedSecrets(automation: Pick<AutomationDefinition, 'actions'>): string[] {
    const names = flattenActions(automation.actions)
        .filter(action => action.type === 'http')
        .flatMap(action => [action.url, action.body ?? '', ...(action.headers ?? []).map(header => header.value)])
        .flatMap(templateVariables)
        .filter(name => name.startsWith(SECRET_PREFIX))
        .map(name => name.slice(SECRET_PREFIX.length));
    return [...new Set(names)];
}

const SECRET_PREFIX = 'secret.';
/** The text that the run history shows for a secret. */
export const SECRET_MASK = '•••';

/** The values of the secrets as variables. With `masked`, each value is SECRET_MASK, for the run history. */
export function secretVariables(binding: AutomationBinding, masked = false): Record<string, string> {
    return Object.fromEntries(Object.entries(binding.secrets ?? {}).map(([name, value]) => [`${SECRET_PREFIX}${name}`, masked ? SECRET_MASK : value]));
}

/** True when the conditions of the automation agree with the values. An automation without conditions agrees. */
export function conditionsAgree(automation: Pick<AutomationDefinition, 'conditions'>, values: Record<string, string | undefined>): boolean {
    const when = automation.conditions?.when;
    return !when || conditionHolds(when, values);
}

/**
 * Returns the repository of a task: the repository of the first rule with a label of the task, or else the first
 * repository of the binding. Undefined when there is neither.
 */
export function taskRepo(binding: AutomationBinding, task: Pick<Task, 'labels'>): string | undefined {
    const labels = new Set((task.labels ?? []).map(label => label.name.toLowerCase()));
    return binding.labelRepos?.find(rule => labels.has(rule.label.toLowerCase()))?.repo ?? binding.repos?.[0];
}

/** True when the trigger needs one repository in the binding: a task trigger or a schedule that starts agents or asks agents. */
export function needsRepo(automation: Pick<AutomationDefinition, 'trigger' | 'actions'>): boolean {
    const actions = flattenActions(automation.actions);
    const trigger = automation.trigger;
    if (actsOnTasks(trigger)) return actions.some(action => action.type === 'startAgent');
    if (trigger.type === 'schedule' || (trigger.type === 'manual' && trigger.entity === 'none')) {
        return actions.some(action => action.type === 'startAgent' || action.type === 'runHeadless');
    }
    return false;
}

export interface VariableInfo {
    name: string;
    description: string;
}

/** The variables of an HTTP answer. They have values after an "HTTP request" action. */
export const HTTP_VARIABLES: VariableInfo[] = [
    { name: 'http.status', description: 'The status of the last HTTP answer, for example 200' },
    { name: 'http.ok', description: '"true" when the status of the last HTTP answer is 200 to 299' },
    { name: 'http.body', description: 'The body of the last HTTP answer' },
    { name: 'http.json.NAME', description: 'A value of a JSON answer, for example http.json.data.id or http.json.items.0.name' }
];

/** The variables of each manual entity. */
const ENTITY_VARIABLES: Record<ManualEntity, () => VariableInfo[]> = {
    worktree: () => [...worktreeVariables(), ...prVariables(' (when the branch has one)'), ...linkedTaskVariables()],
    pullRequest: () => [...prVariables(), ...prDetailVariables(), ...worktreeVariables(), ...linkedTaskVariables()],
    task: () => [...taskVariables(), { name: 'repo', description: 'The name of the repository' }, ...timeVariables()],
    none: () => [{ name: 'repo', description: 'The name of the repository' }, ...timeVariables()]
};

/** Returns the variables of a trigger. The editor shows them. */
export function triggerVariables(trigger: Trigger): VariableInfo[] {
    return trigger.type === 'manual' ? ENTITY_VARIABLES[trigger.entity]() : TRIGGER_VARIABLES[trigger.type];
}

/** The variables of the prompts, for each trigger. The editor shows them. A manual trigger uses `triggerVariables`. */
export const TRIGGER_VARIABLES: Record<Exclude<TriggerType, 'manual'>, VariableInfo[]> = {
    'ci.failed': [{ name: 'checks', description: 'One line for each failed check, with the path of its saved log' }, ...prVariables(), ...worktreeVariables()],
    'pr.comment': [
        { name: 'comment.author', description: 'The author of the comment' },
        { name: 'comment.body', description: 'The text of the comment' },
        { name: 'comment.url', description: 'The web address of the comment' },
        { name: 'comment.path', description: 'The file of a review comment' },
        ...prVariables(),
        ...worktreeVariables()
    ],
    'pr.conflict': [...prVariables(), ...worktreeVariables()],
    'pr.merged': [...prVariables(), ...worktreeVariables()],
    'agent.done': [{ name: 'agent.message', description: 'The last message of the agent' }, ...worktreeVariables()],
    'task.new': [
        ...taskVariables(),
        { name: 'branch', description: 'The branch of the new worktree' },
        { name: 'repo', description: 'The name of the repository' },
        { name: 'date', description: 'The date, for example 2026-11-10' }
    ],
    schedule: [
        { name: 'date', description: 'The date, for example 2026-11-10' },
        { name: 'time', description: 'The time, for example 08:00' },
        { name: 'repo', description: 'The name of the repository' },
        { name: 'branch', description: 'The branch of the new worktree (only "Start an agent")' }
    ]
};

function prVariables(note = ''): VariableInfo[] {
    return [
        { name: 'pr.number', description: `The number of the pull request${note}` },
        { name: 'pr.title', description: `The title of the pull request${note}` },
        { name: 'pr.url', description: `The web address of the pull request${note}` },
        { name: 'pr.draft', description: `"true" for a draft pull request${note}` }
    ];
}

/** The variables that only the pull request panel gives. */
function prDetailVariables(): VariableInfo[] {
    return [
        { name: 'pr.author', description: 'The login of the author of the pull request' },
        { name: 'pr.base', description: 'The base branch of the pull request' },
        { name: 'pr.state', description: 'The state of the pull request: OPEN, MERGED or CLOSED' },
        { name: 'pr.body', description: 'The description of the pull request' }
    ];
}

function worktreeVariables(): VariableInfo[] {
    return [
        { name: 'branch', description: 'The branch of the worktree' },
        { name: 'repo', description: 'The name of the repository' },
        { name: 'worktree', description: 'The folder of the worktree' },
        ...timeVariables()
    ];
}

function timeVariables(): VariableInfo[] {
    return [
        { name: 'date', description: 'The date, for example 2026-11-10' },
        { name: 'time', description: 'The time, for example 08:00' }
    ];
}

function taskVariables(): VariableInfo[] {
    return [
        { name: 'task.key', description: 'The key of the task, for example ENG-12' },
        { name: 'task.title', description: 'The title of the task' },
        { name: 'task.url', description: 'The web address of the task' },
        { name: 'task.description', description: 'The description of the task' },
        { name: 'task.status', description: 'The status of the task' },
        { name: 'task.labels', description: 'The labels of the task, separated by commas' },
        { name: 'task.assignees', description: 'The assignees of the task, separated by commas' },
        { name: 'task.priority', description: 'The priority of the task' }
    ];
}

/** The variables of the task of a worktree. The key and the title are always known. The others need a request. */
function linkedTaskVariables(): VariableInfo[] {
    return taskVariables().map(variable => ({ ...variable, description: `${variable.description} of the worktree, if it has one` }));
}

/**
 * Returns the variables of the text that the trigger does not give, one time each. The "http.*" variables are always
 * known. The "secret.*" variables are known only with `secrets`, for the fields of an HTTP request.
 */
export function unknownVariables(template: string, trigger: Trigger, options: { secrets?: readonly string[] } = {}): string[] {
    const known = new Set(triggerVariables(trigger).map(variable => variable.name));
    return templateVariables(template).filter(name => {
        if (known.has(name) || name.startsWith('http.')) return false;
        if (name.startsWith(SECRET_PREFIX) && options.secrets) return false;
        return true;
    });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Validation                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export const DEFAULT_LIMITS: AutomationLimits = { approval: 'auto', maxRunsPerTarget: 3, maxRunning: 2 };

const MAX_NAME_LENGTH = 80;
const MAX_TEXT_LENGTH = 20_000;
const MAX_LIMIT = 100;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** An automation file or an import that is not valid. The message tells the user what to change. */
export class AutomationError extends Error {}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
    return typeof value === 'string' && value.trim() && value.length <= max ? value : undefined;
}

function names(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const list = [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()))].filter(Boolean);
    return list.length > 0 ? list : undefined;
}

function count(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : fallback;
}

/** Makes an ID from a name: lowercase letters, digits and hyphens. */
export function slugId(name: string): string {
    const slug = name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/, '');
    return slug || 'automation';
}

/** Returns an ID from the name that is not in `taken`. A second "Fix CI" gets "fix-ci-2". */
export function uniqueId(name: string, taken: Iterable<string>): string {
    const used = new Set(taken);
    const base = slugId(name);
    if (!used.has(base)) return base;
    for (let index = 2; ; index++) {
        const id = `${base}-${index}`;
        if (!used.has(id)) return id;
    }
}

/** True when the ID can be a file name in the automations folder. */
export function isAutomationId(id: unknown): id is string {
    return typeof id === 'string' && ID_PATTERN.test(id);
}

function normalizeTrigger(value: unknown): Trigger {
    const raw = record(value);
    switch (raw.type) {
        case 'ci.failed':
        case 'pr.conflict':
        case 'pr.merged':
            return { type: raw.type };
        case 'pr.comment': {
            const ignoreAuthors = names(raw.ignoreAuthors);
            return { type: 'pr.comment', ...(raw.reviewsOnly === true ? { reviewsOnly: true } : {}), ...(ignoreAuthors ? { ignoreAuthors } : {}) };
        }
        case 'agent.done':
            return { type: 'agent.done', ...(raw.withoutPullRequest === true ? { withoutPullRequest: true } : {}) };
        case 'task.new': {
            const labels = names(raw.labels);
            const status = text(raw.status, MAX_NAME_LENGTH)?.trim();
            return {
                type: 'task.new',
                ...(labels ? { labels } : {}),
                ...(raw.assignedToMe === true ? { assignedToMe: true } : {}),
                ...(status ? { status } : {})
            };
        }
        case 'schedule': {
            const days = Array.isArray(raw.days)
                ? [...new Set(raw.days.filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6))].sort()
                : [];
            if (days.length === 0) throw new AutomationError('A schedule needs one or more days.');
            if (typeof raw.time !== 'string' || !TIME_PATTERN.test(raw.time))
                throw new AutomationError('A schedule needs a time in the form HH:MM, for example 08:00.');
            return { type: 'schedule', days, time: raw.time };
        }
        case 'manual': {
            const entity = MANUAL_ENTITIES.find(item => item.entity === raw.entity)?.entity;
            if (!entity) {
                throw new AutomationError(`A manual trigger needs an entity. Use one of: ${MANUAL_ENTITIES.map(item => item.entity).join(', ')}.`);
            }
            const button = text(raw.button, 40)?.replace(/\s+/g, ' ').trim();
            return { type: 'manual', entity, ...(button ? { button } : {}) };
        }
        default:
            throw new AutomationError(`The trigger "${String(raw.type ?? '')}" is not known. Use one of: ${TRIGGER_TYPES.map(item => item.type).join(', ')}.`);
    }
}

/** Checks a condition and gives its error the type of the automation errors. */
function condition(value: unknown, place: string): Condition {
    try {
        return normalizeCondition(value, place);
    } catch (error) {
        if (error instanceof ConditionError) throw new AutomationError(error.message);
        throw error;
    }
}

/** The most actions in one list. */
const MAX_ACTIONS = 50;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Checks a list of actions. `prefix` names the place of a nested list, for example "Action 2, then". */
function normalizeActions(value: unknown, prefix: string, depth: number, required: boolean): AutomationAction[] {
    if (!Array.isArray(value)) {
        if (required) throw new AutomationError('The automation needs one or more actions.');
        return [];
    }
    if (required && value.length === 0) throw new AutomationError('The automation needs one or more actions.');
    if (value.length > MAX_ACTIONS) throw new AutomationError(`A list of actions can have ${MAX_ACTIONS} actions at most.`);
    return value.map((item, index) => normalizeAction(item, index, prefix, depth));
}

function normalizeAction(value: unknown, index: number, prefix = '', depth = 0): AutomationAction {
    const raw = record(value);
    const place = `${prefix}Action ${index + 1}`;
    const prompt = () => {
        const result = text(raw.prompt);
        if (!result) throw new AutomationError(`${place} needs a prompt.`);
        return result;
    };
    const mode = () => {
        if (raw.mode === undefined) return {};
        if (!isAgentMode(raw.mode))
            throw new AutomationError(`${place} has the mode "${String(raw.mode)}". Use one of: ${AGENT_MODES.map(item => item.mode).join(', ')}.`);
        return { mode: raw.mode };
    };
    switch (raw.type) {
        case 'sendToAgent':
            return { type: 'sendToAgent', prompt: prompt(), ...mode() };
        case 'startAgent': {
            const agentId = text(raw.agentId, MAX_NAME_LENGTH);
            const branch = text(raw.branch, 200)?.trim();
            return { type: 'startAgent', prompt: prompt(), ...(agentId ? { agentId } : {}), ...(branch ? { branch } : {}), ...mode() };
        }
        case 'runHeadless':
            return { type: 'runHeadless', prompt: prompt(), ...(raw.saveNote === true ? { saveNote: true } : {}) };
        case 'moveTask': {
            const status = text(raw.status, MAX_NAME_LENGTH)?.trim();
            if (!status) throw new AutomationError(`${place} needs the name of a status.`);
            return { type: 'moveTask', status };
        }
        case 'removeWorktree':
            return { type: 'removeWorktree', ...(raw.deleteBranch === true ? { deleteBranch: true } : {}) };
        case 'notify': {
            const title = text(raw.title, 200)?.trim();
            if (!title) throw new AutomationError(`${place} needs a title.`);
            const body = text(raw.body, 1000);
            return { type: 'notify', title, ...(body ? { body } : {}) };
        }
        case 'http': {
            const method = HTTP_METHODS.find(item => item === String(raw.method ?? 'GET').toUpperCase());
            if (!method) throw new AutomationError(`${place} has the method "${String(raw.method)}". Use one of: ${HTTP_METHODS.join(', ')}.`);
            const url = text(raw.url, 4000)?.trim();
            if (!url) throw new AutomationError(`${place} needs a web address.`);
            // A variable can give the start of the address, so only an address without variables gets a full check.
            if (!url.startsWith('{{') && !/^https?:\/\//i.test(url))
                throw new AutomationError(`${place} needs an address that starts with http:// or https://.`);
            const headers: HttpHeader[] = [];
            for (const item of Array.isArray(raw.headers) ? raw.headers : []) {
                const name = text(record(item).name, 200)?.trim();
                if (!name) continue;
                if (!HEADER_NAME_PATTERN.test(name)) throw new AutomationError(`${place} has the header name "${name}", which is not valid.`);
                const headerValue = record(item).value;
                headers.push({ name, value: typeof headerValue === 'string' ? headerValue.slice(0, 4000) : '' });
            }
            const body = text(raw.body);
            const timeout = typeof raw.timeoutSeconds === 'number' && Number.isFinite(raw.timeoutSeconds) ? Math.round(raw.timeoutSeconds) : undefined;
            return {
                type: 'http',
                method,
                url,
                ...(headers.length > 0 ? { headers } : {}),
                ...(body && method !== 'GET' ? { body } : {}),
                ...(raw.allowFailure === true ? { allowFailure: true } : {}),
                ...(timeout !== undefined && timeout !== HTTP_TIMEOUT_DEFAULT ? { timeoutSeconds: Math.min(HTTP_TIMEOUT_MAX, Math.max(1, timeout)) } : {})
            };
        }
        case 'if': {
            if (depth >= MAX_NESTING) throw new AutomationError(`${place} is in more than ${MAX_NESTING} levels of "If" actions.`);
            if (raw.condition === undefined) throw new AutomationError(`${place} needs a condition.`);
            const then = normalizeActions(raw.then, `${place}, then: `, depth + 1, false);
            const otherwise = normalizeActions(raw.else, `${place}, else: `, depth + 1, false);
            if (then.length === 0 && otherwise.length === 0) throw new AutomationError(`${place} needs one or more actions in "then" or "else".`);
            return { type: 'if', condition: condition(raw.condition, place), then, ...(otherwise.length > 0 ? { else: otherwise } : {}) };
        }
        case 'stop': {
            const reason = text(raw.reason, 1000)?.trim();
            return { type: 'stop', ...(reason ? { reason } : {}), ...(raw.fail === true ? { fail: true } : {}) };
        }
        default:
            throw new AutomationError(`${place} has the type "${String(raw.type ?? '')}". Use one of: ${ACTION_TYPES.map(item => item.type).join(', ')}.`);
    }
}

function normalizeLimits(value: unknown): AutomationLimits {
    const raw = record(value);
    const dailyTokens = tokenLimitOf(raw.dailyTokens);
    const pauseAtUsage = typeof raw.pauseAtUsage === 'number' && Number.isFinite(raw.pauseAtUsage) ? clampUsageLimit(raw.pauseAtUsage) : undefined;
    return {
        approval: raw.approval === 'ask' ? 'ask' : 'auto',
        maxRunsPerTarget: count(raw.maxRunsPerTarget, DEFAULT_LIMITS.maxRunsPerTarget),
        maxRunning: count(raw.maxRunning, DEFAULT_LIMITS.maxRunning),
        ...(dailyTokens !== undefined ? { dailyTokens } : {}),
        ...(pauseAtUsage !== undefined ? { pauseAtUsage } : {})
    };
}

/** The smallest and the largest token limit for one day, and the step of the field. */
export const TOKEN_LIMIT_MIN = 1000;
export const TOKEN_LIMIT_MAX = 1_000_000_000;
export const TOKEN_LIMIT_STEP = 100_000;

/** Returns a whole number of tokens in the range, or undefined for a value that is not a number. */
export function tokenLimitOf(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(TOKEN_LIMIT_MAX, Math.max(TOKEN_LIMIT_MIN, Math.round(value)));
}

/**
 * Checks the portable part of an automation and returns it in a clean form. Unknown fields go out.
 * Throws an `AutomationError` with a message for the user when a value is missing or not valid.
 */
export function normalizeDefinition(value: unknown): AutomationDefinition {
    const raw = record(value);
    if (raw.kind !== undefined && raw.kind !== AUTOMATION_KIND) throw new AutomationError('This JSON text is not a ShipWarden automation.');
    const version = raw.version === undefined ? AUTOMATION_FORMAT_VERSION : raw.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new AutomationError('The "version" field must be a whole number.');
    if (version > AUTOMATION_FORMAT_VERSION) {
        throw new AutomationError(
            `This automation has format version ${version}. This ShipWarden reads version ${AUTOMATION_FORMAT_VERSION}. Update ShipWarden.`
        );
    }
    const name = text(raw.name, MAX_NAME_LENGTH)?.replace(/\s+/g, ' ').trim();
    if (!name) throw new AutomationError(`The automation needs a name of 1 to ${MAX_NAME_LENGTH} characters.`);
    const trigger = normalizeTrigger(raw.trigger);
    const actions = normalizeActions(raw.actions, '', 0, true);
    for (const action of flattenActions(actions)) {
        if (!actionAllowed(action.type, trigger)) {
            const label = ACTION_TYPES.find(item => item.type === action.type)?.label ?? action.type;
            throw new AutomationError(`The action "${label}" cannot follow the trigger "${describeTrigger(trigger)}".`);
        }
    }
    const description = text(raw.description, 1000)?.trim();
    const rawConditions = record(raw.conditions);
    const branchPattern = text(rawConditions.branchPattern, 200)?.trim();
    const when = rawConditions.when === undefined ? undefined : condition(rawConditions.when, 'The conditions');
    // An empty group agrees always, so it is the same as no condition.
    const hasWhen = when && !('all' in when && when.all.length === 0);
    const conditions: AutomationConditions = { ...(branchPattern ? { branchPattern } : {}), ...(hasWhen ? { when } : {}) };
    return {
        version: AUTOMATION_FORMAT_VERSION,
        id: isAutomationId(raw.id) ? raw.id : slugId(name),
        name,
        ...(description ? { description } : {}),
        trigger,
        ...(Object.keys(conditions).length > 0 ? { conditions } : {}),
        actions,
        limits: normalizeLimits(raw.limits)
    };
}

function normalizeCollections(raw: Record<string, unknown>): BoundCollection[] {
    // A file of an older version has one collection in "collectionId" and "collectionName".
    const items = Array.isArray(raw.collections) ? raw.collections : [{ id: raw.collectionId, name: raw.collectionName }];
    const result: BoundCollection[] = [];
    for (const item of items) {
        const id = text(record(item).id, 200);
        const name = text(record(item).name, 200);
        if (id && !result.some(other => other.id === id)) result.push({ id, ...(name ? { name } : {}) });
    }
    return result;
}

function normalizeLabelRepos(value: unknown): LabelRepo[] {
    const result: LabelRepo[] = [];
    for (const item of Array.isArray(value) ? value : []) {
        const label = text(record(item).label, 200)?.trim();
        const repo = text(record(item).repo, 1000);
        if (!label || !repo?.startsWith('/')) continue;
        if (!result.some(other => other.label.toLowerCase() === label.toLowerCase())) result.push({ label, repo });
    }
    return result;
}

/** The name of a secret: a letter or "_", then letters, digits and "_". */
export const SECRET_NAME_PATTERN = /^[A-Za-z_]\w{0,63}$/;

function normalizeSecrets(value: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, secret] of Object.entries(record(value))) {
        if (SECRET_NAME_PATTERN.test(name) && typeof secret === 'string' && secret.length <= 4000) result[name] = secret;
    }
    return result;
}

function normalizeBinding(value: unknown, trigger: Trigger): AutomationBinding {
    const raw = record(value);
    const repos = names(raw.repos)?.filter(repo => repo.startsWith('/'));
    const connectionId = text(raw.connectionId, 200);
    const collections = normalizeCollections(raw);
    // Only a task trigger uses the label rules.
    const labelRepos = actsOnTasks(trigger) ? normalizeLabelRepos(raw.labelRepos) : [];
    const secrets = normalizeSecrets(raw.secrets);
    return {
        ...(repos && repos.length > 0 ? { repos } : {}),
        ...(connectionId ? { connectionId } : {}),
        ...(collections.length > 0 ? { collections } : {}),
        ...(labelRepos.length > 0 ? { labelRepos } : {}),
        ...(Object.keys(secrets).length > 0 ? { secrets } : {})
    };
}

/** Checks a stored automation: the definition, the status and the binding. Throws an `AutomationError` when it is not valid. */
export function normalizeAutomation(value: unknown): Automation {
    const raw = record(value);
    const status: AutomationStatus = raw.status === 'on' || raw.status === 'dry-run' ? raw.status : 'off';
    const definition = normalizeDefinition(value);
    return { ...definition, status, binding: normalizeBinding(raw.binding, definition.trigger) };
}

/**
 * Returns the problems that stop an automation from running on this Mac, for example a missing repository.
 * The automation can be saved with problems, but it can only be "off".
 */
export function bindingProblems(automation: Automation, knownRepos: readonly string[]): string[] {
    const problems: string[] = [];
    const repos = automation.binding.repos ?? [];
    const ruleRepos = automation.binding.labelRepos?.map(rule => rule.repo) ?? [];
    const missing = [...new Set([...repos, ...ruleRepos])].filter(repo => !knownRepos.includes(repo));
    if (missing.length > 0) problems.push(`No project has the repository ${missing.join(', ')}.`);
    if (needsRepo(automation) && repos.length === 0 && ruleRepos.length === 0) problems.push('Select a repository.');
    if (automation.trigger.type === 'task.new' && (!automation.binding.connectionId || !automation.binding.collections?.length)) {
        problems.push('Select a task manager and a collection.');
    }
    const missingSecrets = usedSecrets(automation).filter(name => !automation.binding.secrets?.[name]);
    if (missingSecrets.length > 0) problems.push(`Set the value of the secret ${missingSecrets.join(', ')}.`);
    return problems;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Import and export                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Returns the JSON text of the portable part of an automation. It has no paths and no IDs of this Mac. */
export function exportAutomation(automation: AutomationDefinition): string {
    const definition = normalizeDefinition(automation);
    return `${JSON.stringify({ kind: AUTOMATION_KIND, ...definition }, null, 2)}\n`;
}

/**
 * Reads the JSON text of an import. The binding and the status of the text are ignored: the user selects the binding,
 * and an imported automation starts "off". Throws an `AutomationError` with a message for the user.
 */
export function parseAutomationImport(source: string): AutomationDefinition {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new AutomationError('The text is not valid JSON.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationError('The JSON text must be one object.');
    return normalizeDefinition(value);
}

/** Makes an automation from an imported definition: an ID that is not in use, status "off" and an empty binding. */
export function importedAutomation(definition: AutomationDefinition, takenIds: Iterable<string>): Automation {
    const taken = new Set(takenIds);
    const id = taken.has(definition.id) ? uniqueId(definition.name, taken) : definition.id;
    return { ...definition, id, status: 'off', binding: {} };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Templates                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface AutomationTemplate {
    id: string;
    name: string;
    description: string;
    definition: Omit<AutomationDefinition, 'id' | 'version'>;
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
    {
        id: 'fix-ci',
        name: 'Fix failed CI',
        description: 'When CI fails on the pull request of a worktree, send the failed checks to its agent.',
        definition: {
            name: 'Fix failed CI',
            trigger: { type: 'ci.failed' },
            actions: [
                {
                    type: 'sendToAgent',
                    prompt: 'CI failed on pull request #{{pr.number}} ({{pr.url}}):\n{{checks}}\n\nFind the cause of each failure and fix it. Run the tests, then commit and push the fix.'
                }
            ],
            limits: { approval: 'auto', maxRunsPerTarget: 3, maxRunning: 2 }
        }
    },
    {
        id: 'address-comments',
        name: 'Address review comments',
        description: 'When a person comments on or reviews the pull request of a worktree, send the comment to its agent.',
        definition: {
            name: 'Address review comments',
            trigger: { type: 'pr.comment' },
            actions: [
                {
                    type: 'sendToAgent',
                    prompt: '{{comment.author}} left this comment on pull request #{{pr.number}} ({{comment.url}}):\n\n{{comment.body}}\n\nRead the comment and make the changes that it asks for. Then commit and push.'
                }
            ],
            limits: { approval: 'ask', maxRunsPerTarget: 10, maxRunning: 2 }
        }
    },
    {
        id: 'resolve-conflicts',
        name: 'Resolve merge conflicts',
        description: 'When the pull request of a worktree has merge conflicts, tell its agent to merge the base branch.',
        definition: {
            name: 'Resolve merge conflicts',
            trigger: { type: 'pr.conflict' },
            actions: [
                {
                    type: 'sendToAgent',
                    prompt: 'Pull request #{{pr.number}} ({{pr.url}}) has merge conflicts. Fetch origin, merge the base branch into {{branch}}, resolve the conflicts, run the tests, and commit and push the merge.'
                }
            ],
            limits: { approval: 'auto', maxRunsPerTarget: 2, maxRunning: 2 }
        }
    },
    {
        id: 'open-pull-request',
        name: 'Open a pull request',
        description: 'When an agent finishes and its branch has no pull request, tell the agent to open one.',
        definition: {
            name: 'Open a pull request',
            trigger: { type: 'agent.done', withoutPullRequest: true },
            actions: [
                {
                    type: 'sendToAgent',
                    prompt: 'If your work on {{branch}} is complete, commit it, push the branch and open a draft pull request with `gh pr create --draft --fill`. If the work is not complete, continue it.'
                }
            ],
            limits: { approval: 'ask', maxRunsPerTarget: 1, maxRunning: 2 }
        }
    },
    {
        id: 'clean-up-merged',
        name: 'Clean up after merge',
        description: 'When the pull request of a worktree is merged, move its task to "done" and remove the worktree.',
        definition: {
            name: 'Clean up after merge',
            trigger: { type: 'pr.merged' },
            actions: [
                { type: 'moveTask', status: 'done' },
                { type: 'removeWorktree', deleteBranch: true }
            ],
            limits: { approval: 'ask', maxRunsPerTarget: 1, maxRunning: 2 }
        }
    },
    {
        id: 'start-tasks',
        name: 'Start agents on matching tasks',
        description: 'When a task with the label "agent" is assigned to you, start an agent on it in a new worktree.',
        definition: {
            name: 'Start agents on matching tasks',
            trigger: { type: 'task.new', labels: ['agent'], assignedToMe: true },
            actions: [
                {
                    type: 'startAgent',
                    prompt: 'Work on this task.\n\n{{task.key}}: {{task.title}}\n{{task.url}}\n\n{{task.description}}\n\nYou are in a new git worktree on the branch "{{branch}}". Make the change, run the tests and commit your work.'
                }
            ],
            limits: { approval: 'ask', maxRunsPerTarget: 1, maxRunning: 2 }
        }
    },
    {
        id: 'daily-summary',
        name: 'Daily summary',
        description: 'Each weekday morning, ask an agent to summarize the changes of the last day, and save the answer as a note.',
        definition: {
            name: 'Daily summary',
            trigger: { type: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00' },
            actions: [
                {
                    type: 'runHeadless',
                    prompt: 'Read `git log --since="1 day ago" --stat` of {{repo}}. Write a short summary of the changes for the team, grouped by area. Today is {{date}}.',
                    saveNote: true
                }
            ],
            limits: { approval: 'auto', maxRunsPerTarget: 1, maxRunning: 1 }
        }
    }
];

/** Makes a new automation from a template, with an ID that is not in use. A new automation starts as a dry run. */
export function automationFromTemplate(template: AutomationTemplate, takenIds: Iterable<string>): Automation {
    return {
        ...structuredClone(template.definition),
        version: AUTOMATION_FORMAT_VERSION,
        id: uniqueId(template.definition.name, takenIds),
        status: 'dry-run',
        binding: {}
    };
}

/** The default action for a trigger in the editor. */
export function defaultAction(type: ActionType): AutomationAction {
    switch (type) {
        case 'sendToAgent':
            return { type, prompt: '' };
        case 'startAgent':
            return { type, prompt: '' };
        case 'runHeadless':
            return { type, prompt: '', saveNote: true };
        case 'moveTask':
            return { type, status: 'done' };
        case 'removeWorktree':
            return { type };
        case 'notify':
            return { type, title: '' };
        case 'http':
            return { type, method: 'POST', url: 'https://', body: '{\n  "text": {{pr.title|json}}\n}' };
        case 'if':
            // biome-ignore lint/suspicious/noThenProperty: "then" is a list of actions, not a function, so the object is not a promise.
            return { type, condition: { all: [] }, then: [{ type: 'notify', title: 'The condition agrees' }] };
        case 'stop':
            return { type };
    }
}

/** The default trigger of each type in the editor. */
export function defaultTrigger(type: TriggerType): Trigger {
    switch (type) {
        case 'schedule':
            return { type, days: [1, 2, 3, 4, 5], time: '08:00' };
        case 'task.new':
            return { type, assignedToMe: true };
        case 'manual':
            return { type, entity: 'pullRequest' };
        default:
            return { type } as Trigger;
    }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Events and matching                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Something that occurred. The engine makes events from data that ShipWarden loads already. All fields are JSON
 * values, because a run that waits for approval keeps its event in the run file.
 */
export interface AutomationEvent {
    trigger: TriggerType;
    /** Identifies the occurrence. The same occurrence always gives the same key, so it runs one time only. */
    key: string;
    /** The thing that the limits count, for example "pr:/repo#12" or "task:conn:id". */
    target: string;
    /** A short name for the run history, for example "#12 Fix the login page". */
    label: string;
    at: number;
    repoPath?: string;
    worktreePath?: string;
    branch?: string;
    /** The agent session of an "agent.done" event. */
    sessionId?: string;
    pr?: {
        number: number;
        title?: string;
        url: string;
        headSha?: string;
        isDraft?: boolean;
        /** Only the pull request panel gives the fields below. */
        author?: string;
        base?: string;
        state?: string;
        body?: string;
    };
    comment?: { id: string; author: string; body: string; url: string; path?: string; reviewState?: string };
    /** The matching task of a "task.new" event, or the task of a manual task button. */
    task?: Task;
    /** The task of the worktree, from its link. The engine loads the full task when an action needs it. */
    taskLink?: { key?: string; title: string; url?: string };
    connectionId?: string;
    pluginId?: string;
    /** True when the branch has an open pull request. Only "agent.done" sets it. */
    hasPullRequest?: boolean;
    /** The last message of the agent of an "agent.done" event. */
    agentMessage?: string;
    /** The time of a "schedule" event, "HH:MM". */
    time?: string;
    /**
     * True for a run that the user started with "Run now". The run ignores the trigger, the status "off", the
     * approval, the pause and the limits. It still waits for a busy agent.
     */
    manual?: boolean;
}

/** The thing that the user selects for a manual run: a worktree, a task, or nothing. */
export type ManualTarget = 'worktree' | 'task' | 'none';

/** Returns what the user must select before a manual run of an automation with this trigger. */
export function manualTarget(trigger: Trigger): ManualTarget {
    if (actsOnWorktrees(trigger)) return 'worktree';
    return actsOnTasks(trigger) ? 'task' : 'none';
}

/** True when the branch matches the pattern. An empty pattern matches all branches. */
export function branchMatches(pattern: string | undefined, branch: string | undefined): boolean {
    if (!pattern?.trim()) return true;
    return !!branch && globRegex(pattern.trim()).test(branch);
}

/**
 * Returns the manual automations whose button shows for the entity: the status is not "off", and the repository and
 * the branch agree with the binding and the branch pattern. The caller also checks `conditionsAgree`.
 */
export function manualAutomationsFor(
    automations: readonly Automation[],
    entity: ManualEntity,
    target: { repoPath?: string; branch?: string } = {}
): Automation[] {
    return automations.filter(automation => {
        const trigger = automation.trigger;
        if (automation.status === 'off' || trigger.type !== 'manual' || trigger.entity !== entity) return false;
        if (entity !== 'worktree' && entity !== 'pullRequest') return true;
        const repos = automation.binding.repos ?? [];
        if (repos.length > 0 && (!target.repoPath || !repos.includes(target.repoPath))) return false;
        return branchMatches(automation.conditions?.branchPattern, target.branch);
    });
}

/** The text of the button of a manual automation: its button text, or else its name. */
export function buttonLabel(automation: Pick<Automation, 'name' | 'trigger'>): string {
    return (automation.trigger.type === 'manual' && automation.trigger.button) || automation.name;
}

/** True when the task agrees with the filters of a "task.new" trigger. `me` is the person key of the user, if known. */
export function taskMatchesTrigger(trigger: Extract<Trigger, { type: 'task.new' }>, task: Task, me: string | undefined): boolean {
    // A finished task needs no agent, also when its labels and its assignee still match.
    if (task.status.category === 'done' || task.status.category === 'canceled') return false;
    if (trigger.labels?.length) {
        const labels = new Set((task.labels ?? []).map(label => label.name.toLowerCase()));
        if (!trigger.labels.some(label => labels.has(label.toLowerCase()))) return false;
    }
    if (trigger.assignedToMe) {
        if (!me) return false;
        if (!(task.assignees ?? []).some(person => (person.id ?? `name:${person.name}`) === me)) return false;
    }
    if (trigger.status && task.status.name.toLowerCase() !== trigger.status.toLowerCase()) return false;
    return true;
}

/**
 * True when the event starts a run of the automation. The automation must be on (or a dry run), have the same trigger,
 * and agree with its binding and its conditions. The limits are not part of this test.
 */
export function automationMatches(automation: Automation, event: AutomationEvent): boolean {
    if (automation.status === 'off' || automation.trigger.type !== event.trigger) return false;
    const trigger = automation.trigger;
    if (isWorktreeTrigger(trigger.type)) {
        const repos = automation.binding.repos ?? [];
        if (repos.length > 0 && (!event.repoPath || !repos.includes(event.repoPath))) return false;
        if (!branchMatches(automation.conditions?.branchPattern, event.branch)) return false;
    }
    switch (trigger.type) {
        case 'pr.comment': {
            if (trigger.reviewsOnly && !event.comment?.reviewState) return false;
            const author = event.comment?.author.toLowerCase();
            if (author && trigger.ignoreAuthors?.some(name => name.toLowerCase() === author)) return false;
            return true;
        }
        case 'agent.done':
            return !trigger.withoutPullRequest || !event.hasPullRequest;
        case 'task.new':
            return event.connectionId === automation.binding.connectionId;
        default:
            return true;
    }
}

/** The key that stops a second run of the same automation for the same occurrence. */
export function firedKey(automationId: string, event: Pick<AutomationEvent, 'key'>): string {
    return `${automationId}|${event.key}`;
}

/** Makes a branch name from text: characters that git does not accept become hyphens. */
export function branchName(text: string): string {
    return (
        text
            .trim()
            .replace(/[^\w./-]+/g, '-')
            .replace(/\.{2,}/g, '.')
            .replace(/\/{2,}/g, '/')
            .replace(/^[-./]+|[-./]+$/g, '')
            .slice(0, 100) || 'automation'
    );
}

/** Returns the date as "YYYY-MM-DD" and the time as "HH:MM", in local time. */
export function localDateTime(date: Date): { date: string; time: string } {
    const pad = (value: number) => String(value).padStart(2, '0');
    return {
        date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        time: `${pad(date.getHours())}:${pad(date.getMinutes())}`
    };
}

/** Returns the last folder name of a path. */
function folderName(path: string | undefined): string | undefined {
    return path?.split('/').filter(Boolean).pop();
}

/** Returns the values of the prompt variables of an event. `extra` adds values that need a request, for example the checks. */
export function eventVariables(event: AutomationEvent, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    const { date, time } = localDateTime(new Date(event.at));
    return {
        date,
        time: event.time ?? time,
        repo: folderName(event.repoPath),
        worktree: event.worktreePath,
        branch: event.branch,
        'pr.number': event.pr ? String(event.pr.number) : undefined,
        'pr.title': event.pr?.title,
        'pr.url': event.pr?.url,
        'pr.draft': event.pr?.isDraft === undefined ? undefined : String(event.pr.isDraft),
        'pr.author': event.pr?.author,
        'pr.base': event.pr?.base,
        'pr.state': event.pr?.state,
        'pr.body': event.pr?.body,
        'comment.author': event.comment?.author,
        'comment.body': event.comment?.body,
        'comment.url': event.comment?.url,
        'comment.path': event.comment?.path,
        'task.key': event.task ? (event.task.key ?? event.task.id) : event.taskLink?.key,
        'task.title': event.task?.title ?? event.taskLink?.title,
        'task.url': event.task?.url ?? event.taskLink?.url,
        ...(event.task ? taskValues(event.task) : {}),
        'agent.message': event.agentMessage,
        ...extra
    };
}

/** The variables of a task that only the full task gives. */
export function taskValues(task: Task): Record<string, string | undefined> {
    return {
        'task.key': task.key ?? task.id,
        'task.title': task.title,
        'task.url': task.url,
        'task.description': task.description?.trim() || '(The task has no description.)',
        'task.status': task.status.name,
        'task.labels': (task.labels ?? []).map(label => label.name).join(', '),
        'task.assignees': (task.assignees ?? []).map(person => person.name).join(', '),
        'task.priority': task.priority?.name
    };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Schedules                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Returns the newest time of the schedule at or before `now`, in the last 8 days. Undefined when there is none.
 * The time is local time.
 */
export function lastScheduleSlot(trigger: Extract<Trigger, { type: 'schedule' }>, now: Date): Date | undefined {
    const [hours, minutes] = trigger.time.split(':').map(Number);
    for (let back = 0; back <= 8; back++) {
        const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hours, minutes, 0, 0);
        if (slot.getTime() <= now.getTime() && trigger.days.includes(slot.getDay())) return slot;
    }
    return undefined;
}

/**
 * Returns the time of the schedule that is due now, or undefined. A time is due when it is after the last run and
 * after `notBefore` (the start of the app). Thus a time that passed while ShipWarden was closed does not run.
 */
export function dueScheduleSlot(trigger: Extract<Trigger, { type: 'schedule' }>, now: Date, lastRun: number | undefined, notBefore: number): Date | undefined {
    const slot = lastScheduleSlot(trigger, now);
    if (!slot) return undefined;
    const time = slot.getTime();
    return time >= notBefore && (lastRun === undefined || time > lastRun) ? slot : undefined;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Runs                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The state of a run:
 * - pending: waits for the user's approval.
 * - held: waits until the agent is ready, or until fewer agents work.
 * - running: the actions run now.
 * - done, failed: the actions ended.
 * - skipped: the user skipped it, or a limit stopped it.
 * - dry-run: the automation is a dry run. Nothing ran.
 */
export type RunStatus = 'pending' | 'held' | 'running' | 'done' | 'failed' | 'skipped' | 'dry-run';

export interface AutomationRun {
    id: string;
    automationId: string;
    /** The name of the automation when the run started. The automation can change or go away later. */
    automationName: string;
    status: RunStatus;
    event: AutomationEvent;
    createdAt: number;
    updatedAt: number;
    /** A message for the user, for example the error of a failed run or the reason for a skip. */
    detail?: string;
    /** The worktree that the run used or made. */
    worktreePath?: string;
    /** The agent session that the run used or started. */
    sessionId?: string;
    /** The note with the answer of a "runHeadless" action. */
    noteName?: string;
    /** The tokens that the run used. Only Claude Code reports them. See `countedTokens`. */
    tokens?: number;
    /** The tokens that the run read from the prompt cache. The history shows them. The limits do not count them. */
    cacheReads?: number;
    /**
     * The agent turn that the run started: from the prompt to the end of the turn. The engine counts the tokens of this
     * time in the transcript of the session. `counted` is true after the last count, when the turn ended.
     */
    turn?: { sessionId: string; from: number; to?: number; counted?: boolean };
}

export interface AutomationRunState {
    /** The newest runs first. */
    runs: AutomationRun[];
    /** The fired keys (see `firedKey`) with their time. A key that is here does not start a run again. */
    fired: Record<string, number>;
    /** The time of the last run of each schedule automation. */
    scheduleRuns: Record<string, number>;
    /**
     * The task automations that recorded their first list. The tasks of the first list do not start runs.
     * An entry is "<automation ID>|<collection ID>". An entry of an older version is the automation ID only.
     */
    seeded: string[];
}

export const EMPTY_RUN_STATE: AutomationRunState = { runs: [], fired: {}, scheduleRuns: {}, seeded: [] };

/** The run history keeps at most this number of runs. */
export const MAX_RUNS = 500;
/** A fired key goes away after this time. The events of the triggers do not come again after it. */
export const FIRED_TTL_MS = 45 * 24 * 3600_000;

/** The statuses of a run that count for `maxRunsPerTarget`. A skipped run and a dry run do not count. */
const COUNTED: readonly RunStatus[] = ['pending', 'held', 'running', 'done', 'failed'];

/** The number of runs of the automation for the target that count for its limit. */
export function runsForTarget(runs: readonly AutomationRun[], automationId: string, target: string): number {
    return runs.filter(run => run.automationId === automationId && run.event.target === target && COUNTED.includes(run.status)).length;
}

/** True while the run waits or works. */
export function isOpenRun(run: Pick<AutomationRun, 'status'>): boolean {
    return run.status === 'pending' || run.status === 'held' || run.status === 'running';
}

/** Removes old fired keys and old runs. Open runs stay. */
export function pruneRunState(state: AutomationRunState, now: number): AutomationRunState {
    // A task key never goes away: a task can match its filters for months, and it must not start a second agent.
    const fired = Object.fromEntries(Object.entries(state.fired).filter(([key, at]) => key.includes('|task:') || now - at < FIRED_TTL_MS));
    const open = state.runs.filter(isOpenRun);
    const closed = state.runs.filter(run => !isOpenRun(run)).slice(0, Math.max(0, MAX_RUNS - open.length));
    const runs = [...open, ...closed].sort((a, b) => b.createdAt - a.createdAt);
    return { ...state, fired, runs };
}

/** Checks the run file. A bad value gets the empty state. */
export function normalizeRunState(value: unknown): AutomationRunState {
    const raw = record(value);
    const runs = Array.isArray(raw.runs)
        ? raw.runs.filter((run): run is AutomationRun => {
              const item = record(run);
              return typeof item.id === 'string' && typeof item.automationId === 'string' && typeof item.status === 'string' && !!item.event;
          })
        : [];
    const numbers = (value: unknown) =>
        Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
    return {
        runs,
        fired: numbers(raw.fired),
        scheduleRuns: numbers(raw.scheduleRuns),
        seeded: Array.isArray(raw.seeded) ? raw.seeded.filter((item): item is string => typeof item === 'string') : []
    };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Settings                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The settings of all automations. They are in the app settings, not in the automation files. */
export interface AutomationSettings {
    /** True stops all automations. The events that occur while they are paused do not run later. */
    paused: boolean;
    /**
     * Automations do not start runs while the plan usage of an agent is at or above this percent (5 to 100).
     * Null: no limit, for example for a user of the API, who has no plan usage.
     */
    pauseAtUsage: number | null;
    /** The most tokens that all automations together can use in one day (local time). Null: no limit. */
    dailyTokens: number | null;
}

/** The smallest and the largest usage limit, and the step of the field. */
export const USAGE_LIMIT_MIN = 5;
export const USAGE_LIMIT_MAX = 100;
export const USAGE_LIMIT_STEP = 5;

/** Returns a whole number from 5 to 100. A value that is not a number gives the default limit. */
export function clampUsageLimit(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AUTOMATION_SETTINGS.pauseAtUsage;
    return Math.min(USAGE_LIMIT_MAX, Math.max(USAGE_LIMIT_MIN, Math.round(value)));
}

export const DEFAULT_AUTOMATION_SETTINGS = { paused: false, pauseAtUsage: 90, dailyTokens: null } satisfies AutomationSettings;

export function normalizeAutomationSettings(value: unknown): AutomationSettings {
    const raw = record(value);
    return {
        paused: raw.paused === true,
        pauseAtUsage: raw.pauseAtUsage === null ? null : clampUsageLimit(raw.pauseAtUsage),
        dailyTokens: tokenLimitOf(raw.dailyTokens) ?? null
    };
}

/** A short text for the trigger, for the list of automations. */
export function describeTrigger(trigger: Trigger): string {
    const label = TRIGGER_TYPES.find(item => item.type === trigger.type)?.label ?? trigger.type;
    switch (trigger.type) {
        case 'schedule': {
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const days =
                trigger.days.join() === '1,2,3,4,5' ? 'weekdays' : trigger.days.length === 7 ? 'every day' : trigger.days.map(day => dayNames[day]).join(', ');
            return `${days} at ${trigger.time}`;
        }
        case 'task.new': {
            const parts = [
                trigger.labels?.length ? `label ${trigger.labels.join(' or ')}` : '',
                trigger.assignedToMe ? 'assigned to me' : '',
                trigger.status ? `status ${trigger.status}` : ''
            ];
            const filters = parts.filter(Boolean).join(', ');
            return filters ? `${label}: ${filters}` : label;
        }
        case 'agent.done':
            return trigger.withoutPullRequest ? `${label} without a pull request` : label;
        case 'pr.comment':
            return trigger.reviewsOnly ? 'New pull request review' : label;
        case 'manual': {
            const places: Record<ManualEntity, string> = {
                worktree: 'a button on worktrees',
                pullRequest: 'a button on pull requests',
                task: 'a button on tasks',
                none: 'the play button only'
            };
            return `Manual: ${places[trigger.entity]}`;
        }
        default:
            return label;
    }
}

/**
 * Returns a message when the plan usage of an agent is at or above the limit, else undefined. Only usage that loaded
 * correctly counts. The message names the provider and the window, for example "Claude (5h) is at 93%". The subject
 * is the start of the last sentence, for example "Automations pause".
 */
export function usageAboveLimit(usage: readonly ProviderUsage[], limit: number | null, subject = 'Automations pause'): string | undefined {
    if (limit === null) return undefined;
    for (const provider of usage) {
        if (provider.status !== 'ok') continue;
        const window = provider.windows.find(item => item.usedPercent >= limit);
        if (window) {
            return `The plan usage of ${PROVIDER_NAMES[provider.provider]} (${window.label}) is ${Math.round(window.usedPercent)}%. ${subject} at ${limit}%.`;
        }
    }
    return undefined;
}

/**
 * Returns a message when the plan usage is at or above the limit of the automation or the limit of all automations,
 * else undefined. Only the lower limit needs a check. Usage above the higher limit is also above the lower limit.
 */
export function planUsageReached(usage: readonly ProviderUsage[], automation: Pick<Automation, 'limits'>, globalLimit: number | null): string | undefined {
    const own = automation.limits.pauseAtUsage;
    if (own !== undefined && (globalLimit === null || own < globalLimit)) return usageAboveLimit(usage, own, 'This automation pauses');
    return usageAboveLimit(usage, globalLimit);
}

/**
 * Returns the tokens of one usage object of Claude Code that count for a limit: the input, the cache writes and the
 * output. Cache reads do not count. They cost a small part of the price of new input (2.5% to 10%, by model), and they would fill a limit fast.
 */
export function countedTokens(usage: unknown): number {
    if (!usage || typeof usage !== 'object') return 0;
    const value = usage as Record<string, unknown>;
    const number = (key: string) => (typeof value[key] === 'number' && Number.isFinite(value[key]) ? (value[key] as number) : 0);
    return number('input_tokens') + number('cache_creation_input_tokens') + number('output_tokens');
}

/** Returns the cache reads of one usage object of Claude Code. They do not count for a limit. */
export function cacheReadTokens(usage: unknown): number {
    const value = usage && typeof usage === 'object' ? (usage as Record<string, unknown>).cache_read_input_tokens : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The tokens of a part of a transcript: the tokens that count for a limit, and the cache reads. */
export interface TokenCount {
    tokens: number;
    cacheReads: number;
}

/** Returns the start of the local day of the time, in milliseconds. */
export function startOfDay(now: number): number {
    const date = new Date(now);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The tokens of the runs that started today (local time). With an automation ID, only the runs of that automation. */
export function tokensToday(runs: readonly Pick<AutomationRun, 'automationId' | 'createdAt' | 'tokens'>[], now: number, automationId?: string): number {
    const start = startOfDay(now);
    return runs.reduce((sum, run) => (run.createdAt >= start && (!automationId || run.automationId === automationId) ? sum + (run.tokens ?? 0) : sum), 0);
}

/**
 * Returns a message when the runs of today used the token limit of the automation or of all automations, else
 * undefined.
 */
export function tokenLimitReached(
    runs: readonly Pick<AutomationRun, 'automationId' | 'createdAt' | 'tokens'>[],
    automation: Pick<Automation, 'id' | 'limits'>,
    globalLimit: number | null,
    now: number
): string | undefined {
    const own = automation.limits.dailyTokens;
    if (own !== undefined) {
        const used = tokensToday(runs, now, automation.id);
        if (used >= own) return `The automation used ${formatTokens(used)} tokens today. Its limit is ${formatTokens(own)}. It starts again tomorrow.`;
    }
    if (globalLimit !== null) {
        const used = tokensToday(runs, now);
        if (used >= globalLimit) {
            return `All automations used ${formatTokens(used)} tokens today. The limit is ${formatTokens(globalLimit)}. They start again tomorrow.`;
        }
    }
    return undefined;
}

/** A short number of tokens, for example "950", "12.3k" or "1.2M". */
export function formatTokens(tokens: number): string {
    if (tokens < 1000) return String(Math.round(tokens));
    if (tokens < 1_000_000) return `${trimZero((tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0))}k`;
    return `${trimZero((tokens / 1_000_000).toFixed(1))}M`;
}

function trimZero(text: string): string {
    return text.replace(/\.0$/, '');
}
