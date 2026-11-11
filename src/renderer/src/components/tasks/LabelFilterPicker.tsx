import { Tag } from 'lucide-react';
import { ALL_LABELS, labelKey, showsAllLabels, type LabelFilter, type TaskLabel } from '@shared/tasks';
import { FilterPicker, toggleKey, type FilterRow } from './FilterPicker';

interface Props {
    /** The labels that the filter lists. */
    labels: TaskLabel[];
    value: LabelFilter;
    onChange(value: LabelFilter): void;
}

const UNLABELED = 'unlabeled';

/** The text on the button: "All labels", or the first selected item and the number of the other items. */
export function labelSummary(value: LabelFilter, labels: readonly TaskLabel[]): string {
    if (showsAllLabels(value)) return 'All labels';
    const names = value.labels.map(key => labels.find(label => labelKey(label) === key)?.name ?? key);
    if (value.unlabeled) names.push('No labels');
    return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}

/**
 * The rows of the label filter: "No labels", then each label.
 * A selected label that no loaded task has stays in the list, so that the user can clear it.
 */
export function labelRows(value: LabelFilter, labels: readonly TaskLabel[]): { key: string; name: string; color?: string }[] {
    const known = new Set(labels.map(labelKey));
    const missing = value.labels.filter(key => !known.has(key)).map(key => ({ key, name: key }));
    return [...labels.map(label => ({ key: labelKey(label), name: label.name, color: label.color })), ...missing];
}

/** The label filter: a list of check boxes for "No labels" and each label. No selection shows all tasks. */
export function LabelFilterPicker({ labels, value, onChange }: Props) {
    const rows: FilterRow[] = [
        {
            key: UNLABELED,
            label: 'No labels',
            icon: (
                <span className="label-swatch none" aria-hidden="true">
                    <Tag size={10} strokeWidth={1.8} />
                </span>
            ),
            checked: value.unlabeled
        },
        ...labelRows(value, labels).map(row => ({
            key: row.key,
            label: row.name,
            icon: <span className="label-swatch" style={row.color ? { background: row.color } : undefined} aria-hidden="true" />,
            checked: value.labels.includes(row.key)
        }))
    ];

    const all = showsAllLabels(value);
    return (
        <FilterPicker
            className="label-select"
            title="Labels"
            summary={labelSummary(value, labels)}
            active={!all}
            rows={rows}
            searchPlaceholder="Search labels"
            hint={all ? 'No selection shows all tasks.' : 'A task shows when it has one of the selected labels.'}
            onToggle={key => onChange(key === UNLABELED ? { ...value, unlabeled: !value.unlabeled } : { ...value, labels: toggleKey(value.labels, key) })}
            onClear={() => onChange(ALL_LABELS)}
        />
    );
}
