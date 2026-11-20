import { describe, expect, it } from 'vitest';
import {
    AUTOMATION_TEMPLATES,
    AutomationError,
    automationFromTemplate,
    automationMatches,
    bindingProblems,
    branchMatches,
    describeTrigger,
    dueScheduleSlot,
    eventVariables,
    exportAutomation,
    firedKey,
    importedAutomation,
    normalizeAutomation,
    normalizeAutomationSettings,
    normalizeDefinition,
    parseAutomationImport,
    pruneRunState,
    renderTemplate,
    runsForTarget,
    slugId,
    taskMatchesTrigger,
    taskRepo,
    uniqueId,
    unknownVariables,
    usageAboveLimit,
    usageThresholdEvents,
    ACTION_TRIGGERS,
    planUsageReached,
    prRepo,
    countedTokens,
    formatTokens,
    tokenLimitReached,
    tokensToday,
    type Automation,
    type AutomationEvent,
    type AutomationRun
} from './automations';
import type { Task } from './tasks';
import type { ProviderUsage } from './usage';

function automation(change: Partial<Automation> = {}): Automation {
    return {
        version: 1,
        id: 'fix-ci',
        name: 'Fix CI',
        trigger: { type: 'ci.failed' },
        actions: [{ type: 'sendToAgent', prompt: 'Fix {{pr.url}}' }],
        limits: { approval: 'auto', maxRunsPerTarget: 3, maxRunning: 2 },
        status: 'on',
        binding: {},
        ...change
    };
}

function event(change: Partial<AutomationEvent> = {}): AutomationEvent {
    return {
        trigger: 'ci.failed',
        key: 'ci:/repo#1@abc',
        target: 'pr:/repo#1',
        label: '#1',
        at: Date.UTC(2026, 10, 10, 12),
        repoPath: '/repo',
        worktreePath: '/wt/feature',
        branch: 'feature/login',
        ...change
    };
}

const task: Task = {
    id: 't1',
    key: 'ENG-1',
    title: 'Fix the login',
    status: { id: 's', name: 'To do', category: 'todo' },
    labels: [{ name: 'Agent' }],
    assignees: [{ id: 'u1', name: 'Sam' }]
};

describe('normalizeDefinition', () => {
    it('keeps a valid definition and removes unknown fields', () => {
        const result = normalizeDefinition({ ...automation(), extra: 1, trigger: { type: 'ci.failed', other: true } });
        expect(result).toEqual({
            version: 1,
            id: 'fix-ci',
            name: 'Fix CI',
            trigger: { type: 'ci.failed' },
            actions: [{ type: 'sendToAgent', prompt: 'Fix {{pr.url}}' }],
            limits: { approval: 'auto', maxRunsPerTarget: 3, maxRunning: 2 }
        });
    });

    it('rejects a missing name, an unknown trigger and an empty action list', () => {
        expect(() => normalizeDefinition({ ...automation(), name: ' ' })).toThrow(/needs a name/);
        expect(() => normalizeDefinition({ ...automation(), trigger: { type: 'push' } })).toThrow(/"push" is not known/);
        expect(() => normalizeDefinition({ ...automation(), actions: [] })).toThrow(/one or more actions/);
    });

    it('keeps an overlap trigger with an agent action, and rejects an action that needs a pull request or a task', () => {
        const base = { name: 'Overlap', trigger: { type: 'worktree.overlap' }, limits: { approval: 'ask' } };
        expect(normalizeDefinition({ ...base, actions: [{ type: 'sendToAgent', prompt: '{{overlap.files}}' }] }).trigger).toEqual({ type: 'worktree.overlap' });
        expect(() => normalizeDefinition({ ...base, actions: [{ type: 'removeWorktree' }] })).toThrow(AutomationError);
        expect(() => normalizeDefinition({ ...base, actions: [{ type: 'startAgent', prompt: 'x' }] })).toThrow(AutomationError);
    });

    it('rejects an action that cannot follow the trigger', () => {
        expect(() => normalizeDefinition({ ...automation(), actions: [{ type: 'removeWorktree' }] })).toThrow(AutomationError);
        expect(() => normalizeDefinition({ ...automation(), actions: [{ type: 'removeWorktree' }] })).toThrow(/cannot follow the trigger "CI failed"/);
    });

    it('reads the "Add to the queue" action for a task trigger only', () => {
        const base = { ...automation(), trigger: { type: 'task.new' } };
        expect(normalizeDefinition({ ...base, actions: [{ type: 'queueTask', agentId: 'codex', extra: 1 }] }).actions).toEqual([
            { type: 'queueTask', agentId: 'codex' }
        ]);
        expect(normalizeDefinition({ ...base, actions: [{ type: 'queueTask' }] }).actions).toEqual([{ type: 'queueTask' }]);
        const manual = { ...automation(), trigger: { type: 'manual', entity: 'task' } };
        expect(normalizeDefinition({ ...manual, actions: [{ type: 'queueTask' }] }).actions).toEqual([{ type: 'queueTask' }]);
        expect(() => normalizeDefinition({ ...automation(), actions: [{ type: 'queueTask' }] })).toThrow(/cannot follow the trigger "CI failed"/);
        expect(() =>
            normalizeDefinition({ ...automation(), trigger: { type: 'schedule', days: [1], time: '09:00' }, actions: [{ type: 'queueTask' }] })
        ).toThrow(AutomationError);
    });

    it('asks for a repository for an "Add to the queue" action', () => {
        const rule = automation({ trigger: { type: 'manual', entity: 'task' }, actions: [{ type: 'queueTask' }] });
        expect(bindingProblems(rule, [])).toEqual(['Select a repository.']);
        expect(bindingProblems({ ...rule, binding: { repos: ['/repo'] } }, ['/repo'])).toEqual([]);
    });

    it('rejects a newer format version and a bad schedule', () => {
        expect(() => normalizeDefinition({ ...automation(), version: 2 })).toThrow(/Update ShipWarden/);
        expect(() =>
            normalizeDefinition({ ...automation(), trigger: { type: 'schedule', days: [1], time: '25:00' }, actions: [{ type: 'notify', title: 'x' }] })
        ).toThrow(/HH:MM/);
        expect(() =>
            normalizeDefinition({ ...automation(), trigger: { type: 'schedule', days: [], time: '08:00' }, actions: [{ type: 'notify', title: 'x' }] })
        ).toThrow(/one or more days/);
    });

    it('gives limits that are not valid their default values', () => {
        expect(normalizeDefinition({ ...automation(), limits: { approval: 'never', maxRunsPerTarget: 0, maxRunning: 2.5 } }).limits).toEqual({
            approval: 'auto',
            maxRunsPerTarget: 3,
            maxRunning: 2
        });
    });

    it('makes an ID from the name when the ID is not valid', () => {
        expect(normalizeDefinition({ ...automation(), id: '../x', name: 'Fix CI now!' }).id).toBe('fix-ci-now');
    });
});

