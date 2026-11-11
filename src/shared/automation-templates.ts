/**
 * The templates and the conditions of automations.
 *
 * A template is text with variables, for example "{{pr.url}}". A filter after a bar changes the value:
 * - "{{comment.body|json}}" gives a JSON string with quotes, for the body of an HTTP request.
 * - "{{branch|url}}" encodes the value for a part of a web address.
 *
 * A condition compares a variable with a value. Groups ("all", "any") and "not" combine conditions.
 *
 * This module uses no Electron API and no browser API.
 */

/** A variable in a template: "{{name}}" or "{{name|filter}}". */
const VARIABLE_PATTERN = /\{\{\s*([\w.-]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g;

/** The filters of a template variable. */
export const TEMPLATE_FILTERS = ['json', 'url'] as const;
export type TemplateFilter = (typeof TEMPLATE_FILTERS)[number];

function applyFilter(value: string | undefined, filter: string | undefined): string {
    switch (filter) {
        case 'json':
            return JSON.stringify(value ?? '');
        case 'url':
            return encodeURIComponent(value ?? '');
        default:
            return value ?? '';
    }
}

/** Replaces each "{{name}}" with its value. A variable without a value becomes an empty string. */
export function renderTemplate(template: string, values: Record<string, string | undefined>): string {
    return template.replace(VARIABLE_PATTERN, (_match, name: string, filter: string | undefined) => applyFilter(values[name], filter));
}

/** Returns the names of the variables of a template, one time each. */
export function templateVariables(template: string): string[] {
    return [...new Set([...template.matchAll(VARIABLE_PATTERN)].map(match => match[1]))];
}

/** Returns the filters of the template that are not known, one time each. */
export function unknownFilters(template: string): string[] {
    const unknown = new Set<string>();
    for (const match of template.matchAll(VARIABLE_PATTERN)) {
        if (match[2] && !(TEMPLATE_FILTERS as readonly string[]).includes(match[2])) unknown.add(match[2]);
    }
    return [...unknown];
}

/** Converts a pattern with "*" to a regular expression. The match ignores case. */
export function globRegex(pattern: string): RegExp {
    const escaped = pattern
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${escaped}$`, 'i');
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Conditions                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ConditionOp = 'equals' | 'notEquals' | 'contains' | 'notContains' | 'matches' | 'notMatches' | 'isSet' | 'isEmpty' | 'greaterThan' | 'lessThan';

/** Compares the variable `var` with `value`. `value` can contain variables. The text operators ignore case. */
export interface ConditionRule {
    var: string;
    op: ConditionOp;
    value?: string;
}

export type Condition = ConditionRule | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export const CONDITION_OPS: { op: ConditionOp; label: string; needsValue: boolean }[] = [
    { op: 'equals', label: 'is', needsValue: true },
    { op: 'notEquals', label: 'is not', needsValue: true },
    { op: 'contains', label: 'contains', needsValue: true },
    { op: 'notContains', label: 'does not contain', needsValue: true },
    { op: 'matches', label: 'matches the pattern', needsValue: true },
    { op: 'notMatches', label: 'does not match the pattern', needsValue: true },
    { op: 'isSet', label: 'has a value', needsValue: false },
    { op: 'isEmpty', label: 'is empty', needsValue: false },
    { op: 'greaterThan', label: 'is more than', needsValue: true },
    { op: 'lessThan', label: 'is less than', needsValue: true }
];

/** The deepest nesting of condition groups and of "If" actions. */
export const MAX_NESTING = 6;

/** A condition that is not valid. The message tells the user what to change. */
export class ConditionError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isConditionRule(condition: Condition): condition is ConditionRule {
    return 'var' in condition;
}

/** Checks a condition from a file and returns it in a clean form. Throws a `ConditionError` with a message for the user. */
export function normalizeCondition(value: unknown, place: string, depth = 0): Condition {
    if (depth > MAX_NESTING) throw new ConditionError(`${place} has more than ${MAX_NESTING} levels of groups.`);
    if (Array.isArray(value)) return { all: value.map(item => normalizeCondition(item, place, depth + 1)) };
    if (!isRecord(value)) throw new ConditionError(`${place} has a condition that is not an object.`);
    for (const key of ['all', 'any'] as const) {
        if (key in value) {
            if (!Array.isArray(value[key])) throw new ConditionError(`${place}: "${key}" must be a list of conditions.`);
            const list = (value[key] as unknown[]).map(item => normalizeCondition(item, place, depth + 1));
            return key === 'all' ? { all: list } : { any: list };
        }
    }
    if ('not' in value) return { not: normalizeCondition(value.not, place, depth + 1) };
    const name = typeof value.var === 'string' ? value.var.trim().replace(/^\{\{\s*|\s*\}\}$/g, '') : '';
    if (!/^[\w.-]+$/.test(name)) throw new ConditionError(`${place} has a condition without a variable name.`);
    const op = CONDITION_OPS.find(item => item.op === value.op);
    if (!op)
        throw new ConditionError(
            `${place}: the operator "${String(value.op ?? '')}" is not known. Use one of: ${CONDITION_OPS.map(item => item.op).join(', ')}.`
        );
    const text = typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean' ? String(value.value) : '';
    return op.needsValue ? { var: name, op: op.op, value: text.slice(0, 1000) } : { var: name, op: op.op };
}

function numberOf(text: string): number | undefined {
    if (!text.trim()) return undefined;
    const value = Number(text.trim());
    return Number.isFinite(value) ? value : undefined;
}

function ruleHolds(rule: ConditionRule, values: Record<string, string | undefined>): boolean {
    const actual = (values[rule.var] ?? '').trim();
    const expected = renderTemplate(rule.value ?? '', values).trim();
    const a = actual.toLowerCase();
    const b = expected.toLowerCase();
    switch (rule.op) {
        case 'equals':
            return a === b;
        case 'notEquals':
            return a !== b;
        case 'contains':
            return a.includes(b);
        case 'notContains':
            return !a.includes(b);
        case 'matches':
            return globRegex(expected).test(actual);
        case 'notMatches':
            return !globRegex(expected).test(actual);
        case 'isSet':
            return actual !== '';
        case 'isEmpty':
            return actual === '';
        case 'greaterThan':
        case 'lessThan': {
            const left = numberOf(actual);
            const right = numberOf(expected);
            if (left === undefined || right === undefined) return false;
            return rule.op === 'greaterThan' ? left > right : left < right;
        }
    }
}

/** True when the condition agrees with the values. An empty "all" group agrees. An empty "any" group does not agree. */
export function conditionHolds(condition: Condition, values: Record<string, string | undefined>): boolean {
    if (isConditionRule(condition)) return ruleHolds(condition, values);
    if ('all' in condition) return condition.all.every(item => conditionHolds(item, values));
    if ('any' in condition) return condition.any.some(item => conditionHolds(item, values));
    return !conditionHolds(condition.not, values);
}

/** Returns the variable names and the value templates of a condition. */
export function conditionTexts(condition: Condition): string[] {
    if (isConditionRule(condition)) return [`{{${condition.var}}}`, condition.value ?? ''];
    if ('all' in condition) return condition.all.flatMap(conditionTexts);
    if ('any' in condition) return condition.any.flatMap(conditionTexts);
    return conditionTexts(condition.not);
}

/** A short text of a condition, for the run history and the tooltips. */
export function describeCondition(condition: Condition): string {
    if (isConditionRule(condition)) {
        const op = CONDITION_OPS.find(item => item.op === condition.op);
        return op?.needsValue ? `${condition.var} ${op.label} "${condition.value ?? ''}"` : `${condition.var} ${op?.label ?? condition.op}`;
    }
    if ('all' in condition) return condition.all.length === 1 ? describeCondition(condition.all[0]) : `(${condition.all.map(describeCondition).join(' and ')})`;
    if ('any' in condition) return condition.any.length === 1 ? describeCondition(condition.any[0]) : `(${condition.any.map(describeCondition).join(' or ')})`;
    return `not ${describeCondition(condition.not)}`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* HTTP responses                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The answer of an HTTP request of an automation. The main process sends the request. */
export interface HttpResponse {
    status: number;
    statusText: string;
    /** The text of the body. A large body is cut. */
    body: string;
    /** True when the body was larger than the limit, and `body` is the start only. */
    truncated: boolean;
    contentType?: string;
}

/** The most variables that the JSON of an answer gives. */
const MAX_JSON_VARIABLES = 500;

/** Adds a variable for each value of the JSON, for example "http.json.items.0.name". Objects and lists also get their JSON text. */
function flattenJson(prefix: string, value: unknown, out: Record<string, string>, depth: number): void {
    if (Object.keys(out).length >= MAX_JSON_VARIABLES) return;
    if (value === null || value === undefined) {
        out[prefix] = '';
        return;
    }
    if (typeof value !== 'object') {
        out[prefix] = String(value);
        return;
    }
    out[prefix] = JSON.stringify(value);
    if (depth >= MAX_NESTING) return;
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
    if (Array.isArray(value)) out[`${prefix}.length`] = String(value.length);
    for (const [key, item] of entries) {
        if (!/^[\w-]+$/.test(key)) continue;
        flattenJson(`${prefix}.${key}`, item, out, depth + 1);
    }
}

/**
 * The variables of an HTTP answer: "http.status", "http.ok", "http.body" and, for a JSON body, "http.json" and one
 * variable for each value, for example "http.json.data.id".
 */
export function httpVariables(response: HttpResponse): Record<string, string> {
    const out: Record<string, string> = {
        'http.status': String(response.status),
        'http.ok': response.status >= 200 && response.status < 300 ? 'true' : 'false',
        'http.body': response.body
    };
    try {
        const json: unknown = JSON.parse(response.body);
        flattenJson('http.json', json, out, 0);
    } catch {
        // The body is not JSON. Only "http.body" has it.
    }
    return out;
}
