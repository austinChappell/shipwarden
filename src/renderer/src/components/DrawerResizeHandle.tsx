import type { KeyboardEvent, PointerEvent } from 'react';
import type { PanelWidth } from './ResizeHandle';

/** The change of the height in pixels for one push of an arrow key. Shift makes the step 4 times larger. */
const KEY_STEP = 16;
/** The smallest height of the page above the drawer. */
const MIN_PAGE_HEIGHT = 160;

interface Props {
    /** The height of the drawer. `usePanelWidth` keeps it, as for the width of a side panel. */
    height: PanelWidth;
    /** The name of the drawer in the label, for example "agent drawer". */
    name: string;
}

/**
 * The resize handle on the top border of a drawer at the bottom of a page. The drawer is the parent element of the
 * handle. Drag the handle, or focus it and push the up and down arrow keys. Shift makes bigger steps. A double-click,
 * Enter, or Home sets the default height again. The drawer always leaves space for the page above it.
 */
export function DrawerResizeHandle({ height, name }: Props) {
    /** The largest height that leaves space for the page above the drawer. */
    const maxHeight = (drawer: HTMLElement) => (drawer.parentElement?.clientHeight ?? window.innerHeight) - MIN_PAGE_HEIGHT;
    const resize = (drawer: HTMLElement, value: number) => height.setWidth(Math.min(value, maxHeight(drawer)));

    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        const drawer = handle.parentElement;
        if (!drawer) return;
        const startY = event.clientY;
        const startHeight = drawer.offsetHeight;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing-rows');
        const onMove = (move: globalThis.PointerEvent) => resize(drawer, startHeight + startY - move.clientY);
        const onEnd = () => {
            document.body.classList.remove('resizing-rows');
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onEnd);
            handle.removeEventListener('pointercancel', onEnd);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onEnd);
        handle.addEventListener('pointercancel', onEnd);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const drawer = event.currentTarget.parentElement;
        if (!drawer || event.metaKey || event.ctrlKey || event.altKey) return;
        const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            resize(drawer, height.width + (event.key === 'ArrowUp' ? step : -step));
        } else if (event.key === 'Enter' || event.key === 'Home') {
            event.preventDefault();
            height.reset();
        }
    };

    return (
        <div
            className="drawer-resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label={`Resize the ${name}`}
            aria-valuenow={height.width}
            aria-valuemin={height.min}
            aria-valuemax={height.max}
            tabIndex={0}
            title={`Resize the ${name}. Shift with an arrow key makes bigger steps. Double-click or press Enter to reset.`}
            onPointerDown={onPointerDown}
            onDoubleClick={height.reset}
            onKeyDown={onKeyDown}
        />
    );
}