describe('normalizeAutomation', () => {
    it('gives an unknown status "off" and keeps only absolute repository paths', () => {
        const result = normalizeAutomation({ ...automation(), status: 'maybe', binding: { repos: ['/a', 'b', '/a'], connectionId: 'c' } });
        expect(result.status).toBe('off');
        expect(result.binding).toEqual({ repos: ['/a'], connectionId: 'c' });
    });
});

describe('export and import', () => {
    it('exports only the portable part', () => {
        const text = exportAutomation(automation({ binding: { repos: ['/Users/me/repo'] }, status: 'on' }));
        expect(text).not.toContain('/Users/me');
        expect(text).not.toContain('"status"');
        expect(JSON.parse(text)).toMatchObject({ kind: 'shipwarden.automation', id: 'fix-ci', name: 'Fix CI' });
    });

    it('imports an export, starts it "off" and gives it a free ID', () => {
        const definition = parseAutomationImport(exportAutomation(automation()));
        expect(definition.name).toBe('Fix CI');
        const imported = importedAutomation(definition, ['fix-ci']);
        expect(imported.id).toBe('fix-ci-2');
        expect(imported.status).toBe('off');
        expect(imported.binding).toEqual({});
    });

    it('ignores the binding and the status of an import', () => {
        const definition = parseAutomationImport(JSON.stringify({ ...automation(), status: 'on', binding: { repos: ['/x'] } }));
        expect(definition).not.toHaveProperty('binding');
        expect(definition).not.toHaveProperty('status');
    });

    it('rejects text that is not JSON or not an automation', () => {
        expect(() => parseAutomationImport('{')).toThrow(/not valid JSON/);
        expect(() => parseAutomationImport('[]')).toThrow(/one object/);
        expect(() => parseAutomationImport(JSON.stringify({ ...automation(), kind: 'other' }))).toThrow(/not a ShipWarden automation/);
    });
});

describe('templates', () => {
    it('are all valid', () => {
        for (const template of AUTOMATION_TEMPLATES) {
            expect(() => normalizeDefinition({ ...template.definition, id: template.id, version: 1 })).not.toThrow();
        }
    });

    it('make a dry run with an ID that is not in use', () => {
        const made = automationFromTemplate(AUTOMATION_TEMPLATES[0], ['fix-failed-ci']);
        expect(made.id).toBe('fix-failed-ci-2');
        expect(made.status).toBe('dry-run');
    });
});

