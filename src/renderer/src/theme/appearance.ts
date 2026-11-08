import { useEffect, useState } from 'react';
import { activePalette, cssVariables, DEFAULT_APPEARANCE, type Appearance, type Mode, type Palette } from '@shared/themes';
import { applyEditorTheme } from '../editor/monaco';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
/** The last palette. The app shows it at once at the next start, before the settings load. */
const LAST_PALETTE_KEY = 'shipwarden.lastPalette';

function setVariables(palette: Palette, mode: Mode): void {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(cssVariables(palette))) {
        root.style.setProperty(name, value);
    }
    root.dataset.mode = mode;
}

function readLastPalette(): { palette: Palette; mode: Mode } | undefined {
    try {
        const saved = JSON.parse(localStorage.getItem(LAST_PALETTE_KEY) ?? 'null') as { palette?: Palette; mode?: Mode } | null;
        return saved?.palette && (saved.mode === 'light' || saved.mode === 'dark') ? { palette: saved.palette, mode: saved.mode } : undefined;
    } catch {
        return undefined;
    }
}

/** Shows the last palette before the first render, so a light theme does not start dark for a moment. */
export function applyLastPalette(): void {
    const saved = readLastPalette();
    if (saved) {
        setVariables(saved.palette, saved.mode);
        applyEditorTheme(saved.palette, saved.mode);
    }
}

/** Sets the CSS variables, the color-scheme and the editor theme for a palette. */
function apply(palette: Palette, mode: Mode): void {
    setVariables(palette, mode);
    applyEditorTheme(palette, mode);
    try {
        localStorage.setItem(LAST_PALETTE_KEY, JSON.stringify({ palette, mode }));
    } catch {
        // The next start shows the default palette for a moment.
    }
}

/**
 * Applies the appearance and returns the active mode and palette.
 * With the scheme "system", the app changes when macOS changes between light and dark.
 * Before the settings load, `appearance` is undefined. The hook then keeps the palette of the last start.
 */
export function useAppearance(appearance: Appearance | undefined): { mode: Mode; palette: Palette } {
    const [systemDark, setSystemDark] = useState(darkQuery.matches);

    useEffect(() => {
        const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
        darkQuery.addEventListener('change', onChange);
        return () => darkQuery.removeEventListener('change', onChange);
    }, []);

    const active = appearance ? activePalette(appearance, systemDark) : readLastPalette() ?? activePalette(DEFAULT_APPEARANCE, systemDark);
    useEffect(() => {
        if (appearance) {
            apply(active.palette, active.mode);
        }
    }, [appearance, active.palette, active.mode]);
    return active;
}
