/** The colors of one theme in one mode. Each color becomes a CSS variable, for example `bg` becomes `--bg`. */
export interface Palette {
    bg: string;
    panel: string;
    raised: string;
    hover: string;
    selected: string;
    border: string;
    text: string;
    textStrong: string;
    muted: string;
    accent: string;
    ok: string;
    danger: string;
    info: string;
    purple: string;
}

export type Mode = 'light' | 'dark';
export type ColorScheme = 'system' | Mode;

export interface Theme {
    id: string;
    name: string;
    light: Palette;
    dark: Palette;
}

/** The themes. The first theme is the default in both modes. */
export const THEMES: readonly Theme[] = [
    {
        id: 'beacon',
        name: 'Beacon',
        dark: {
            bg: '#0b0e14',
            panel: '#0d1017',
            raised: '#131721',
            hover: '#161b25',
            selected: '#1a2130',
            border: '#1c212b',
            text: '#bfbdb6',
            textStrong: '#e6e1cf',
            muted: '#6c7380',
            accent: '#e6b450',
            ok: '#7fd962',
            danger: '#f07178',
            info: '#59c2ff',
            purple: '#d2a6ff'
        },
        light: {
            bg: '#fbf8f1',
            panel: '#f4efe4',
            raised: '#fffdf8',
            hover: '#ece5d6',
            selected: '#e6dcc6',
            border: '#e0d7c3',
            text: '#4a4237',
            textStrong: '#2a241b',
            muted: '#857a69',
            accent: '#b0731a',
            ok: '#4f8a2f',
            danger: '#c4453c',
            info: '#2f7bbf',
            purple: '#8a5cc4'
        }
    },
    {
        id: 'starboard',
        name: 'Starboard',
        dark: {
            bg: '#0f1110',
            panel: '#111413',
            raised: '#171b1a',
            hover: '#1c201f',
            selected: '#222826',
            border: '#242826',
            text: '#c3c9c6',
            textStrong: '#e9edeb',
            muted: '#747a77',
            accent: '#5fc28a',
            ok: '#8bd46a',
            danger: '#f0767a',
            info: '#5bb8d8',
            purple: '#b79cf0'
        },
        light: {
            bg: '#f5f9f6',
            panel: '#ebf3ee',
            raised: '#fbfdfc',
            hover: '#e0ebe4',
            selected: '#d3e6da',
            border: '#d5e3da',
            text: '#34463d',
            textStrong: '#1c2a23',
            muted: '#6d8076',
            accent: '#2a8655',
            ok: '#3f8a2a',
            danger: '#c4453c',
            info: '#2a7fa8',
            purple: '#7a55b8'
        }
    },
    {
        id: 'harbor',
        name: 'Harbor',
        dark: {
            bg: '#0b0f17',
            panel: '#0d121b',
            raised: '#121927',
            hover: '#161e2d',
            selected: '#1a2438',
            border: '#1d2638',
            text: '#bcc6d8',
            textStrong: '#e3e9f5',
            muted: '#6a768c',
            accent: '#5aa9f5',
            ok: '#7fd18a',
            danger: '#f07a86',
            info: '#7cc4ff',
            purple: '#b39cf5'
        },
        light: {
            bg: '#f5f8fc',
            panel: '#eaf0f8',
            raised: '#fcfdff',
            hover: '#dfe8f4',
            selected: '#d2e0f2',
            border: '#d4deec',
            text: '#35435a',
            textStrong: '#1b2537',
            muted: '#6c7a94',
            accent: '#2a6dc2',
            ok: '#3a8a3f',
            danger: '#c94452',
            info: '#1f7fbf',
            purple: '#6d55c0'
        }
    },
    {
        id: 'flare',
        name: 'Flare',
        dark: {
            bg: '#0f0e0d',
            panel: '#12100f',
            raised: '#191716',
            hover: '#1e1b1a',
            selected: '#262220',
            border: '#252120',
            text: '#cbc6c3',
            textStrong: '#ece7e5',
            muted: '#807977',
            accent: '#e5734f',
            ok: '#9ccf6a',
            danger: '#f2667a',
            info: '#6cb4d9',
            purple: '#c9a0e8'
        },
        light: {
            bg: '#fcf7f5',
            panel: '#f6ece8',
            raised: '#fffcfb',
            hover: '#efe1db',
            selected: '#ead3ca',
            border: '#e8d9d2',
            text: '#4d3a33',
            textStrong: '#2b1c16',
            muted: '#8c746b',
            accent: '#bb4e2b',
            ok: '#4a8a2e',
            danger: '#c23b4f',
            info: '#2c7aa8',
            purple: '#8d56b0'
        }
    },
    {
        id: 'anchor',
        name: 'Anchor',
        dark: {
            bg: '#0e0f11',
            panel: '#111214',
            raised: '#17191c',
            hover: '#1c1e22',
            selected: '#23262b',
            border: '#24272c',
            text: '#c4c7cc',
            textStrong: '#eceef1',
            muted: '#747a83',
            accent: '#9fb4c8',
            ok: '#86c97a',
            danger: '#ec7a7a',
            info: '#7fb3e0',
            purple: '#b5a2e3'
        },
        light: {
            bg: '#f7f7f8',
            panel: '#eeeff1',
            raised: '#ffffff',
            hover: '#e5e7ea',
            selected: '#dcdfe4',
            border: '#dfe1e5',
            text: '#3c4047',
            textStrong: '#1d2025',
            muted: '#757b84',
            accent: '#46658a',
            ok: '#3f8a3a',
            danger: '#c4424a',
            info: '#2b74b5',
            purple: '#6f58b5'
        }
    },
    {
        id: 'nightwatch',
        name: 'Nightwatch',
        dark: {
            bg: '#110d16',
            panel: '#140f1a',
            raised: '#1b1523',
            hover: '#211a2b',
            selected: '#2a2036',
            border: '#281f33',
            text: '#cfc3dc',
            textStrong: '#f0e8f8',
            muted: '#857a94',
            accent: '#c78bf0',
            ok: '#8fd48a',
            danger: '#f27a9a',
            info: '#8ab4f8',
            purple: '#e08ad8'
        },
        light: {
            bg: '#fbf7fd',
            panel: '#f3ebf7',
            raised: '#fffcff',
            hover: '#ebdff1',
            selected: '#e2d0ec',
            border: '#e4d8eb',
            text: '#47394f',
            textStrong: '#261a2e',
            muted: '#85768f',
            accent: '#9248c9',
            ok: '#44873a',
            danger: '#c33f6a',
            info: '#3b6fc4',
            purple: '#b04aa6'
        }
    }
];