describe('usage.threshold', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const usage = (percent: number, resetsAt = '2026-11-20T14:30:00.000Z'): ProviderUsage[] => [
        {
            provider: 'claude',
            status: 'ok',
            windows: [
                { kind: 'session', label: '5h', usedPercent: percent, resetsAt },
                { kind: 'weekly', label: 'Weekly', usedPercent: 20, resetsAt: '2026-11-23T09:00:00.000Z' }
            ]
        }
    ];
    /** A copy of the run store: it keeps the keys that fired. */
    const store = () => {
        const fired = new Set<string>();
        return {
            fired,
            poll: (list: ProviderUsage[], at = now, threshold = 80) => {
                const events = usageThresholdEvents(list, threshold, at, key => fired.has(key));
                for (const item of events) fired.add(item.key);
                return events;
            }
        };
    };

    it('keeps a valid percent', () => {
        const watcher = automation({ trigger: { type: 'usage.threshold', percent: 82.4 }, actions: [{ type: 'notify', title: 'Usage' }] });
        expect(normalizeAutomation(watcher).trigger).toEqual({ type: 'usage.threshold', percent: 82 });
        expect(normalizeAutomation({ ...watcher, trigger: { type: 'usage.threshold', percent: 500 } }).trigger).toEqual({
            type: 'usage.threshold',
            percent: 100
        });
        expect(describeTrigger({ type: 'usage.threshold', percent: 80 })).toBe('Plan usage at 80%');
    });

    it('allows the actions that tell the user, and not the actions that start agents', () => {
        expect(ACTION_TRIGGERS.notify).toContain('usage.threshold');
        expect(ACTION_TRIGGERS.postMessage).toContain('usage.threshold');
        expect(ACTION_TRIGGERS.http).toContain('usage.threshold');
        expect(ACTION_TRIGGERS.startAgent).not.toContain('usage.threshold');
    });

    it('fires one time for each crossing, not at each poll', () => {
        const runs = store();
        expect(runs.poll(usage(70))).toEqual([]);
        const first = runs.poll(usage(81));
        expect(first.map(item => item.label)).toEqual(['Claude (5h) at 81%']);
        expect(runs.poll(usage(81))).toEqual([]);
        expect(runs.poll(usage(95))).toEqual([]);
        // The reset time moves by a few seconds into the next hour. It is the same period.
        expect(runs.poll(usage(96, '2026-11-20T15:00:02.000Z'))).toEqual([]);
    });

    it('fires again after the window resets', () => {
        const runs = store();
        expect(runs.poll(usage(85))).toHaveLength(1);
        expect(runs.poll(usage(10, '2026-11-20T19:30:00.000Z'), Date.parse('2026-11-20T15:00:00Z'))).toEqual([]);
        expect(runs.poll(usage(80, '2026-11-20T19:30:00.000Z'), Date.parse('2026-11-20T18:00:00Z'))).toHaveLength(1);
    });

    it('fires for each automation percent on its own', () => {
        const runs = store();
        expect(runs.poll(usage(95), now, 80)).toHaveLength(1);
        expect(runs.poll(usage(95), now, 90)).toHaveLength(1);
    });

    it('does not fire without usage data', () => {
        expect(usageThresholdEvents([], 80, now, () => false)).toEqual([]);
        expect(usageThresholdEvents([{ ...usage(99)[0], status: 'error' }], 80, now, () => false)).toEqual([]);
    });

    it('gives the usage variables and a summary line', () => {
        const [first] = usageThresholdEvents(usage(82), 80, now, () => false);
        const values = eventVariables(first);
        expect(values['usage.provider']).toBe('Claude');
        expect(values['usage.window']).toBe('5h');
        expect(values['usage.percent']).toBe('82');
        expect(values['usage.threshold']).toBe('80');
        expect(values['usage.resetsIn']).toBe('2h 30m');
        expect(values['usage.summary']).toBe('The Claude plan usage (5h) is at 82%. It resets in 2h 30m.');
        expect(unknownVariables('{{usage.summary}} {{usage.resetsAt}}', { type: 'usage.threshold', percent: 80 })).toEqual([]);
    });
});

