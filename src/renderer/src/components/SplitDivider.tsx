import { useRef } from 'react';

interface Props {
    /** "row": the panes are side by side, so the divider moves left and right. "column": up and down. */
    direction: 'row' | 'column';
    /** Called while the user drags, with the new size of the first pane as a part of the split (0 to 1). */
    onResize(ratio: number): void;
}

/** The line between the two panes of a split. Drag it to change their sizes. */
export function SplitDivider({ direction, onResize }: Props) {
    const ref = useRef<HTMLDivElement>(null);

    const start = (event: React.MouseEvent) => {
        event.preventDefault();
        const container = ref.current?.parentElement;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const move = (moveEvent: MouseEvent) => {
            const ratio = direction === 'row'
                ? (moveEvent.clientX - rect.left) / rect.width
                : (moveEvent.clientY - rect.top) / rect.height;
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

    return <div ref={ref} className={`split-divider ${direction}`} role="separator" aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'} onMouseDown={start} />;
}
