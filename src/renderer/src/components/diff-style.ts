import { useEffect, useState } from 'react';

export const STYLE_KEY = 'shipwarden.diffStyle';

export type DiffStyle = 'unified' | 'split';

/**
 * Colors of the app theme for the diff. The diff is in a shadow root, but the app variables go into it.
 * The highlight theme sets its background on the element, so these rules need "!important".
 */
export const THEME_CSS = `
:host {
    /* The body sets "user-select: none". The code lines must let the user select and copy text. */
    user-select: text;
    --diffs-dark-bg: var(--bg) !important;
    --diffs-light-bg: var(--bg) !important;
    --diffs-bg-context-override: var(--bg);
    --diffs-bg-context-gutter-override: var(--bg);
    --diffs-bg-separator-override: var(--panel);
    --diffs-bg-buffer-override: var(--panel);
}
[data-line-annotation], [data-gutter-buffer=annotation] {
    --diffs-annotation-bg: var(--bg);
}
/* While ⌘ is down, a name on the new side of the diff shows as a link to its definition. */
:host-context(.goto-armed) [data-additions] [data-char]:hover,
:host-context(.goto-armed) [data-unified] [data-line-type]:not([data-line-type*=deletion]) [data-char]:hover {
    text-decoration: underline;
    cursor: pointer;
}
`;

export function readStyle(): DiffStyle {
    try {
        return localStorage.getItem(STYLE_KEY) === 'split' ? 'split' : 'unified';
    } catch {
        return 'unified';
    }
}

/** The color mode of the app ("light" or "dark"), from the root element. */
export function useColorMode(): 'light' | 'dark' {
    const read = (): 'light' | 'dark' => (document.documentElement.dataset.mode === 'light' ? 'light' : 'dark');
    const [mode, setMode] = useState(read);
    useEffect(() => {
        const observer = new MutationObserver(() => setMode(read()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
        return () => observer.disconnect();
    }, []);
    return mode;
}

/** True while the ⌘ key is down. Always false when `enabled` is false. */
export function useMetaKey(enabled: boolean): boolean {
    const [down, setDown] = useState(false);
    useEffect(() => {
        if (!enabled) return;
        const onKey = (event: KeyboardEvent) => setDown(event.metaKey);
        // The window does not get the key up when it loses the focus.
        const onBlur = () => setDown(false);
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKey);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('keyup', onKey);
            window.removeEventListener('blur', onBlur);
            setDown(false);
        };
    }, [enabled]);
    return down;
}
