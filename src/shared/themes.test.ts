import { describe, expect, it } from 'vitest';
import { activePalette, cssVariables, DEFAULT_APPEARANCE, normalizeAppearance, THEMES } from './themes';

/** The relative luminance of a color, as WCAG defines it. */
function luminance(hex: string): number {
    const channel = (offset: number) => {
        const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

describe('themes', () => {
    it('have readable text in each mode', () => {
        for (const theme of THEMES) {
            for (const mode of ['light', 'dark'] as const) {
                const palette = theme[mode];
                const where = `${theme.name} ${mode}`;
                expect(contrast(palette.text, palette.bg), `${where} text`).toBeGreaterThanOrEqual(7);
                expect(contrast(palette.textStrong, palette.panel), `${where} strong text`).toBeGreaterThanOrEqual(7);
                expect(contrast(palette.muted, palette.panel), `${where} muted text`).toBeGreaterThanOrEqual(3.5);
                expect(contrast(palette.accent, palette.bg), `${where} accent`).toBeGreaterThanOrEqual(3.5);
            }
        }
    });

    it('have unique IDs', () => {
        expect(new Set(THEMES.map(theme => theme.id)).size).toBe(THEMES.length);
    });
});

describe('appearance', () => {
    it('replaces unknown values with defaults', () => {
        expect(normalizeAppearance({ scheme: 'neon', lightTheme: 'nope', darkTheme: 'nightwatch', terminalColors: 'x' }))
            .toEqual({ ...DEFAULT_APPEARANCE, darkTheme: 'nightwatch' });
        expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    });

    it('converts the theme IDs of the first versions', () => {
        expect(normalizeAppearance({ lightTheme: 'junction', darkTheme: 'caboose' })).toMatchObject({ lightTheme: 'starboard', darkTheme: 'flare' });
    });

    it('uses the light or the dark theme for the active mode', () => {
        const appearance = { ...DEFAULT_APPEARANCE, scheme: 'system' as const, lightTheme: 'starboard', darkTheme: 'nightwatch' };
        expect(activePalette(appearance, true)).toEqual({ mode: 'dark', palette: THEMES.find(theme => theme.id === 'nightwatch')!.dark });
        expect(activePalette(appearance, false)).toEqual({ mode: 'light', palette: THEMES.find(theme => theme.id === 'starboard')!.light });
        expect(activePalette({ ...appearance, scheme: 'light' }, true).mode).toBe('light');
    });

    it('names the CSS variables in kebab case', () => {
        expect(cssVariables(THEMES[0].dark)['--text-strong']).toBe('#e6e1cf');
    });
});
