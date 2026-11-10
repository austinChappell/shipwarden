import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** The change of the width in pixels for one push of an arrow key. */
const KEY_STEP = 16;
/** The change of the width in pixels for one push of an arrow key with Shift. */
const SHIFT_KEY_STEP = 64;

/** Limits a width to the range from `min` to `max`. */
export function clampWidth(width: number, min: number, max: number): number {
    return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * Returns the new width for a key on a resize handle. Returns undefined for a key that does not resize.
 * An arrow key that points away from the panel makes the panel wider. End sets the largest width.
 * The caller limits the width. Enter and Home are not in this function, because they set the default width.
 */
export function resizeKeyWidth(width: number, max: number, edge: 'left' | 'right', key: string, shiftKey: boolean): number | undefined {
    const step = shiftKey ? SHIFT_KEY_STEP : KEY_STEP;
    const direction = edge === 'right' ? 1 : -1;
    if (key === 'ArrowRight') return width + direction * step;
    if (key === 'ArrowLeft') return width - direction * step;
    if (key === 'End') return max;
    return undefined;
}

function readWidth(storageKey: string, fallback: number, min: number, max: number): number {
    try {
        const value = Number(localStorage.getItem(storageKey));
        return value > 0 ? clampWidth(value, min, max) : fallback;
    } catch {
        return fallback;
    }
}

export interface PanelWidth {
    width: number;
    min: number;
    max: number;
    setWidth(width: number): void;
    reset(): void;
}

/** Keeps the width of a panel in local storage. */
export function usePanelWidth(storageKey: string, defaultWidth: number, min: number, max: number): PanelWidth {
    const [width, setRawWidth] = useState(() => readWidth(storageKey, defaultWidth, min, max));
    useEffect(() => {
        try {
            localStorage.setItem(storageKey, String(width));
        } catch {
            // The width stays for this session only.
        }
    }, [storageKey, width]);
    const setWidth = useCallback((next: number) => setRawWidth(clampWidth(next, min, max)), [min, max]);
    const reset = useCallback(() => setRawWidth(defaultWidth), [defaultWidth]);
    return { width, min, max, setWidth, reset };
}

interface Props {
    panel: PanelWidth;
    /** The edge of the panel that has the handle. A drag away from the panel makes the panel wider. */
    edge: 'left' | 'right';
    label: string;
    /** Returns the largest width that the window has space for now. The drag does not go past it. */
    maxAvailable?: () => number;
}

/**
 * A vertical handle that changes the width of a panel. Drag it, or focus it and push the arrow keys.
 * Shift makes bigger steps. End sets the largest width. A double-click, Enter or Home sets the default width again.
 */
export function ResizeHandle({ panel, edge, label, maxAvailable }: Props) {
    const direction = edge === 'right' ? 1 : -1;
    const resize = (width: number) => panel.setWidth(Math.min(width, maxAvailable?.() ?? Infinity));

    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const handle = event.currentTarget;
        const startX = event.clientX;
        // Start from the width on the screen. In a small window, a panel can be narrower than its stored width.
        const element = edge === 'right' ? handle.previousElementSibling : handle.nextElementSibling;
        const startWidth = element instanceof HTMLElement ? element.offsetWidth : panel.width;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
        const onMove = (move: globalThis.PointerEvent) => resize(startWidth + direction * (move.clientX - startX));
        const onEnd = () => {
            document.body.classList.remove('resizing');
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onEnd);
            handle.removeEventListener('pointercancel', onEnd);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onEnd);
        handle.addEventListener('pointercancel', onEnd);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        const next = resizeKeyWidth(panel.width, panel.max, edge, event.key, event.shiftKey);
        if (next !== undefined) {
            event.preventDefault();
            resize(next);
        } else if (event.key === 'Enter' || event.key === 'Home') {
            event.preventDefault();
            panel.reset();
        }
    };

    return (
        <div
            className={`resize-handle resize-handle-${edge}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuenow={panel.width}
            aria-valuemin={panel.min}
            aria-valuemax={panel.max}
            tabIndex={0}
            title={`${label}. Shift with an arrow key makes bigger steps. Double-click or press Enter to reset.`}
            onPointerDown={onPointerDown}
            onDoubleClick={panel.reset}
            onKeyDown={onKeyDown}
        />
    );
}