describe('agent.needsInput', () => {
    const waiter = (change: Partial<Automation>) => automation({ actions: [{ type: 'notify', title: 'Waiting' }], ...change });

    it('keeps a valid wait time and drops 0', () => {
        expect(normalizeAutomation(waiter({ trigger: { type: 'agent.needsInput', idleFor: 10 } })).trigger).toEqual({ type: 'agent.needsInput', idleFor: 10 });
        expect(normalizeAutomation(waiter({ trigger: { type: 'agent.needsInput', idleFor: 0 } })).trigger).toEqual({ type: 'agent.needsInput' });
        expect(normalizeAutomation(waiter({ trigger: { type: 'agent.needsInput' } })).trigger).toEqual({ type: 'agent.needsInput' });
    });

    it('refuses a wait time out of range', () => {
        expect(() => normalizeAutomation(waiter({ trigger: { type: 'agent.needsInput', idleFor: -1 } }))).toThrow(/wait time/);
        expect(() => normalizeAutomation(waiter({ trigger: { type: 'agent.needsInput', idleFor: 2000 } }))).toThrow(/wait time/);
    });

    it('describes the trigger with its wait time', () => {
        expect(describeTrigger({ type: 'agent.needsInput' })).toBe('Agent needs input');
        expect(describeTrigger({ type: 'agent.needsInput', idleFor: 10 })).toBe('Agent needs input for 10 minutes');
    });

    it('gives the wait variables and a summary line', () => {
        const values = eventVariables(
            event({ trigger: 'agent.needsInput', branch: 'fix-login', agentWaitFor: 'permission', agentWaitMinutes: 10, agentMessage: 'Bash: npm test' })
        );
        expect(values['agent.waitFor']).toBe('permission');
        expect(values['agent.waitMinutes']).toBe('10');
        expect(values['agent.message']).toBe('Bash: npm test');
        expect(values['agent.summary']).toBe('The agent on fix-login is waiting for a permission (10 minutes): Bash: npm test');
        expect(eventVariables(event({ trigger: 'agent.needsInput', branch: 'x', agentWaitFor: 'question', agentWaitMinutes: 0 }))['agent.summary']).toBe(
            'The agent on x is asking a question.'
        );
        expect(eventVariables(event())['agent.summary']).toBeUndefined();
    });

    it('has a Slack template that uses no unknown variables', () => {
        const template = AUTOMATION_TEMPLATES.find(item => item.id === 'slack-needs-input');
        expect(template?.definition.trigger).toEqual({ type: 'agent.needsInput', idleFor: 10 });
        const action = template?.definition.actions[0];
        expect(action?.type).toBe('http');
        if (action?.type !== 'http') return;
        const trigger = template!.definition.trigger;
        expect(unknownVariables(action.body ?? '', trigger)).toEqual([]);
        expect(unknownVariables(action.url, trigger, { secrets: ['SLACK_WEBHOOK_URL'] })).toEqual([]);
    });
});

describe('IDs', () => {
    it('makes a slug from a name', () => {
        expect(slugId('  Résumé: Fix CI!! ')).toBe('resume-fix-ci');
        expect(slugId('!!!')).toBe('automation');
        expect(uniqueId('Fix CI', ['fix-ci', 'fix-ci-2'])).toBe('fix-ci-3');
    });
});

