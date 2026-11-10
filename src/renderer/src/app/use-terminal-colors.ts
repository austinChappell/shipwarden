import { useMemo, useRef } from 'react';
import type { TerminalSettings } from '@shared/terminal';
import { terminalTheme } from '@shared/themes';
import { terminalPool } from '../terminal/terminal-pool';

/**
 * Returns the terminal settings with the colors of the theme, when the user selected "Match theme".
 * `colorsKey` changes when the terminal colors change. The terminal view then opens again with the new colors.
 */
export function useTerminalColors(
    settings: TerminalSettings | undefined,
    matchTheme: boolean,
    palette: Parameters<typeof terminalTheme>[0],
    mode: Parameters<typeof terminalTheme>[1]
) {
    const terminalSettings = useMemo(
        () => (settings && matchTheme ? { ...settings, colors: { ...settings.colors, ...terminalTheme(palette, mode) } } : settings),
        [settings, matchTheme, palette, mode]
    );
    const colorsKey = useMemo(() => JSON.stringify(terminalSettings?.colors ?? {}), [terminalSettings]);
    const shownColorsKey = useRef(colorsKey);
    if (shownColorsKey.current !== colorsKey) {
        // Close the old views before the new view attaches in this render.
        if (shownColorsKey.current !== '{}') {
            terminalPool.resetAll();
        }
        shownColorsKey.current = colorsKey;
    }
    return { terminalSettings, colorsKey };
}
