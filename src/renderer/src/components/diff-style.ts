import { useEffect, useState } from 'react';
import { registerCustomTheme, resolveTheme } from '@pierre/diffs';

export const STYLE_KEY = 'shipwarden.diffStyle';

/**
 * Registers a copy of a Pierre theme with two changes. Without them, some code looks like a comment.
 *
 * 1. The JSX text gets the normal text color. In the TSX grammar, the "meta.tag" scope covers all of an element,
 *    also its children. The Pierre theme makes "meta.tag" gray, darker than a comment.
 * 2. The JS and TS parameters get the variable color. The Pierre theme makes all parameters light gray. Its rule for
 *    JS parameters uses "variable.parameter.function.js", but the JS and TS grammars give "variable.parameter.<lang>".
 */
function registerDiffTheme(name: string, base: string): void {
    registerCustomTheme(name, async () => {
        const theme = (await resolveTheme(base)).textmate;
        if (!theme) throw new Error(`The theme "${base}" has no TextMate syntax colors.`);
        const baseRules = theme.tokenColors ?? theme.settings ?? [];
        const variable = baseRules.find(rule => [rule.scope ?? []].flat().includes('variable.other.readwrite'))?.settings.foreground ?? theme.fg;
        const rules = [
            ...baseRules,
            { scope: ['meta.jsx.children'], settings: { foreground: theme.fg } },
            {
                scope: ['variable.parameter.js', 'variable.parameter.jsx', 'variable.parameter.ts', 'variable.parameter.tsx'],
                settings: { foreground: variable }
            }
        ];
        return { ...theme, name, settings: rules, tokenColors: rules };
    });
}

registerDiffTheme('shipwarden-dark', 'pierre-dark');
registerDiffTheme('shipwarden-light', 'pierre-light');

/** The syntax theme of the diffs for each color mode. */
export const DIFF_THEME = { dark: 'shipwarden-dark', light: 'shipwarden-light' } as const;

export type DiffStyle = 'unified' | 'split';

/**
 * Colors of the app theme for the diff. The diff is in a shadow root, but the app variables go into it.
 * The highlight theme sets its background on the element, so these rules need "!important".
 */
export const THEME_CSS = `
:host {
    /* The user can select and copy the code lines. */
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

function readColorMode(): 'light' | 'dark' {
    return document.documentElement.dataset.mode === 'light' ? 'light' : 'dark';
}

/** The color mode of the app ("light" or "dark"), from the root element. */
export function useColorMode(): 'light' | 'dark' {
    const [mode, setMode] = useState(readColorMode);
    useEffect(() => {
        const observer = new MutationObserver(() => setMode(readColorMode()));
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
