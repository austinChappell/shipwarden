import { Ghostty } from 'ghostty-web';
import type { TerminalSettings } from '@shared/terminal';

/**
 * Loads a new Ghostty WASM instance with its own memory. Each terminal gets one.
 * ghostty-web 0.4 does not clear WASM memory that it frees and uses again. With one shared instance, a new terminal
 * can show text and wrong characters of a closed terminal (also at a different width). A terminal with its own
 * instance can show only its own memory. The instance goes away with the terminal.
 */
export function loadGhostty(): Promise<Ghostty> {
    return Ghostty.load();
}

/**
 * Prepares the fonts of the terminal.
 * The terminal measures the font when it opens, so the font must load first.
 */
export async function prepareFonts(settings: TerminalSettings): Promise<void> {
    const fonts = [`${settings.fontSize}px ${settings.fontFamily}`, `bold ${settings.fontSize}px ${settings.fontFamily}`];
    await Promise.all(fonts.map(font => document.fonts.load(font).catch(() => undefined)));
}
