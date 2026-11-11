import { describe, expect, it } from 'vitest';
import {
    conditionHolds,
    describeCondition,
    httpVariables,
    normalizeCondition,
    renderTemplate,
    templateVariables,
    unknownFilters
} from './automation-templates';
import {
    AutomationError,
    bindingProblems,
    buttonLabel,
    conditionsAgree,
    eventVariables,
    exportAutomation,
    flattenActions,
    manualAutomationsFor,
    manualTarget,
    needsRepo,
    normalizeAutomation,
    normalizeDefinition,
    secretVariables,
    unknownVariables,
    usedSecrets,
    usesVariable,
    type Automation
} from './automations';

describe('renderTemplate filters', () => {
    it('gives a JSON string with the json filter', () => {
        expect(renderTemplate('{"text": {{body|json}}}', { body: 'He said "hi"\nbye' })).toBe('{"text": "He said \\"hi\\"\\nbye"}');
        expect(renderTemplate('{{missing|json}}', {})).toBe('""');
    });

    it('encodes a value with the url filter', () => {
        expect(renderTemplate('/b/{{ branch | url }}', { branch: 'eng/12 a' })).toBe('/b/eng%2F12%20a');
    });

    it('lists the variables and the unknown filters', () => {
        expect(templateVariables('{{a}} {{b|json}} {{a}} {{http.json.x-y}}')).toEqual(['a', 'b', 'http.json.x-y']);
        expect(unknownFilters('{{a|json}} {{b|upper}}')).toEqual(['upper']);
    });
});

describe('conditions', () => {
    const values = { branch: 'eng-12-fix', 'pr.number': '42', 'pr.draft': 'false', empty: '', other: 'ENG-12-FIX' };

    it('compares text without case', () => {
        expect(conditionHolds({ var: 'branch', op: 'equals', value: 'ENG-12-FIX' }, values)).toBe(true);
        expect(conditionHolds({ var: 'branch', op: 'contains', value: '12' }, values)).toBe(true);
        expect(conditionHolds({ var: 'branch', op: 'notContains', value: '12' }, values)).toBe(false);
        expect(conditionHolds({ var: 'branch', op: 'matches', value: 'eng-*' }, values)).toBe(true);
        expect(conditionHolds({ var: 'branch', op: 'notMatches', value: 'release/*' }, values)).toBe(true);
    });

    it('compares a variable with another variable', () => {
        expect(conditionHolds({ var: 'branch', op: 'equals', value: '{{other}}' }, values)).toBe(true);
    });

    it('checks empty values and numbers', () => {
        expect(conditionHolds({ var: 'empty', op: 'isEmpty' }, values)).toBe(true);
        expect(conditionHolds({ var: 'missing', op: 'isSet' }, values)).toBe(false);
        expect(conditionHolds({ var: 'pr.number', op: 'greaterThan', value: '9' }, values)).toBe(true);
        expect(conditionHolds({ var: 'pr.number', op: 'lessThan', value: '9' }, values)).toBe(false);
        // A value that is not a number never agrees.
        expect(conditionHolds({ var: 'branch', op: 'greaterThan', value: '1' }, values)).toBe(false);
    });

    it('combines groups', () => {
        const draft = { var: 'pr.draft', op: 'equals' as const, value: 'true' };
        const eng = { var: 'branch', op: 'matches' as const, value: 'eng-*' };
        expect(conditionHolds({ all: [draft, eng] }, values)).toBe(false);
        expect(conditionHolds({ any: [draft, eng] }, values)).toBe(true);
        expect(conditionHolds({ not: draft }, values)).toBe(true);
        expect(conditionHolds({ all: [] }, values)).toBe(true);
        expect(conditionHolds({ any: [] }, values)).toBe(false);
    });

    it('normalizes a condition from a file', () => {
        expect(normalizeCondition([{ var: '{{branch}}', op: 'isSet', value: 'x' }], 'Test')).toEqual({ all: [{ var: 'branch', op: 'isSet' }] });
        expect(normalizeCondition({ any: [{ var: 'pr.number', op: 'equals', value: 12 }] }, 'Test')).toEqual({
            any: [{ var: 'pr.number', op: 'equals', value: '12' }]
        });
        expect(() => normalizeCondition({ var: 'a', op: 'like' }, 'Test')).toThrow('operator "like"');
        expect(() => normalizeCondition({ op: 'isSet' }, 'Test')).toThrow('without a variable');
    });

    it('describes a condition', () => {
        expect(
            describeCondition({
                any: [
                    { var: 'a', op: 'isSet' },
                    { var: 'b', op: 'equals', value: 'x' }
                ]
            })
        ).toBe('(a has a value or b is "x")');
    });
});