export interface Appearance {
    scheme: ColorScheme;
    /** The theme in light mode. */
    lightTheme: string;
    /** The theme in dark mode. */
    darkTheme: string;
    /** "ghostty" keeps the colors of the Ghostty config. "theme" uses the colors of the ShipWarden theme. */
    terminalColors: 'ghostty' | 'theme';
}

export const DEFAULT_APPEARANCE: Appearance = { scheme: 'dark', lightTheme: 'beacon', darkTheme: 'beacon', terminalColors: 'ghostty' };

/** The theme IDs of the first versions (when the app was ShipWarden), and the theme that replaces each. */
const RENAMED_THEMES: Record<string, string> = {
    lantern: 'beacon',
    junction: 'starboard',
    nightline: 'harbor',
    caboose: 'flare',
    steel: 'anchor',
    dusk: 'nightwatch'
};

/** Converts an old theme ID to its new ID. Other IDs do not change. */
export function currentThemeId(id: string): string {
    return RENAMED_THEMES[id] ?? id;
}

export function themeById(id: string): Theme {
    const current = currentThemeId(id);
    return THEMES.find(theme => theme.id === current) ?? THEMES[0];
}

/** Converts stored values to a valid appearance. An unknown theme or scheme gets its default. */
export function normalizeAppearance(value: unknown): Appearance {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const known = (id: unknown, fallback: string) =>
        typeof id === 'string' && THEMES.some(theme => theme.id === currentThemeId(id)) ? currentThemeId(id) : fallback;
    return {
        scheme: raw.scheme === 'system' || raw.scheme === 'light' || raw.scheme === 'dark' ? raw.scheme : DEFAULT_APPEARANCE.scheme,
        lightTheme: known(raw.lightTheme, DEFAULT_APPEARANCE.lightTheme),
        darkTheme: known(raw.darkTheme, DEFAULT_APPEARANCE.darkTheme),
        terminalColors: raw.terminalColors === 'theme' ? 'theme' : 'ghostty'
    };
}

