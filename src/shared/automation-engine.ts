/**
 * The parts of the automation engine that the app and the background helper share. The app runs the engine in the
 * page while it runs. The helper runs `HeadlessEngine` (src/main/automations) while the app is closed. Both use these
 * functions, so a run starts, skips, and waits by the same rules in each process.
 */
import {
    ACTION_TYPES,
    conditionsAgree,
    eventVariables,
    firedKey,
    flattenActions,
    localDateTime,
    planUsageReached,
    runsForTarget,
    secretVariables,
    startOfDay,
    tokenLimitReached,
    type ActionType,
    type Automation,
    type AutomationAction,
    type AutomationEvent,
    type AutomationRun,
    type AutomationRunState,
    type AutomationSettings,
    type HttpMethod,
    type RunStatus
} from './automations';
import { checkLine } from './agent-text';
import { describeCondition, httpVariables, renderTemplate, type HttpResponse } from './automation-templates';
import type { CheckRun } from './github';
import type { RemoteAutomationRun } from './remote';
import type { ProviderUsage } from './usage';

/** A run that waits for a busy agent fails after this time. */
export const HOLD_LIMIT_MS = 12 * 3600_000;

/** The run history shows at most this much of an answer or an error. */
export const MAX_DETAIL = 4000;

/** The text of a run that a limit stopped. The engine records it one time for each target. */
export const LIMIT_DETAIL = 'The automation reached its limit of runs for this target.';

/** A word in the text of a run that the token limit stopped. The engine records it one time each day. */
export const TOKEN_LIMIT_MARK = 'tokens today';

/** The text of a run that waits for the approval of the user. */
export const APPROVAL_DETAIL = 'Waiting for your approval.';

/** The start of the text of a run that the helper gave to the app. The app runs it when it opens. */
export const WAIT_FOR_APP_PREFIX = 'Waiting for ShipWarden to open.';

/** The run states that can still change. */
export const OPEN_RUN_STATES: ReadonlySet<RunStatus> = new Set(['pending', 'held', 'running']);

/**
 * The actions that the background helper can run while the app is closed. The other actions need the page: the task
 * managers, the chat plugins, the queue cache, the "Ask an agent" runner, and the worktree removal with its checks.
 */
export const HEADLESS_ACTIONS: ReadonlySet<ActionType> = new Set(['startAgent', 'sendToAgent', 'notify', 'http', 'if', 'stop']);

/** The triggers that the background helper watches. The other triggers need the page or the Dashboard data. */
export const HEADLESS_TRIGGERS: ReadonlySet<Automation['trigger']['type']> = new Set(['schedule', 'ci.failed']);

/** The check conclusions that count as a failure. */
export const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'error', 'action_required']);

/**
 * The value of the {{checks}} variable: one line for each failed check. A GitHub Actions job gives the path of its
 * saved log. `saveLog` returns undefined when the log did not save.
 */
export async function checksVariable(checks: readonly CheckRun[], saveLog: (check: CheckRun) => Promise<string | undefined>): Promise<string> {
    const failed = checks.filter(check => FAILED_CONCLUSIONS.has(check.conclusion ?? ''));
    const lines = await Promise.all(failed.map(async check => checkLine(check, check.isActions ? await saveLog(check) : undefined)));
    return lines.length > 0 ? lines.join('\n') : '(ShipWarden found no failed checks. Look at the checks of the pull request.)';
}

