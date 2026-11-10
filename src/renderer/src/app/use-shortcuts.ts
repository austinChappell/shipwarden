import { useEffect, useRef } from 'react';
import { shortcutAction, type ShortcutAction } from '@shared/shortcuts';
import { dialogOpen } from '../components/ConfirmDialog';

const api = window.shipwarden;

/**
 * Sends the workspace shortcuts to `handler`. The main process sends them, and the page also reads the same keys.
 * Escape in the sidebar calls `focusWorkspace`. The newest functions of each render get the events.
 */
export function useShortcuts(handler: (action: ShortcutAction) => Promise<void>, focusWorkspace: () => void) {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    const focusWorkspaceRef = useRef(focusWorkspace);
    focusWorkspaceRef.current = focusWorkspace;

    // Escape in the sidebar moves the focus back to the workspace. Escape in a field or in an open menu does not.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const target = event.target instanceof HTMLElement ? event.target : undefined;
            const sidebar = target?.closest('aside.sidebar');
            if (!target || !sidebar || dialogOpen()) return;
            if (target.matches('input, textarea, select, [contenteditable="true"]') || sidebar.querySelector('[role="menu"]')) return;
            event.preventDefault();
            focusWorkspaceRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => api.app.onShortcut(action => void handlerRef.current(action)), []);
    // The same keys in the page, in the capture phase, before a terminal or an editor gets them. The main process
    // normally takes these keys first (before-input-event). This is the second way, when it does not.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const action = shortcutAction({ type: 'keyDown', meta: event.metaKey, shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, key: event.key, code: event.code });
            if (action) {
                event.preventDefault();
                event.stopPropagation();
                void handlerRef.current(action);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);
}
