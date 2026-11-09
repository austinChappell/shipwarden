/** The workspace shortcuts, as in Ghostty: tabs, splits, the focus between panes, and close. And ⌘B for the sidebar and ⌘N for a new worktree. */
export type ShortcutAction = 'newTab' | 'close' | 'right' | 'down' | 'next' | 'previous' | 'toggleSidebar' | 'toggleRightPanel' | 'newWorktree';

/**
 * Returns the workspace action of a key: ⌘T (new tab), ⌘W (close the pane, or the tab with one pane),
 * ⌘D (split right), ⇧⌘D (split down), ⌘[ and ⌘] (focus), ⌘B (show or hide the sidebar), ⌥⌘B (show or hide the right panel),
 * ⌘N (open the New worktree dialog). Other keys return undefined.
 */
export function shortcutAction(input: { type: string; meta: boolean; shift: boolean; control: boolean; alt: boolean; key: string; code?: string }): ShortcutAction | undefined {
    if (input.type !== 'keyDown' || !input.meta || input.control) return undefined;
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    if (input.alt) return key === 'b' && !input.shift ? 'toggleRightPanel' : undefined;
    if (key === 'd') return input.shift ? 'down' : 'right';
    if (input.shift) return undefined;
    if (key === 't') return 'newTab';
    if (key === 'w') return 'close';
    if (key === 'b') return 'toggleSidebar';
    if (key === 'n') return 'newWorktree';
    if (input.code === 'BracketLeft' || key === '[') return 'previous';
    if (input.code === 'BracketRight' || key === ']') return 'next';
    return undefined;
}

/** The app keys of the macOS menu that the main process runs itself. */
export type AppKeyAction = 'quit' | 'quitAndStop' | 'settings' | 'hide';

/**
 * Returns the app action of a key: ⌘Q (quit, the agents keep running), ⇧⌥⌘Q (quit and stop all agents),
 * ⌘, (settings) and ⌘H (hide). A focused terminal takes all keys, so the menu does not get these keys. The main
 * process reads them before the page. Other keys return undefined.
 */
export function appKeyAction(input: { type: string; meta: boolean; shift: boolean; control: boolean; alt: boolean; key: string; code?: string }): AppKeyAction | undefined {
    if (input.type !== 'keyDown' || !input.meta || input.control) return undefined;
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    if (key === 'q') {
        if (input.shift && input.alt) return 'quitAndStop';
        return input.shift || input.alt ? undefined : 'quit';
    }
    if (input.shift || input.alt) return undefined;
    if (input.code === 'Comma' || key === ',') return 'settings';
    if (key === 'h') return 'hide';
    return undefined;
}

/** Returns true for ⌘K without other modifier keys. A focused terminal then clears its screen and scrollback. */
export function isClearKey(input: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    return key === 'k' && input.metaKey && !input.ctrlKey && !input.altKey && !input.shiftKey;
}

/** The character that Ctrl+V sends. Claude Code and Codex then read an image from the clipboard. */
export const CTRL_V = '\x16';

/**
 * Returns true for Ctrl+V without other modifier keys.
 * ghostty-web 0.4 sends nothing for Ctrl+V, so the terminal must send the character itself.
 */
export function isCtrlV(input: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    return key === 'v' && input.ctrlKey && !input.metaKey && !input.altKey && !input.shiftKey;
}

/**
 * Returns true for a paste with an image and no text.
 * ghostty-web 0.4 pastes only text, so it ignores this paste. The terminal then sends Ctrl+V.
 * `types` are the types of the clipboard data, for example "text/plain" or "image/png".
 */
export function isImageOnlyPaste(types: readonly string[], text: string): boolean {
    return text.length === 0 && types.some(type => type.startsWith('image/') || type === 'Files');
}