describe('automationMatches', () => {
    it('needs the same trigger and a status that is not "off"', () => {
        expect(automationMatches(automation(), event())).toBe(true);
        expect(automationMatches(automation({ status: 'dry-run' }), event())).toBe(true);
        expect(automationMatches(automation({ status: 'off' }), event())).toBe(false);
        expect(automationMatches(automation(), event({ trigger: 'pr.conflict' }))).toBe(false);
    });

    it('applies the repositories of the binding and the branch pattern', () => {
        expect(automationMatches(automation({ binding: { repos: ['/other'] } }), event())).toBe(false);
        expect(automationMatches(automation({ binding: { repos: ['/repo'] } }), event())).toBe(true);
        expect(automationMatches(automation({ conditions: { branchPattern: 'feature/*' } }), event())).toBe(true);
        expect(automationMatches(automation({ conditions: { branchPattern: 'fix/*' } }), event())).toBe(false);
    });

    it('applies the comment filters', () => {
        const comment = { id: 'c', author: 'Dependabot', body: 'x', url: 'u' };
        const rule = automation({ trigger: { type: 'pr.comment', ignoreAuthors: ['dependabot'], reviewsOnly: true } });
        expect(automationMatches(rule, event({ trigger: 'pr.comment', comment }))).toBe(false);
        expect(automationMatches(rule, event({ trigger: 'pr.comment', comment: { ...comment, author: 'sam' } }))).toBe(false);
        expect(automationMatches(rule, event({ trigger: 'pr.comment', comment: { ...comment, author: 'sam', reviewState: 'CHANGES_REQUESTED' } }))).toBe(true);
    });

    it('skips a finished agent with a pull request when the trigger asks for one without', () => {
        const rule = automation({ trigger: { type: 'agent.done', withoutPullRequest: true } });
        expect(automationMatches(rule, event({ trigger: 'agent.done', hasPullRequest: true }))).toBe(false);
        expect(automationMatches(rule, event({ trigger: 'agent.done', hasPullRequest: false }))).toBe(true);
    });

    it('matches an agent that needs input only for the automations with the same wait time', () => {
        const atOnce = automation({ trigger: { type: 'agent.needsInput' } });
        const tenMinutes = automation({ trigger: { type: 'agent.needsInput', idleFor: 10 } });
        expect(automationMatches(atOnce, event({ trigger: 'agent.needsInput', agentWaitMinutes: 0 }))).toBe(true);
        expect(automationMatches(tenMinutes, event({ trigger: 'agent.needsInput', agentWaitMinutes: 0 }))).toBe(false);
        expect(automationMatches(tenMinutes, event({ trigger: 'agent.needsInput', agentWaitMinutes: 10 }))).toBe(true);
        expect(automationMatches(atOnce, event({ trigger: 'agent.needsInput', agentWaitMinutes: 10 }))).toBe(false);
        expect(automationMatches(tenMinutes, event({ trigger: 'agent.done' }))).toBe(false);
        // "Run now" has no wait time.
        expect(automationMatches(tenMinutes, event({ trigger: 'agent.needsInput', manual: true }))).toBe(true);
    });

    it('applies the binding and the branch pattern to an agent that needs input', () => {
        const rule = automation({ trigger: { type: 'agent.needsInput' }, binding: { repos: ['/repo'] }, conditions: { branchPattern: 'feature/*' } });
        expect(automationMatches(rule, event({ trigger: 'agent.needsInput' }))).toBe(true);
        expect(automationMatches(rule, event({ trigger: 'agent.needsInput', repoPath: '/other' }))).toBe(false);
        expect(automationMatches(rule, event({ trigger: 'agent.needsInput', branch: 'fix/x' }))).toBe(false);
    });

    it('applies the binding and the branch pattern to an overlap of worktrees', () => {
        const rule = automation({ trigger: { type: 'worktree.overlap' }, binding: { repos: ['/repo'] }, conditions: { branchPattern: 'feature/*' } });
        expect(automationMatches(rule, event({ trigger: 'worktree.overlap' }))).toBe(true);
        expect(automationMatches(rule, event({ trigger: 'worktree.overlap', repoPath: '/other' }))).toBe(false);
        expect(automationMatches(rule, event({ trigger: 'worktree.overlap', branch: 'fix/x' }))).toBe(false);
    });

    it('needs the task connection of the binding', () => {
        const rule = automation({ trigger: { type: 'task.new' }, actions: [{ type: 'notify', title: 'x' }], binding: { connectionId: 'c1' } });
        expect(automationMatches(rule, event({ trigger: 'task.new', connectionId: 'c1' }))).toBe(true);
        expect(automationMatches(rule, event({ trigger: 'task.new', connectionId: 'c2' }))).toBe(false);
    });
});

describe('taskMatchesTrigger', () => {
    it('matches labels without case, the assignee and the status', () => {
        expect(taskMatchesTrigger({ type: 'task.new', labels: ['agent'] }, task, undefined)).toBe(true);
        expect(taskMatchesTrigger({ type: 'task.new', labels: ['bug'] }, task, undefined)).toBe(false);
        expect(taskMatchesTrigger({ type: 'task.new', assignedToMe: true }, task, 'u1')).toBe(true);
        expect(taskMatchesTrigger({ type: 'task.new', assignedToMe: true }, task, 'u2')).toBe(false);
        expect(taskMatchesTrigger({ type: 'task.new', assignedToMe: true }, task, undefined)).toBe(false);
        expect(taskMatchesTrigger({ type: 'task.new', status: 'to do' }, task, undefined)).toBe(true);
        expect(taskMatchesTrigger({ type: 'task.new', status: 'done' }, task, undefined)).toBe(false);
    });

    it('never matches a done or canceled task', () => {
        expect(taskMatchesTrigger({ type: 'task.new', labels: ['agent'] }, { ...task, status: { id: 'd', name: 'Done', category: 'done' } }, undefined)).toBe(
            false
        );
        expect(taskMatchesTrigger({ type: 'task.new' }, { ...task, status: { id: 'c', name: 'Canceled', category: 'canceled' } }, undefined)).toBe(false);
    });
});

describe('templates of prompts', () => {
    it('replaces the variables and empties unknown ones', () => {
        expect(renderTemplate('PR {{ pr.number }} on {{branch}}{{nothing}}', { 'pr.number': '12', branch: 'b' })).toBe('PR 12 on b');
    });

    it('finds variables that the trigger does not give', () => {
        expect(unknownVariables('{{pr.url}} {{task.title}} {{task.title}}', { type: 'ci.failed' })).toEqual(['task.title']);
    });

    it('gives the values of an overlap of worktrees', () => {
        const values = eventVariables(event({ trigger: 'worktree.overlap', overlap: { files: ['a.ts', 'b.ts'], worktrees: ['fix', 'docs'] } }));
        expect(values).toMatchObject({ 'overlap.files': 'a.ts\nb.ts', 'overlap.worktrees': 'fix, docs', branch: 'feature/login' });
        expect(unknownVariables('{{overlap.files}} {{overlap.worktrees}} {{branch}} {{pr.url}}', { type: 'worktree.overlap' })).toEqual(['pr.url']);
    });

    it('gives the values of an event', () => {
        const values = eventVariables(event({ pr: { number: 3, url: 'u', title: 't' } }), { checks: '- a' });
        expect(values).toMatchObject({ repo: 'repo', branch: 'feature/login', 'pr.number': '3', checks: '- a' });
    });
});

