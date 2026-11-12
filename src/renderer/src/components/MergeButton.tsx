import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, GitMerge } from 'lucide-react';
import type { MergeMethod } from '@shared/github';
import { MERGE_LABELS } from '../github/merge-state';
import { Button, ButtonGroup, type ControlSize } from './ui';
import { useMenuClose } from './use-menu';

export { MERGE_LABELS };

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
    /** The height of the buttons. The default is "md". */
    size?: ControlSize;
    onSelect(method: MergeMethod): void;
    onRun(): void;
}

/**
 * A split button as on GitHub. The main part runs the action with the selected method.
 * The arrow opens a menu that selects a different method. The menu does not run the action.
 */
export function MergeButton({ methods, method, label, disabled, title, size, onSelect, onRun }: Props) {
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
    const main = (
        <Button variant="merge" size={size} icon={<GitMerge size={14} strokeWidth={1.8} />} disabled={disabled} title={title} onClick={onRun}>
            {label ?? BUTTON_LABELS[method]}
        </Button>
    );
    return (
        <div className="merge-split" ref={root}>
            {choice ? (
                <ButtonGroup tone="merge" size={size}>
                    {main}
                    <Button
                        variant="merge"
                        size={size}
                        className="button-group-arrow"
                        active={open}
                        title="Select the merge method"
                        aria-label="Select the merge method"
                        aria-haspopup="menu"
                        aria-expanded={open}
                        icon={<ChevronDown size={14} strokeWidth={1.8} />}
                        onClick={() => setOpen(value => !value)}
                    />
                </ButtonGroup>
            ) : (
                main
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
