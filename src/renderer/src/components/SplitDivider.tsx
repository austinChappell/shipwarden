import { useRef, type KeyboardEvent } from 'react';
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '@shared/panes';

/** The change of the ratio for one push of an arrow key. */
const KEY_STEP = 0.05;
/** The change of the ratio for one push of an arrow key with Shift. */
const SHIFT_KEY_STEP = 0.2;

/**
 * Returns the new ratio for a key on a divider, in the range of a split. Returns undefined for a key that does not resize.
 * In a "row" split, Left and Right change the ratio. In a "column" split, Up and Down change it.
 * Home and End go to the smallest and the largest ratio.
 */
export function splitKeyRatio(ratio: number, direction: 'row' | 'column', key: string, shiftKey: boolean): number | undefined {
    const [less, more] = direction === 'row' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const step = shiftKey ? SHIFT_KEY_STEP : KEY_STEP;
    const next = key === less ? ratio - step : key === more ? ratio + step : key === 'Home' ? MIN_SPLIT_RATIO : key === 'End' ? MAX_SPLIT_RATIO : undefined;
    return next === undefined ? undefined : Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, next));
}

interface Props {
    /** "row": the panes are side by side, so the divider moves left and right. "column": up and down. */
    direction: 'row' | 'column';
    /** The size of the first pane now, as a part of the split (0 to 1). */
    ratio: number;
    /** Called while the user drags, with the new size of the first pane as a part of the split (0 to 1). */
    onResize(ratio: number): void;
}

/** The line between the two panes of a split. Drag it, or focus it and push the arrow keys, to change their sizes. */
export function SplitDivider({ direction, ratio, onResize }: Props) {
    const ref = useRef<HTMLDivElement>(null);

    const start = (event: React.MouseEvent) => {
        event.preventDefault();
        const container = ref.current?.parentElement;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const move = (moveEvent: MouseEvent) => {
            const ratio = direction === 'row' ? (moveEvent.clientX - rect.left) / rect.width : (moveEvent.clientY - rect.top) / rect.height;
            onResize(ratio);
        };
        const stop = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', stop);
            document.body.classList.remove('resizing-split', `resizing-${direction}`);
        };
        document.body.classList.add('resizing-split', `resizing-${direction}`);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', stop);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const next = splitKeyRatio(ratio, direction, event.key, event.shiftKey);
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onResize(next);
    };

    return (
        <div
            ref={ref}
            className={`split-divider ${direction}`}
            role="separator"
            aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
            aria-label="Pane size"
            aria-valuenow={Math.round(ratio * 100)}
            aria-valuemin={MIN_SPLIT_RATIO * 100}
            aria-valuemax={MAX_SPLIT_RATIO * 100}
            tabIndex={0}
            title="Drag, or push the arrow keys, to change the pane sizes. Shift makes bigger steps."
            onMouseDown={start}
            onKeyDown={onKeyDown}
        />
    );
}
