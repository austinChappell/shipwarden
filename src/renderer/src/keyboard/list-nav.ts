import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/** The selector of the list items. The arrow keys move the focus between them. */
export const NAV_ITEM = '[data-nav-item]';

/** The keys that move the focus in a list. */
const MOVE_KEYS = ['ArrowUp', 'ArrowDown', 'Home', 'End'];

/**
 * Gives the index of the item that gets the focus after a key.
 * `index` is the index of the focused item. Up and Down stop at the ends of the list.
 * Returns undefined when the key does not move the focus.
 */
export function navTargetIndex(key: string, index: number, count: number): number | undefined {
    if (count === 0 || !MOVE_KEYS.includes(key)) return undefined;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    const next = key === 'ArrowDown' ? index + 1 : index - 1;
    return next >= 0 && next < count ? next : undefined;
}

/** Opens the context menu of an element from the keyboard. The menu opens under the element. */
export function openMenuAt(element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: rect.bottom }));
}

/**
 * Returns a key handler for a list item that is not a button.
 * Enter and Space run the action. ⇧F10 and the context menu key open the context menu of the item.
 * The handler ignores keys from the controls in the item.
 */
export function itemKeys(action: () => void) {
    return (event: ReactKeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            action();
        } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            event.preventDefault();
            openMenuAt(event.currentTarget);
        }
    };
}

/**
 * Moves the focus between the list items in the element that has this handler.
 * Up and Down move to the previous and next item. Home and End move to the first and last item.
 * Down in a text field moves to the first item after the field.
 * The handler ignores a key that an inner list or an item handled first.
 */
export function moveListFocus(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(NAV_ITEM)];
    let next: HTMLElement | undefined;
    if (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type)) {
        if (event.key !== 'ArrowDown') return;
        next = items.find(item => !!(target.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING));
    } else {
        const index = items.indexOf(target);
        if (index === -1) return;
        const nextIndex = navTargetIndex(event.key, index, items.length);
        // The key moves the focus, also at the ends of the list. Then the page does not scroll.
        if (MOVE_KEYS.includes(event.key)) event.preventDefault();
        next = nextIndex === undefined ? undefined : items[nextIndex];
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
}

/**
 * Moves the focus to the first list item in a container.
 * Use it for Down in a search field that is not in the same element as the list.
 * Returns true when an item got the focus.
 */
export function focusFirstItem(container: Element | null | undefined): boolean {
    const first = container?.querySelector<HTMLElement>(NAV_ITEM);
    if (!first) return false;
    first.focus();
    first.scrollIntoView({ block: 'nearest' });
    return true;
}
