import { init } from 'ghostty-web';
import type { TerminalSettings } from '@shared/terminal';

let wasmReady: Promise<void> | undefined;

/** Loads the Ghostty WASM module one time. */
function loadWasm(): Promise<void> {
    wasmReady ??= init();
    return wasmReady;
}

/**
 * Prepares the terminal engine and the fonts.
 * The terminal measures the font when it opens, so the font must load first.
 */
export async function prepareTerminal(settings: TerminalSettings): Promise<void> {
    const fonts = [`${settings.fontSize}px ${settings.fontFamily}`, `bold ${settings.fontSize}px ${settings.fontFamily}`];
    await Promise.all([loadWasm(), ...fonts.map(font => document.fonts.load(font).catch(() => undefined))]);
}