describe('httpVariables', () => {
    it('gives the status, the body and each JSON value', () => {
        const values = httpVariables({
            status: 201,
            statusText: 'Created',
            body: '{"data":{"id":7,"tags":["a","b"]},"ok":true,"none":null}',
            truncated: false
        });
        expect(values['http.status']).toBe('201');
        expect(values['http.ok']).toBe('true');
        expect(values['http.json.data.id']).toBe('7');
        expect(values['http.json.data.tags.1']).toBe('b');
        expect(values['http.json.data.tags.length']).toBe('2');
        expect(values['http.json.data']).toBe('{"id":7,"tags":["a","b"]}');
        expect(values['http.json.none']).toBe('');
    });

    it('gives no JSON variables for a text body', () => {
        const values = httpVariables({ status: 500, statusText: 'Error', body: 'oops', truncated: false });
        expect(values['http.ok']).toBe('false');
        expect(values['http.body']).toBe('oops');
        expect(Object.keys(values).some(key => key.startsWith('http.json'))).toBe(false);
    });
});

const manualDefinition = {
    name: 'Deploy preview',
    trigger: { type: 'manual', entity: 'pullRequest', button: 'Deploy' },
    conditions: { branchPattern: 'eng-*', when: { all: [{ var: 'pr.draft', op: 'equals', value: 'false' }] } },
    actions: [
        {
            type: 'http',
            method: 'post',
            url: 'https://ci.example.com/deploy/{{branch|url}}',
            headers: [{ name: 'Authorization', value: 'Bearer {{secret.TOKEN}}' }],
            body: '{"pr": {{pr.number}}}'
        },
        {
            type: 'if',
            condition: { var: 'http.json.url', op: 'isSet' },
            // biome-ignore lint/suspicious/noThenProperty: The automation file format has a "then" list.
            then: [{ type: 'notify', title: 'Deployed', body: '{{http.json.url}}' }],
            else: [{ type: 'stop', reason: 'No address', fail: true }]
        }
    ],
    limits: {}
};

function manualAutomation(change: Partial<Automation> = {}): Automation {
    return { ...normalizeAutomation({ ...manualDefinition, status: 'on', binding: { repos: ['/repo'], secrets: { TOKEN: 'abc' } } }), ...change };
}

