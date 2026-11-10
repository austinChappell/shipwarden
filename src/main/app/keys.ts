import type { AppKeyAction } from '@shared/shortcuts';

/** The fields of a key event that the key functions read. Electron.Input has these fields. */
export interface KeyInput {
    type: string;
    meta: boolean;
    shift: boolean;
    control: boolean;
    alt: boolean;
    key: string;
    code?: string;
}

/** An action of a key in a browser view of the in-app browser. */
export type BrowserViewKey = 'reload' | 'focusAddress' | 'devTools';

/**
 * Returns the action of a browser view key, or undefined for other keys.
 * ⌘R loads the page again, ⌘L selects the address bar and ⌥⌘I opens the developer tools of the page.
 */
export function browserViewKey(input: KeyInput): BrowserViewKey | undefined {
    if (input.type !== 'keyDown' || !input.meta || input.control) return undefined;
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    if (key === 'r' && !input.shift && !input.alt) return 'reload';
    if (key === 'l' && !input.shift && !input.alt) return 'focusAddress';
    if (key === 'i' && input.alt && !input.shift) return 'devTools';
    return undefined;
}

/** Returns true when the value is an app key action. The page can send any value, so the main process checks it. */
export function isAppKeyAction(value: unknown): value is AppKeyAction {
    return value === 'quit' || value === 'quitAndStop' || value === 'settings' || value === 'checkForUpdates' || value === 'hide';
}
