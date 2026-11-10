import { useEffect, useRef, type RefObject } from 'react';

/** The elements that the Tab key can focus. */
const TABBABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(', ');

/** The number of modal dialogs that show now. */
let openModals = 0;

/** True while a modal dialog of `useModal` shows. */
export function modalOpen(): boolean {
    return openModals > 0;
}

/**
 * Returns the item that gets the focus when Tab must wrap, or undefined when the browser can move the focus.
 * Tab on the last item goes to the first item. Shift+Tab on the first item goes to the last item.
 * When the focus is not on an item, Tab goes to the first item and Shift+Tab goes to the last item.
 */
export function wrapTarget<T>(items: T[], current: T | null, backward: boolean): T | undefined {
    if (items.length === 0) return undefined;
    const index = current === null ? -1 : items.indexOf(current);
    const first = items[0];
    const last = items[items.length - 1];
    if (index < 0) return backward ? last : first;
    if (backward && index === 0) return last;
    if (!backward && index === items.length - 1) return first;
    return undefined;
}

/** Keeps the focus of the Tab key in the container. Call it from the keydown handler of the container. */
export function trapTab(event: KeyboardEvent | React.KeyboardEvent, container: HTMLElement): void {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const items = [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter(item => item.getClientRects().length > 0);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = wrapTarget(items, active, event.shiftKey);
    // With no item, the focus stays where it is.
    if (target || items.length === 0) event.preventDefault();
    target?.focus();
}

/**
 * Makes the dialog in `ref` modal while the component shows:
 * - The Tab key stays in the dialog.
 * - The workspace shortcuts do nothing.
 * - When the dialog closes, the focus goes back to the element that had it before.
 */
export function useModal(ref: RefObject<HTMLElement | null>): void {
    // The render reads the focus. An effect is too late, because `autoFocus` in the dialog moves the focus first.
    const previous = useRef<Element | null>(null);
    if (previous.current === null) previous.current = document.activeElement;
    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect must run one time, when the dialog mounts. ref is a ref object.
    useEffect(() => {
        const before = previous.current;
        const element = ref.current;
        const onKey = (event: KeyboardEvent) => {
            if (element) trapTab(event, element);
        };
        openModals += 1;
        element?.addEventListener('keydown', onKey);
        return () => {
            openModals -= 1;
            element?.removeEventListener('keydown', onKey);
            // The development mode of React runs the effect two times. The dialog then stays in the page, and keeps the focus.
            if (element?.isConnected) return;
            // The focus goes back, for example to the button that opened the dialog.
            if (before instanceof HTMLElement && document.contains(before)) before.focus();
        };
    }, []);
}