describe('manual automations', () => {
    it('normalizes the trigger, the HTTP action and the "If" action', () => {
        const definition = normalizeDefinition(manualDefinition);
        expect(definition.trigger).toEqual({ type: 'manual', entity: 'pullRequest', button: 'Deploy' });
        expect(definition.actions[0]).toMatchObject({ type: 'http', method: 'POST' });
        expect(definition.actions[1]).toMatchObject({ type: 'if', condition: { var: 'http.json.url', op: 'isSet' } });
        expect(flattenActions(definition.actions).map(action => action.type)).toEqual(['http', 'if', 'notify', 'stop']);
    });

    it('refuses an action that the entity cannot use', () => {
        expect(() => normalizeDefinition({ ...manualDefinition, actions: [{ type: 'startAgent', prompt: 'x' }] })).toThrow(AutomationError);
        expect(() =>
            normalizeDefinition({
                ...manualDefinition,
                trigger: { type: 'manual', entity: 'task' },
                // biome-ignore lint/suspicious/noThenProperty: The automation file format has a "then" list.
                actions: [{ type: 'if', condition: [], then: [{ type: 'removeWorktree' }] }]
            })
        ).toThrow('cannot follow');
    });

    it('refuses an HTTP action without a valid address', () => {
        expect(() => normalizeDefinition({ ...manualDefinition, actions: [{ type: 'http', url: 'ftp://x' }] })).toThrow('http://');
        // A variable can give the start of the address.
        expect(normalizeDefinition({ ...manualDefinition, actions: [{ type: 'http', url: '{{base}}/x' }] }).actions[0]).toMatchObject({ method: 'GET' });
    });

    it('keeps the secrets out of an export', () => {
        const text = exportAutomation(manualAutomation());
        expect(text).not.toContain('abc');
        expect(text).toContain('{{secret.TOKEN}}');
    });

    it('reports a secret without a value', () => {
        const automation = manualAutomation({ binding: { repos: ['/repo'] } });
        expect(usedSecrets(automation)).toEqual(['TOKEN']);
        expect(bindingProblems(automation, ['/repo'])).toEqual(['Set the value of the secret TOKEN.']);
        expect(bindingProblems(manualAutomation(), ['/repo'])).toEqual([]);
    });

    it('masks the secrets for the run history', () => {
        expect(secretVariables({ secrets: { TOKEN: 'abc' } })).toEqual({ 'secret.TOKEN': 'abc' });
        expect(secretVariables({ secrets: { TOKEN: 'abc' } }, true)).toEqual({ 'secret.TOKEN': '•••' });
    });

    it('selects the buttons of an entity by status, repository and branch', () => {
        const on = manualAutomation();
        const off = manualAutomation({ id: 'off', status: 'off' });
        expect(manualAutomationsFor([on, off], 'pullRequest', { repoPath: '/repo', branch: 'eng-1' })).toEqual([on]);
        expect(manualAutomationsFor([on], 'pullRequest', { repoPath: '/other', branch: 'eng-1' })).toEqual([]);
        expect(manualAutomationsFor([on], 'pullRequest', { repoPath: '/repo', branch: 'main' })).toEqual([]);
        expect(manualAutomationsFor([on], 'worktree', { repoPath: '/repo', branch: 'eng-1' })).toEqual([]);
        expect(buttonLabel(on)).toBe('Deploy');
    });

    it('checks the conditions against the variables of the event', () => {
        const event = { trigger: 'manual' as const, key: 'k', target: 't', label: 'l', at: 0, branch: 'eng-1', pr: { number: 1, url: 'u', isDraft: true } };
        expect(conditionsAgree(manualAutomation(), eventVariables(event))).toBe(false);
        expect(conditionsAgree(manualAutomation(), eventVariables({ ...event, pr: { ...event.pr, isDraft: false } }))).toBe(true);
    });

    it('knows the variables of the entity, the HTTP answer and the secrets', () => {
        const trigger = { type: 'manual' as const, entity: 'pullRequest' as const };
        expect(unknownVariables('{{pr.author}} {{http.json.x}} {{task.status}} {{nope}}', trigger)).toEqual(['nope']);
        expect(unknownVariables('{{secret.TOKEN}}', trigger)).toEqual(['secret.TOKEN']);
        expect(unknownVariables('{{secret.TOKEN}}', trigger, { secrets: ['TOKEN'] })).toEqual([]);
        expect(usesVariable(manualAutomation(), 'http.')).toBe(true);
        expect(usesVariable(manualAutomation(), 'task.')).toBe(false);
    });

    it('selects the target of "Run now" by the entity', () => {
        expect(manualTarget({ type: 'manual', entity: 'pullRequest' })).toBe('worktree');
        expect(manualTarget({ type: 'manual', entity: 'task' })).toBe('task');
        expect(manualTarget({ type: 'manual', entity: 'none' })).toBe('none');
    });

    it('needs a repository to start an agent without an entity', () => {
        expect(needsRepo({ trigger: { type: 'manual', entity: 'none' }, actions: [{ type: 'startAgent', prompt: 'x' }] })).toBe(true);
        expect(needsRepo({ trigger: { type: 'manual', entity: 'none' }, actions: [{ type: 'notify', title: 'x' }] })).toBe(false);
    });

    it('gives the task variables of a task button and of a worktree link', () => {
        const task = {
            id: '1',
            key: 'ENG-1',
            title: 'Fix',
            status: { id: 's', name: 'To do', category: 'todo' as const },
            labels: [{ name: 'api' }, { name: 'bug' }],
            assignees: [{ name: 'Sam' }]
        };
        const values = eventVariables({ trigger: 'manual', key: 'k', target: 't', label: 'l', at: 0, task });
        expect(values['task.labels']).toBe('api, bug');
        expect(values['task.assignees']).toBe('Sam');
        const linked = eventVariables({ trigger: 'manual', key: 'k', target: 't', label: 'l', at: 0, taskLink: { key: 'ENG-2', title: 'Other' } });
        expect(linked['task.key']).toBe('ENG-2');
        expect(linked['task.description']).toBeUndefined();
    });
});
