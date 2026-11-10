import { useEffect, useRef, type RefObject } from 'react';
import { stepIndex } from './keyboard';

/**
 * Closes the dropdown menu in `root` while it is open:
 * - A pointer press outside the root closes the menu.
 * - Escape closes the menu. The focus goes back to the button with `aria-haspopup` in the root.
 * - The focus moves to an element outside the root, for example with Tab. The menu closes.
 */
export function useMenuClose(open: boolean, root: RefObject<HTMLElement | null>, close: () => void): void {
    // The ref holds the newest function, so the listeners do not change on each render.
    const onClose = useRef(close);
    onClose.current = close;

    // biome-ignore lint/correctness/useExhaustiveDependencies: root is a ref object. The effect reads its element each time the menu opens.
    useEffect(() => {
        if (!open) return;
        const element = root.current;
        const onPointer = (event: PointerEvent) => {
            if (!element?.contains(event.target as Node)) onClose.current();
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            onClose.current();
            element?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
        };
        const onFocusOut = (event: FocusEvent) => {
            // A click on an empty part of the menu gives no new focus. Only a focus outside the root closes the menu.
            const next = event.relatedTarget;
            if (next instanceof Node && !element?.contains(next)) onClose.current();
        };
        window.addEventListener('pointerdown', onPointer);
        window.addEventListener('keydown', onKey);
        element?.addEventListener('focusout', onFocusOut);
        return () => {
            window.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('keydown', onKey);
            element?.removeEventListener('focusout', onFocusOut);
        };
    }, [open]);
}

/**
 * Moves the focus between the items of a menu. ArrowDown and ArrowUp go to the next and the previous item, and wrap.
 * Home and End go to the first and the last item. Returns true when the key moved the focus.
 */
export function moveMenuFocus(event: React.KeyboardEvent, items: HTMLElement[]): boolean {
    if (event.altKey || event.ctrlKey || event.metaKey || items.length === 0) return false;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : stepIndex(index, items.length, 1);
    else if (event.key === 'ArrowUp') next = index < 0 ? items.length - 1 : stepIndex(index, items.length, -1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return false;
    event.preventDefault();
    items[next].focus();
    return true;
}