/** Cuts a long text for the run history. */
export function clipDetail(text: string): string {
    return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

/** A new run ID. The time comes first, so the IDs sort by time. */
export function newRunId(now: number): string {
    return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The name of a chat channel for the run history, for example "#releases". */
export function channelLabel(channel: { id: string; name?: string }): string {
    return channel.name ? `#${channel.name}` : `the channel ${channel.id}`;
}

/** A short text of the actions, for a dry run. */
export function describeActions(actions: readonly AutomationAction[]): string {
    return actions
        .map(action => {
            if (action.type === 'if') {
                const then = describeActions(action.then) || 'nothing';
                return action.else?.length
                    ? `if ${describeCondition(action.condition)}: ${then}, else: ${describeActions(action.else)}`
                    : `if ${describeCondition(action.condition)}: ${then}`;
            }
            if (action.type === 'http') return `send ${action.method} ${action.url}`;
            if (action.type === 'postMessage') return `post to ${channelLabel(action.channel)}`;
            return ACTION_TYPES.find(item => item.type === action.type)?.label.toLowerCase() ?? action.type;
        })
        .join(', then ');
}

/** The labels of the actions of an automation that only the app can run. Empty when the helper can run all of them. */
export function appOnlyActions(automation: Pick<Automation, 'actions'>): string[] {
    const types = new Set(flattenActions(automation.actions).map(action => action.type));
    return [...types].filter(type => !HEADLESS_ACTIONS.has(type)).map(type => ACTION_TYPES.find(item => item.type === type)?.label ?? type);
}

/** The text of a run that the helper cannot run. The app runs it when it opens. */
export function waitForAppDetail(labels: readonly string[]): string {
    const list = labels.map(label => `"${label}"`).join(', ');
    return `${WAIT_FOR_APP_PREFIX} The background helper cannot run ${labels.length === 1 ? 'the action' : 'the actions'} ${list}.`;
}

/** What the engine knows when it decides about a new run. */
export interface RunInputs {
    settings: AutomationSettings;
    /** The plan usage of the agents. The helper has none, so the usage limit does not stop its runs. */
    usage: readonly ProviderUsage[];
    now: number;
    /** Makes the run ID. Tests replace it. */
    id?: (now: number) => string;
}

/**
 * Decides what an event does with an automation that matches it. Returns the run to record, or undefined when the event
 * records nothing: the automations are paused, the event fired before, the conditions do not agree, or a limit stopped
 * the automation and the history shows that already.
 *
 * The status of the run tells the next step:
 * - "running": run the actions now (`claim` the run first).
 * - "pending": wait for the approval of the user.
 * - "skipped" or "dry-run": nothing more.
 */
export function decideRun(automation: Automation, event: AutomationEvent, state: AutomationRunState, inputs: RunInputs): AutomationRun | undefined {
    const { settings, usage, now } = inputs;
    if (settings.paused) return undefined;
    if (state.fired[firedKey(automation.id, event)] !== undefined) return undefined;
    // The conditions use the values of the event only. An event that does not agree starts no run and records nothing.
    if (!conditionsAgree(automation, eventVariables(event))) return undefined;
    const run = (status: RunStatus, detail?: string): AutomationRun => ({
        id: (inputs.id ?? newRunId)(now),
        automationId: automation.id,
        automationName: automation.name,
        status,
        event,
        createdAt: now,
        updatedAt: now,
        ...(detail ? { detail } : {}),
        ...(event.worktreePath ? { worktreePath: event.worktreePath } : {}),
        ...(event.sessionId ? { sessionId: event.sessionId } : {})
    });
    if (automation.status === 'dry-run') {
        return run('dry-run', `A dry run. The automation would: ${describeActions(automation.actions)}.`);
    }
    if (runsForTarget(state.runs, automation.id, event.target) >= automation.limits.maxRunsPerTarget) {
        // Record the stop one time for each target, so the history shows why the automation does nothing.
        const stopped = state.runs.some(item => item.automationId === automation.id && item.event.target === event.target && item.detail === LIMIT_DETAIL);
        return stopped ? undefined : run('skipped', LIMIT_DETAIL);
    }
    // A "usage.threshold" run tells the user about the usage. The pause at plan usage must not stop it.
    const overUsage = automation.trigger.type === 'usage.threshold' ? undefined : planUsageReached(usage, automation, settings.pauseAtUsage);
    if (overUsage) return run('skipped', overUsage);
    const overTokens = tokenLimitReached(state.runs, automation, settings.dailyTokens, now);
    if (overTokens) {
        // Record the stop one time each day, so the history shows why the automation does nothing.
        const today = startOfDay(now);
        const stopped = state.runs.some(
            item => item.automationId === automation.id && item.status === 'skipped' && item.createdAt >= today && item.detail?.includes(TOKEN_LIMIT_MARK)
        );
        return stopped ? undefined : run('skipped', overTokens);
    }
    if (automation.limits.approval === 'ask') return run('pending', APPROVAL_DETAIL);
    return run('running');
}

/** The event of a schedule time. Its key has the time, so a schedule time runs one time only. */
export function scheduleEvent(automation: Pick<Automation, 'id' | 'binding'>, slot: Date): AutomationEvent {
    const { date, time } = localDateTime(slot);
    const repoPath = automation.binding.repos?.[0];
    return {
        trigger: 'schedule',
        key: `schedule:${automation.id}:${slot.toISOString()}`,
        target: `schedule:${automation.id}`,
        label: `${date} ${time}`,
        at: slot.getTime(),
        time,
        ...(repoPath ? { repoPath, worktreePath: repoPath } : {})
    };
}

/** The runs that are waiting for the approval of the user, the newest first, in the form of the phone API. */
export function pendingRemoteRuns(state: Pick<AutomationRunState, 'runs'>): RemoteAutomationRun[] {
    return state.runs
        .filter(run => run.status === 'pending')
        .map(run => ({
            id: run.id,
            automationName: run.automationName,
            label: run.event.label,
            trigger: run.event.trigger,
            ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
            createdAt: run.createdAt
        }));
}

/** The request of an "HTTP request" action, with the variables and the secrets in it. */
export interface AutomationHttpRequest {
    method: HttpMethod;
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutSeconds?: number;
}

/**
 * Sends the request of an "HTTP request" action with `send`. The secrets go into the request only. The run history
 * shows "•••" for them. The answer becomes the "http.*" variables of the next actions: the function changes `values`.
 * Returns the line for the run history. Throws for an answer that is not 2xx, unless the action allows a failure.
 */
export async function runHttpAction(
    automation: Pick<Automation, 'binding'>,
    action: Extract<AutomationAction, { type: 'http' }>,
    values: Record<string, string | undefined>,
    send: (request: AutomationHttpRequest) => Promise<HttpResponse>
): Promise<string> {
    const full = { ...values, ...secretVariables(automation.binding) };
    const shown = { ...values, ...secretVariables(automation.binding, true) };
    const headers = Object.fromEntries((action.headers ?? []).map(header => [header.name, renderTemplate(header.value, full)]));
    const body = action.body === undefined ? undefined : renderTemplate(action.body, full);
    // A JSON body without a content type gets one. Most web services need it.
    const hasType = Object.keys(headers).some(name => name.toLowerCase() === 'content-type');
    if (body !== undefined && !hasType && /^\s*[[{]/.test(body)) headers['Content-Type'] = 'application/json';
    const response = await send({
        method: action.method,
        url: renderTemplate(action.url, full),
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(action.timeoutSeconds ? { timeoutSeconds: action.timeoutSeconds } : {})
    });
    // The values of an earlier answer must not stay. A JSON field that the new answer does not have becomes empty.
    for (const key of Object.keys(values)) {
        if (key.startsWith('http.')) delete values[key];
    }
    Object.assign(values, httpVariables(response));
    const line = `${action.method} ${renderTemplate(action.url, shown)}: ${response.status} ${response.statusText}`.trim();
    const ok = response.status >= 200 && response.status < 300;
    if (!ok && !action.allowFailure) {
        throw new Error(response.body.trim() ? `${line}\n${response.body.trim().slice(0, 1000)}` : line);
    }
    return response.truncated ? `${line} (the answer was larger than 1 MB, so ShipWarden kept the start only)` : line;
}

/** Thrown by a "Stop" action. The run ends as "done" with this text. */
export class StopRun extends Error {
    readonly detail: string;

    constructor(detail: string) {
        super(detail);
        this.detail = detail;
    }
}