/** Returns the mode that applies now. "system" follows macOS. */
export function activeMode(scheme: ColorScheme, systemDark: boolean): Mode {
    return scheme === 'system' ? (systemDark ? 'dark' : 'light') : scheme;
}

/** Returns the palette that applies now. */
export function activePalette(appearance: Appearance, systemDark: boolean): { mode: Mode; palette: Palette } {
    const mode = activeMode(appearance.scheme, systemDark);
    return { mode, palette: themeById(mode === 'dark' ? appearance.darkTheme : appearance.lightTheme)[mode] };
}

/** The CSS variable of each palette color. */
export function cssVariables(palette: Palette): Record<string, string> {
    return Object.fromEntries(Object.entries(palette).map(([key, value]) => [`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value]));
}

/**
 * A soft radial gradient that shows the character of a palette, for the theme picker.
 * The glows are partly transparent, so the light swatch stays pale and the dark swatch stays dark.
 */
export function swatchGradient(palette: Palette, mode: Mode): string {
    const strength = mode === 'dark' ? [85, 45] : [70, 35];
    return [
        `radial-gradient(circle at 70% 28%, color-mix(in srgb, ${palette.accent} ${strength[0]}%, transparent) 0%, transparent 52%)`,
        `radial-gradient(circle at 26% 80%, color-mix(in srgb, ${palette.info} ${strength[1]}%, transparent) 0%, transparent 55%)`,
        `linear-gradient(155deg, ${palette.raised} 0%, ${mode === 'dark' ? palette.bg : palette.selected} 100%)`
    ].join(', ');
}

/** ANSI colors for a terminal that matches the theme. The 16 colors depend only on the mode. */
export function terminalTheme(palette: Palette, mode: Mode): Record<string, string> {
    const ansi =
        mode === 'dark'
            ? [
                  '#1b1f27',
                  '#f07178',
                  '#aad94c',
                  '#e6b450',
                  '#59c2ff',
                  '#d2a6ff',
                  '#95e6cb',
                  '#c7c7c7',
                  '#686868',
                  '#f07178',
                  '#aad94c',
                  '#ffb454',
                  '#73b8ff',
                  '#d2a6ff',
                  '#95e6cb',
                  '#ffffff'
              ]
            : [
                  '#3b3f45',
                  '#c4453c',
                  '#4f8a2f',
                  '#a96a12',
                  '#2f6fb0',
                  '#8a4fc0',
                  '#2a8a80',
                  '#a0a4ab',
                  '#6c7179',
                  '#d4554a',
                  '#5a9a38',
                  '#b8791f',
                  '#3b7ec4',
                  '#9a5cd0',
                  '#339a8f',
                  '#cfd2d7'
              ];
    const names = [
        'black',
        'red',
        'green',
        'yellow',
        'blue',
        'magenta',
        'cyan',
        'white',
        'brightBlack',
        'brightRed',
        'brightGreen',
        'brightYellow',
        'brightBlue',
        'brightMagenta',
        'brightCyan',
        'brightWhite'
    ];
    return {
        ...Object.fromEntries(names.map((name, index) => [name, ansi[index]])),
        background: palette.bg,
        foreground: palette.text,
        cursor: palette.accent,
        cursorAccent: palette.bg,
        selectionBackground: mode === 'dark' ? '#2a3a55' : '#cfe0f5',
        selectionForeground: palette.textStrong
    };
}