describe('branchMatches', () => {
    it('treats "*" as any text and ignores case', () => {
        expect(branchMatches('ENG-*', 'eng-12-fix')).toBe(true);
        expect(branchMatches('a.b', 'axb')).toBe(false);
        expect(branchMatches('', undefined)).toBe(true);
        expect(branchMatches('x', undefined)).toBe(false);
    });
});

describe('dueScheduleSlot', () => {
    const trigger = { type: 'schedule' as const, days: [1, 2, 3, 4, 5], time: '08:00' };
    // Tuesday, 10 November 2026.
    const tuesday = (hours: number, minutes = 0) => new Date(2026, 10, 10, hours, minutes);

    it('is due after the time on a selected day, one time', () => {
        const slot = dueScheduleSlot(trigger, tuesday(8, 5), undefined, tuesday(7).getTime());
        expect(slot?.getTime()).toBe(tuesday(8).getTime());
        expect(dueScheduleSlot(trigger, tuesday(9), tuesday(8).getTime(), tuesday(7).getTime())).toBeUndefined();
    });

    it('does not run a time that passed before the app started', () => {
        expect(dueScheduleSlot(trigger, tuesday(9), undefined, tuesday(8, 30).getTime())).toBeUndefined();
    });

    it('is not due on a day that is not selected', () => {
        const sunday = new Date(2026, 10, 15, 9);
        expect(dueScheduleSlot({ ...trigger, days: [0] }, sunday, undefined, new Date(2026, 10, 15, 7).getTime())?.getDay()).toBe(0);
        expect(dueScheduleSlot(trigger, sunday, undefined, new Date(2026, 10, 15, 7).getTime())).toBeUndefined();
    });
});

describe('runs', () => {
    const run = (id: string, status: AutomationRun['status'], createdAt: number, target = 'pr:/repo#1'): AutomationRun => ({
        id,
        automationId: 'fix-ci',
        automationName: 'Fix CI',
        status,
        event: event({ target }),
        createdAt,
        updatedAt: createdAt
    });

    it('counts the runs of a target, without skipped runs and dry runs', () => {
        const runs = [run('1', 'done', 1), run('2', 'failed', 2), run('3', 'skipped', 3), run('4', 'dry-run', 4), run('5', 'done', 5, 'pr:/repo#2')];
        expect(runsForTarget(runs, 'fix-ci', 'pr:/repo#1')).toBe(2);
    });

    it('keeps open runs and removes old fired keys', () => {
        const now = 100 * 24 * 3600_000;
        const state = pruneRunState(
            { runs: [run('1', 'pending', 1), run('2', 'done', 2)], fired: { old: 1, new: now - 1000 }, scheduleRuns: {}, seeded: [] },
            now
        );
        expect(state.fired).toEqual({ new: now - 1000 });
        const tasks = pruneRunState({ runs: [], fired: { 'a|task:c:1': 1, 'a|ci:x': 1 }, scheduleRuns: {}, seeded: [] }, now);
        expect(tasks.fired).toEqual({ 'a|task:c:1': 1 });
        expect(state.runs.map(item => item.id)).toEqual(['2', '1']);
    });

    it('makes one fired key for each automation and event', () => {
        expect(firedKey('a', { key: 'k' })).toBe('a|k');
    });
});

