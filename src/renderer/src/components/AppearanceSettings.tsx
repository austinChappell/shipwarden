import { useEffect, useRef, type CSSProperties } from 'react';
import { Moon, Sun } from 'lucide-react';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Button, ButtonGroup } from './ui';
import { swatchGradient, themeById, THEMES, type Appearance, type ColorScheme, type Mode, type Palette } from '@shared/themes';

interface Props {
    appearance: Appearance;
    /** The mode that applies now. With the scheme "system", it follows macOS. */
    mode: Mode;
    onChange(appearance: Appearance): void;
}

/** A small picture of the app in a palette: the sidebar, two text lines, a card with status dots and the input bar. */
function MiniWindow({ palette }: { palette: Palette }) {
    return (
        <div className="mini-window" style={{ background: palette.bg, borderColor: palette.border }}>
            <div className="mini-sidebar" style={{ background: palette.panel, borderColor: palette.border }}>
                <span style={{ background: palette.raised, borderColor: palette.border }} />
                <span style={{ background: palette.selected }} />
                <span style={{ background: palette.hover }} />
            </div>
            <div className="mini-main">
                <span className="mini-pill" style={{ background: palette.accent }} />
                <span className="mini-line" style={{ background: palette.border }} />
                <span className="mini-line short" style={{ background: palette.border }} />
                <div className="mini-card" style={{ background: palette.raised, borderColor: palette.border }}>
                    {[palette.ok, palette.accent, palette.danger].map(color => (
                        <span key={color}>
                            <i style={{ background: color }} />
                            <b style={{ background: palette.border }} />
                        </span>
                    ))}
                </div>
                <div className="mini-input" style={{ background: palette.raised, borderColor: palette.border }}>
                    <b style={{ background: palette.border }} />
                    <i style={{ background: palette.accent }} />
                </div>
            </div>
        </div>
    );
}

const SCHEMES: { id: ColorScheme; label: string }[] = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' }
];

/**
 * The appearance settings: the color scheme, a theme for light mode and a theme for dark mode, and the terminal colors.
 * Each change applies at once.
 */
export function AppearanceSettings({ appearance, mode, onChange }: Props) {
    const light = themeById(appearance.lightTheme).light;
    const dark = themeById(appearance.darkTheme).dark;
    /**
     * The newest appearance, also before the saved settings come back. Two fast clicks then both apply,
     * and the second click does not send old values from before the first click.
     */
    const latest = useRef(appearance);
    useEffect(() => {
        latest.current = appearance;
    }, [appearance]);
    const set = (change: Partial<Appearance>) => {
        latest.current = { ...latest.current, ...change };
        onChange(latest.current);
    };

    /** Selects a theme for one mode. The color scheme does not change. The scheme cards show the new theme in their preview. */
    const pick = (themeId: string, swatchMode: Mode) => set(swatchMode === 'light' ? { lightTheme: themeId } : { darkTheme: themeId });

    return (
        <>
            <SettingsGroup title="Color scheme" description="System follows the light and dark setting of macOS.">
                <div className="scheme-grid">
                    {SCHEMES.map(scheme => (
                        <button
                            key={scheme.id}
                            className={`scheme-card${appearance.scheme === scheme.id ? ' selected' : ''}`}
                            onClick={() => set({ scheme: scheme.id })}
                        >
                            <div className="scheme-preview">
                                {scheme.id === 'system' ? (
                                    <>
                                        <MiniWindow palette={light} />
                                        <div className="scheme-split">
                                            <MiniWindow palette={dark} />
                                        </div>
                                    </>
                                ) : (
                                    <MiniWindow palette={scheme.id === 'light' ? light : dark} />
                                )}
                            </div>
                            <span>{scheme.label}</span>
                        </button>
                    ))}
                </div>
            </SettingsGroup>

            <SettingsGroup
                title="Themes"
                description={
                    <>
                        Select a theme for light mode (<Sun size={11} strokeWidth={2} />) and one for dark mode (<Moon size={11} strokeWidth={2} />
                        ). Click a name to use the theme in both modes.
                    </>
                }
            >
                <div className="theme-grid">
                    {THEMES.map(theme => {
                        const lightSelected = appearance.lightTheme === theme.id;
                        const darkSelected = appearance.darkTheme === theme.id;
                        const active = (mode === 'light' && lightSelected) || (mode === 'dark' && darkSelected);
                        return (
                            <div key={theme.id} className={`theme-card${active ? ' active' : ''}`}>
                                <div className="theme-swatches">
                                    {(['light', 'dark'] as const).map(swatchMode => {
                                        const selected = swatchMode === 'light' ? lightSelected : darkSelected;
                                        const Badge = swatchMode === 'light' ? Sun : Moon;
                                        return (
                                            <button
                                                key={swatchMode}
                                                className={`theme-swatch${selected ? ' selected' : ''}`}
                                                style={
                                                    {
                                                        '--swatch': swatchGradient(theme[swatchMode], swatchMode),
                                                        '--ring': theme[swatchMode].accent
                                                    } as CSSProperties
                                                }
                                                title={`${theme.name}, ${swatchMode} mode`}
                                                aria-pressed={selected}
                                                onClick={() => pick(theme.id, swatchMode)}
                                            >
                                                {selected && (
                                                    <span className="theme-badge">
                                                        <Badge size={10} strokeWidth={2.2} />
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                                <button
                                    className="theme-name"
                                    title={`Use ${theme.name} in light and dark mode`}
                                    onClick={() => set({ lightTheme: theme.id, darkTheme: theme.id })}
                                >
                                    {theme.name}
                                </button>
                            </div>
                        );
                    })}
                </div>
            </SettingsGroup>

            <SettingsGroup title="Terminal" card>
                <SettingsRow
                    label="Terminal colors"
                    description={
                        appearance.terminalColors === 'ghostty'
                            ? 'The colors of your Ghostty config. With a dark Ghostty theme, terminals stay dark in a light theme.'
                            : 'The background and text colors of the theme, with ANSI colors for light or dark mode. Open terminals draw again, and their programs continue to run.'
                    }
                    control={
                        <ButtonGroup label="Terminal colors">
                            <Button aria-pressed={appearance.terminalColors === 'ghostty'} onClick={() => set({ terminalColors: 'ghostty' })}>
                                Ghostty config
                            </Button>
                            <Button aria-pressed={appearance.terminalColors === 'theme'} onClick={() => set({ terminalColors: 'theme' })}>
                                Match theme
                            </Button>
                        </ButtonGroup>
                    }
                />
            </SettingsGroup>
        </>
    );
}
