import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, GitMerge } from 'lucide-react';
import type { MergeMethod } from '@shared/github';
import { useMenuClose } from './use-menu';

export const MERGE_LABELS: Record<MergeMethod, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };

/** The button text for each method. GitHub shows "Merge pull request" for a merge commit. */
const BUTTON_LABELS: Record<MergeMethod, string> = { merge: 'Merge pull request', squash: 'Squash and merge', rebase: 'Rebase and merge' };

const MERGE_DETAILS: Record<MergeMethod, string> = {
    merge: 'All commits from this branch go into the base branch with a merge commit.',
    squash: 'The commits from this branch become one commit in the base branch.',
    rebase: 'The commits from this branch go onto the base branch one by one, without a merge commit.'
};

interface Props {
    methods: MergeMethod[];
    method: MergeMethod;
    /** The text of the main button. Undefined shows the name of the method. */
    label?: string;
    disabled: boolean;
    /** The text that tells why the button is disabled. */
    title?: string;
    onSelect(method: MergeMethod): void;
    onRun(): void;
}

/**
 * A split button as on GitHub. The main part runs the action with the selected method.
 * The arrow opens a menu that selects a different method. The menu does not run the action.
 */
export function MergeButton({ methods, method, label, disabled, title, onSelect, onRun }: Props) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);

    useMenuClose(open, root, () => setOpen(false));
    useEffect(() => {
        if (open) root.current?.querySelector<HTMLButtonElement>('.merge-menu-item.selected')?.focus();
    }, [open]);

    /** Moves the focus between the methods with the arrow keys. */
    const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.merge-menu-item') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    };

    const choice = methods.length > 1;
    return (
        <div className={`merge-split${choice ? ' joined' : ''}`} ref={root}>
            <button className={`button merge merge-split-main${choice ? '' : ' alone'}`} disabled={disabled} title={title} onClick={onRun}>
                <GitMerge size={14} strokeWidth={1.8} />{label ?? BUTTON_LABELS[method]}
            </button>
            {choice && (
                <button
                    className={`button merge merge-split-arrow${open ? ' on' : ''}`}
                    title="Select the merge method"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={() => setOpen(value => !value)}
                >
                    <ChevronDown size={14} strokeWidth={1.8} />
                </button>
            )}
            {open && (
                <div className="new-tab-menu merge-menu" role="menu" onKeyDown={onMenuKey}>
                    {methods.map(item => (
                        <button
                            key={item}
                            role="menuitemradio"
                            aria-checked={item === method}
                            className={`merge-menu-item${item === method ? ' selected' : ''}`}
                            onClick={() => {
                                onSelect(item);
                                setOpen(false);
                            }}
                        >
                            <span className="merge-menu-check">{item === method && <Check size={14} strokeWidth={2} />}</span>
                            <span className="merge-menu-text">
                                <span className="merge-menu-title">{MERGE_LABELS[item]}</span>
                                <span className="merge-menu-detail">{MERGE_DETAILS[item]}</span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
