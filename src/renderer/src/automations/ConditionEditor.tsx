import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
    CONDITION_OPS,
    MAX_NESTING,
    describeCondition,
    isConditionRule,
    type Condition,
    type ConditionOp,
    type ConditionRule
} from '@shared/automation-templates';
import type { VariableInfo } from '@shared/automations';
import { Select } from '../components/Select';

type Group = { all: Condition[] } | { any: Condition[] };

interface Props {
    /** The condition. Undefined: no condition. */
    value: Condition | undefined;
    /** The variables that the list of names suggests. */
    variables: VariableInfo[];
    onChange(value: Condition | undefined): void;
    /** The text when the condition is empty. */
    emptyText?: string;
}

const NEW_RULE: ConditionRule = { var: 'branch', op: 'equals', value: '' };

/** Returns the condition as a group. The editor shows a group at the top. */
function asGroup(value: Condition | undefined): Group {
    if (!value) return { all: [] };
    if ('all' in value || 'any' in value) return value;
    return { all: [value] };
}

/**
 * The editor of a condition: a group of rules ("all" or "any") with nested groups. A rule compares a variable with a
 * value. The names of the variables come from a list, and the user can also type a name, for example "http.json.id".
 */
export function ConditionEditor({ value, variables, onChange, emptyText }: Props) {
    const listId = useId();
    const group = asGroup(value);
    const items = 'all' in group ? group.all : group.any;
    return (
        <div className="automation-conditions">
            <datalist id={listId}>
                {variables.map(variable => (
                    <option key={variable.name} value={variable.name}>
                        {variable.description}
                    </option>
                ))}
                {!variables.some(variable => variable.name === 'http.status') && <option value="http.status">The status of the last HTTP answer</option>}
            </datalist>
            {items.length === 0 && emptyText && <div className="automation-variables">{emptyText}</div>}
            <GroupEditor group={group} listId={listId} depth={0} onChange={next => onChange(itemsOf(next).length > 0 ? next : undefined)} />
        </div>
    );
}

function itemsOf(group: Group): Condition[] {
    return 'all' in group ? group.all : group.any;
}

function withItems(group: Group, items: Condition[]): Group {
    return 'all' in group ? { all: items } : { any: items };
}

interface GroupProps {
    group: Group;
    listId: string;
    depth: number;
    onChange(group: Group): void;
    onRemove?(): void;
}

function GroupEditor({ group, listId, depth, onChange, onRemove }: GroupProps) {
    const items = itemsOf(group);
    const setItem = (index: number, item: Condition) =>
        onChange(
            withItems(
                group,
                items.map((other, i) => (i === index ? item : other))
            )
        );
    const removeItem = (index: number) =>
        onChange(
            withItems(
                group,
                items.filter((_, i) => i !== index)
            )
        );
    return (
        <div className={depth > 0 ? 'automation-condition-group nested' : 'automation-condition-group'}>
            {(items.length > 1 || depth > 0) && (
                <div className="automation-condition-head">
                    <Select<'all' | 'any'>
                        className="settings-input"
                        aria-label="How the conditions combine"
                        value={'all' in group ? 'all' : 'any'}
                        options={[
                            { value: 'all', label: 'All of these agree' },
                            { value: 'any', label: 'One or more of these agree' }
                        ]}
                        onChange={mode => onChange(mode === 'all' ? { all: items } : { any: items })}
                    />
                    {onRemove && (
                        <button type="button" className="icon-button" title="Remove the group" aria-label="Remove the group" onClick={onRemove}>
                            <Trash2 size={14} strokeWidth={1.7} />
                        </button>
                    )}
                </div>
            )}
            {items.map((item, index) => {
                const key = `${index}`;
                if (isConditionRule(item)) {
                    return <RuleEditor key={key} rule={item} listId={listId} onChange={next => setItem(index, next)} onRemove={() => removeItem(index)} />;
                }
                if ('not' in item) {
                    // The editor has the negative operators. A "not" from a file shows as text.
                    return (
                        <div key={key} className="automation-condition-rule">
                            <span className="automation-variables">{describeCondition(item)} (change it in the file)</span>
                            <button type="button" className="icon-button" title="Remove the condition" onClick={() => removeItem(index)}>
                                <Trash2 size={14} strokeWidth={1.7} />
                            </button>
                        </div>
                    );
                }
                return (
                    <GroupEditor
                        key={key}
                        group={item}
                        listId={listId}
                        depth={depth + 1}
                        onChange={next => setItem(index, next)}
                        onRemove={() => removeItem(index)}
                    />
                );
            })}
            <div className="automation-condition-add">
                <button type="button" className="button" onClick={() => onChange(withItems(group, [...items, { ...NEW_RULE }]))}>
                    <Plus size={13} strokeWidth={1.8} />
                    Add a condition
                </button>
                {depth < MAX_NESTING - 1 && (
                    <button type="button" className="button" onClick={() => onChange(withItems(group, [...items, { any: [{ ...NEW_RULE }] }]))}>
                        <Plus size={13} strokeWidth={1.8} />
                        Add a group
                    </button>
                )}
            </div>
        </div>
    );
}

interface RuleProps {
    rule: ConditionRule;
    listId: string;
    onChange(rule: ConditionRule): void;
    onRemove(): void;
}

function RuleEditor({ rule, listId, onChange, onRemove }: RuleProps) {
    const op = CONDITION_OPS.find(item => item.op === rule.op);
    return (
        <div className="automation-condition-rule">
            <input
                className="settings-input mono automation-condition-var"
                list={listId}
                aria-label="Variable"
                placeholder="Variable, for example branch"
                value={rule.var}
                spellCheck={false}
                onChange={event => onChange({ ...rule, var: event.target.value.replace(/[{}\s]/g, '') })}
            />
            <Select<ConditionOp>
                className="settings-input"
                aria-label="Operator"
                value={rule.op}
                options={CONDITION_OPS.map(item => ({ value: item.op, label: item.label }))}
                onChange={next => {
                    const needsValue = CONDITION_OPS.find(item => item.op === next)?.needsValue;
                    onChange(needsValue ? { var: rule.var, op: next, value: rule.value ?? '' } : { var: rule.var, op: next });
                }}
            />
            {op?.needsValue && (
                <input
                    className="settings-input mono automation-condition-value"
                    aria-label="Value"
                    placeholder={rule.op === 'matches' || rule.op === 'notMatches' ? 'eng-*' : 'Value or {{variable}}'}
                    value={rule.value ?? ''}
                    spellCheck={false}
                    onChange={event => onChange({ ...rule, value: event.target.value })}
                />
            )}
            <button type="button" className="icon-button" title="Remove the condition" aria-label="Remove the condition" onClick={onRemove}>
                <Trash2 size={14} strokeWidth={1.7} />
            </button>
        </div>
    );
}
