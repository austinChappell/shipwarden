import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The container in the bottom-right corner. It is outside the React root, so App.tsx and main.tsx can both use it. */
let host: HTMLElement | undefined;

function cornerHost(): HTMLElement {
    if (!host) {
        host = document.createElement('div');
        host.className = 'corner-notices';
        document.body.appendChild(host);
    }
    return host;
}

/**
 * Puts a notice in the bottom-right corner of the window. The notices stack in a column, so two notices never cover
 * each other. The CSS `order` of a notice sets its place: the update notice is at the bottom, and the tip is above it.
 */
export function CornerNotice({ children }: { children: ReactNode }) {
    return createPortal(children, cornerHost());
}