describe('task bindings', () => {
    const taskRule = (binding: Automation['binding']) =>
        automation({ trigger: { type: 'task.new' }, actions: [{ type: 'startAgent', prompt: 'x' }], binding: { connectionId: 'c', ...binding } });

    it('reads the single collection of an older file as a list', () => {
        const result = normalizeAutomation({ ...taskRule({}), binding: { connectionId: 'c', collectionId: 'l1', collectionName: 'Sprint' } });
        expect(result.binding).toEqual({ connectionId: 'c', collections: [{ id: 'l1', name: 'Sprint' }] });
    });

    it('keeps valid label rules once for each label, and only for a task trigger', () => {
        const labelRepos = [
            { label: ' api ', repo: '/api' },
            { label: 'API', repo: '/other' },
            { label: 'web', repo: 'relative' },
            { label: '', repo: '/x' }
        ];
        expect(normalizeAutomation(taskRule({ labelRepos })).binding.labelRepos).toEqual([{ label: 'api', repo: '/api' }]);
        expect(normalizeAutomation(automation({ binding: { labelRepos } })).binding.labelRepos).toBeUndefined();
    });

    it('selects the repository of the first matching label, or else the default repository', () => {
        const binding = {
            repos: ['/main'],
            labelRepos: [
                { label: 'web', repo: '/web' },
                { label: 'agent', repo: '/api' }
            ]
        };
        expect(taskRepo(binding, task)).toBe('/api');
        expect(taskRepo(binding, { labels: [{ name: 'docs' }] })).toBe('/main');
        expect(taskRepo({ labelRepos: binding.labelRepos }, { labels: [] })).toBeUndefined();
    });

    it('accepts label rules in place of a default repository', () => {
        const rule = taskRule({ collections: [{ id: 'l1' }], labelRepos: [{ label: 'api', repo: '/repo' }] });
        expect(bindingProblems(rule, ['/repo'])).toEqual([]);
        expect(bindingProblems(rule, [])).toEqual(['No project has the repository /repo.']);
        expect(bindingProblems({ ...rule, binding: { connectionId: 'c', collections: [{ id: 'l1' }] } }, ['/repo'])).toEqual(['Select a repository.']);
    });
});

describe('bindingProblems', () => {
    it('reports missing repositories and a missing task collection', () => {
        const rule = automation({
            trigger: { type: 'task.new' },
            actions: [{ type: 'startAgent', prompt: 'x' }],
            binding: { repos: ['/gone'] }
        });
        expect(bindingProblems(rule, ['/repo'])).toEqual(['No project has the repository /gone.', 'Select a task manager and a collection.']);
        expect(bindingProblems({ ...rule, binding: {} }, ['/repo'])).toContain('Select a repository.');
    });
});

describe('usageAboveLimit', () => {
    const usage = [{ provider: 'claude' as const, status: 'ok' as const, windows: [{ kind: 'session' as const, label: '5h', usedPercent: 93.2 }] }];

    it('reports the first window at or above the limit', () => {
        expect(usageAboveLimit(usage, 90)).toBe('The plan usage of Claude (5h) is 93%. Automations pause at 90%.');
        expect(usageAboveLimit(usage, 95)).toBeUndefined();
        expect(usageAboveLimit([{ ...usage[0], status: 'error' }], 5)).toBeUndefined();
        expect(usageAboveLimit(usage, null)).toBeUndefined();
    });

    it('uses the lower limit of the automation and of all automations', () => {
        const limits = { approval: 'auto' as const, maxRunsPerTarget: 3, maxRunning: 2 };
        expect(planUsageReached(usage, { limits: { ...limits, pauseAtUsage: 80 } }, 95)).toBe(
            'The plan usage of Claude (5h) is 93%. This automation pauses at 80%.'
        );
        expect(planUsageReached(usage, { limits: { ...limits, pauseAtUsage: 80 } }, null)).toMatch(/This automation pauses at 80%/);
        expect(planUsageReached(usage, { limits: { ...limits, pauseAtUsage: 95 } }, 90)).toMatch(/Automations pause at 90%/);
        expect(planUsageReached(usage, { limits }, 90)).toMatch(/Automations pause at 90%/);
        expect(planUsageReached(usage, { limits: { ...limits, pauseAtUsage: 95 } }, null)).toBeUndefined();
    });

    it('keeps a valid usage limit of an automation', () => {
        expect(normalizeDefinition({ ...automation(), limits: { pauseAtUsage: 72.4 } }).limits.pauseAtUsage).toBe(72);
        expect(normalizeDefinition({ ...automation(), limits: { pauseAtUsage: 500 } }).limits.pauseAtUsage).toBe(100);
        expect(normalizeDefinition({ ...automation(), limits: { pauseAtUsage: 'x' } }).limits).not.toHaveProperty('pauseAtUsage');
    });
});

