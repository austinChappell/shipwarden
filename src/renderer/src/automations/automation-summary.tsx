import type { ReactNode } from 'react';
import { MANUAL_ENTITIES, actsOnTasks, needsRepo, type Automation, type AutomationAction, type TriggerType } from '@shared/automations';

/** The event of each trigger, as the end of a sentence that starts with "When". */
export const TRIGGER_EVENTS: Record<TriggerType, string> = {
    'ci.failed': 'the checks of a pull request fail',
    'pr.comment': 'another person comments on a pull request',
    'pr.conflict': 'a pull request has merge conflicts',
    'pr.merged': 'someone merges a pull request',
    'agent.done': 'an agent finishes its turn',
    'task.new': 'a task matches these filters for the first time',
    schedule: 'the time comes on a selected day',
    manual: 'you click the button'
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Returns "A", "A and B" or "A, B, and C". With `or`, returns "A, B, or C". */
export function listText(items: readonly string[], or = false): string {
    return new Intl.ListFormat('en', { style: 'long', type: or ? 'disjunction' : 'conjunction' }).format(items);
}

/** Puts words between the parts of a list, for example ", " and ", and ". The parts can be elements. */
function joinNodes(parts: ReactNode[]): ReactNode[] {
    return parts.flatMap((part, index) => {
        if (index === 0) return [part];
        const separator = index === parts.length - 1 ? (parts.length > 2 ? ', and ' : ' and ') : ', ';
        return [separator, part];
    });
}

function actionPhrase(action: AutomationAction): ReactNode {
    switch (action.type) {
        case 'sendToAgent':
            return 'send a prompt to the agent of the worktree';
        case 'startAgent':
            return 'start an agent in a new worktree';
        case 'runHeadless':
            return action.saveNote ? 'ask an agent and save the answer as a note' : 'ask an agent';
        case 'moveTask':
            return action.status ? (
                <>
                    move the task to <b>{action.status}</b>
                </>
            ) : (
                'move the task'
            );
        case 'removeWorktree':
            return 'remove the worktree';
        case 'notify':
            return 'show a notification';
        case 'http':
            return `send a ${action.method} request`;
        case 'if':
            return 'check a condition';
        case 'stop':
            return 'stop';
    }
}

/** The event part of the sentence, with the filters of the trigger. */
function eventPhrase(automation: Automation, connectionName: string | undefined): ReactNode {
    const trigger = automation.trigger;
    switch (trigger.type) {
        case 'task.new': {
            const collections = (automation.binding.collections ?? []).map(item => item.name ?? item.id);
            return (
                <>
                    a{connectionName ? <b> {connectionName}</b> : ''} task
                    {collections.length > 0 && (
                        <>
                            {' in '}
                            <b>{listText(collections)}</b>
                        </>
                    )}
                    {trigger.labels && (
                        <>
                            {' with the label '}
                            <b>{listText(trigger.labels, true)}</b>
                        </>
                    )}
                    {trigger.assignedToMe && ', assigned to you,'}
                    {trigger.status ? (
                        <>
                            {' reaches '}
                            <b>{trigger.status}</b>
                        </>
                    ) : (
                        ' shows up'
                    )}
                </>
            );
        }
        case 'pr.comment':
            return trigger.reviewsOnly ? 'another person reviews a pull request' : TRIGGER_EVENTS['pr.comment'];
        case 'agent.done':
            return trigger.withoutPullRequest ? 'an agent finishes its turn on a branch without a pull request' : TRIGGER_EVENTS['agent.done'];
        case 'schedule':
            return (
                <>
                    it is <b>{trigger.time}</b> on{' '}
                    {trigger.days.length === 7
                        ? 'any day'
                        : listText(
                              trigger.days.map(day => DAY_NAMES[day]),
                              true
                          )}
                </>
            );
        case 'manual': {
            const entity = MANUAL_ENTITIES.find(item => item.entity === trigger.entity);
            return trigger.entity === 'none' ? 'you click play in the Automations view' : `you click the button on a ${entity?.label.toLowerCase()}`;
        }
        default:
            return TRIGGER_EVENTS[trigger.type];
    }
}

/** One sentence that tells what the automation does. */
export function automationSummary(automation: Automation, connectionName: string | undefined): ReactNode {
    const actions = automation.actions.map(actionPhrase);
    return (
        <>
            When {eventPhrase(automation, connectionName)}
            {automation.conditions?.when ? ', and the conditions agree' : ''}: {actions.length > 0 ? joinNodes(actions) : 'do nothing'}.
        </>
    );
}

/** A warning about the tasks that do not run because no label rule matches and no default repository is set. */
export function labelWarning(automation: Automation): string | undefined {
    if (!actsOnTasks(automation.trigger) || !needsRepo(automation) || automation.binding.repos?.[0]) return undefined;
    const labels = (automation.binding.labelRepos ?? []).map(rule => rule.label.trim()).filter(Boolean);
    if (labels.length === 0) return undefined;
    return `Tasks without the label ${listText(labels, true)} do not run.`;
}
