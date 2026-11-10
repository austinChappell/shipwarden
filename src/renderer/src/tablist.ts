import type { KeyboardEvent } from 'react';

/**
 * Moves the focus between the tabs of a tab list. ← and → move the focus to the previous and the next tab.
 * Home and End move the focus to the first and the last tab. The keys work only on the tab itself, without modifier
 * keys. Returns the tab that gets the focus, else undefined.
 */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>): HTMLElement | undefined {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
    const tab = event.currentTarget;
    if (event.target !== tab) return undefined;
    const list = tab.closest('[role="tablist"]');
    if (!list) return undefined;
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
    const index = tabs.indexOf(tab);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return undefined;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return next;
}