describe('tokens', () => {
    const now = new Date(2026, 10, 10, 15).getTime();
    const yesterday = new Date(2026, 10, 9, 23).getTime();
    const runs = [
        { automationId: 'a', createdAt: now - 1000, tokens: 400 },
        { automationId: 'b', createdAt: now - 2000, tokens: 700 },
        { automationId: 'a', createdAt: yesterday, tokens: 9000 },
        { automationId: 'a', createdAt: now }
    ];

    it('counts the tokens of the runs of today', () => {
        expect(tokensToday(runs, now)).toBe(1100);
        expect(tokensToday(runs, now, 'a')).toBe(400);
    });

    it('stops at the limit of the automation or of all automations', () => {
        const limits = { approval: 'auto' as const, maxRunsPerTarget: 3, maxRunning: 2 };
        expect(tokenLimitReached(runs, { id: 'a', limits: { ...limits, dailyTokens: 400 } }, null, now)).toMatch(/used 400 tokens today/);
        expect(tokenLimitReached(runs, { id: 'a', limits: { ...limits, dailyTokens: 1000 } }, null, now)).toBeUndefined();
        expect(tokenLimitReached(runs, { id: 'a', limits }, 1100, now)).toMatch(/All automations used 1.1k tokens/);
        expect(tokenLimitReached(runs, { id: 'a', limits }, null, now)).toBeUndefined();
    });

    it('keeps a valid limit of an automation', () => {
        expect(normalizeDefinition({ ...automation(), limits: { dailyTokens: 250_000.4 } }).limits.dailyTokens).toBe(250_000);
        expect(normalizeDefinition({ ...automation(), limits: { dailyTokens: 'x' } }).limits).not.toHaveProperty('dailyTokens');
    });

    it('counts input, cache writes and output, not cache reads', () => {
        expect(countedTokens({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 3 })).toBe(6);
        expect(countedTokens(undefined)).toBe(0);
    });

    it('formats numbers of tokens', () => {
        expect(formatTokens(950)).toBe('950');
        expect(formatTokens(1500)).toBe('1.5k');
        expect(formatTokens(12_340)).toBe('12k');
        expect(formatTokens(2_000_000)).toBe('2M');
        expect(formatTokens(2_340_000)).toBe('2.3M');
    });
});

describe('settings and descriptions', () => {
    it('normalizes the automation settings', () => {
        expect(normalizeAutomationSettings(undefined)).toEqual({ paused: false, pauseAtUsage: 90, dailyTokens: null });
        expect(normalizeAutomationSettings({ paused: true, pauseAtUsage: 72.4, dailyTokens: 12 })).toEqual({
            paused: true,
            pauseAtUsage: 72,
            dailyTokens: 1000
        });
        expect(normalizeAutomationSettings({ pauseAtUsage: 500 }).pauseAtUsage).toBe(100);
        expect(normalizeAutomationSettings({ pauseAtUsage: 1 }).pauseAtUsage).toBe(5);
        expect(normalizeAutomationSettings({ pauseAtUsage: null }).pauseAtUsage).toBeNull();
        expect(normalizeAutomationSettings({ pauseAtUsage: 'x' }).pauseAtUsage).toBe(90);
    });

    it('describes triggers', () => {
        expect(describeTrigger({ type: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00' })).toBe('weekdays at 08:00');
        expect(describeTrigger({ type: 'schedule', days: [0, 6], time: '09:30' })).toBe('Sun, Sat at 09:30');
        expect(describeTrigger({ type: 'task.new', labels: ['agent'], assignedToMe: true })).toBe('Task matches: label agent, assigned to me');
    });
});

describe('post to a chat channel', () => {
    const post = { type: 'postMessage', connectionId: 'clickup-1', channel: { id: '9:abc', name: 'releases' }, message: 'Merged {{pr.url}}' };

    it('needs a channel and a message', () => {
        expect(() => normalizeDefinition({ ...automation(), actions: [{ ...post, channel: {} }] })).toThrow('needs a channel');
        expect(() => normalizeDefinition({ ...automation(), actions: [{ ...post, message: ' ' }] })).toThrow('needs a message');
        expect(normalizeDefinition({ ...automation(), actions: [post] }).actions).toEqual([post]);
    });

    it('removes the connection from an export, also in an "If" action', () => {
        // biome-ignore lint/suspicious/noThenProperty: "then" is a list of actions, not a function.
        const actions = [post, { type: 'if', condition: { var: 'pr.repo', op: 'equals', value: 'acme/api' }, then: [post], else: [post] }];
        const text = exportAutomation({ ...automation(), actions } as Automation);
        expect(text).not.toContain('clickup-1');
        expect(JSON.parse(text).actions[0]).toEqual({ type: 'postMessage', channel: post.channel, message: post.message });
    });

    it('gives "pr.repo" from the address of the pull request', () => {
        expect(prRepo('https://github.com/acme/api/pull/12')).toBe('acme/api');
        expect(prRepo('https://dev.azure.com/org/My%20Project/_git/web/pullrequest/7')).toBe('org/My Project/web');
        expect(prRepo('https://example.com/nothing')).toBeUndefined();
        const values = eventVariables({
            trigger: 'pr.merged',
            key: 'k',
            target: 't',
            label: 'l',
            at: 0,
            pr: { number: 12, url: 'https://github.com/acme/api/pull/12' }
        });
        expect(values['pr.repo']).toBe('acme/api');
    });

    it('knows "pr.repo" for pull request triggers', () => {
        expect(unknownVariables('{{pr.repo}}', { type: 'pr.merged' })).toEqual([]);
        expect(unknownVariables('{{pr.repo}}', { type: 'manual', entity: 'pullRequest' })).toEqual([]);
    });
});
