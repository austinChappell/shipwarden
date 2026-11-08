/** The workspace shortcuts, as in Ghostty: tabs, splits, the focus between panes, and close. */
export type ShortcutAction = 'newTab' | 'close' | 'right' | 'down' | 'next' | 'previous';

/**
 * Returns the workspace action of a key: ⌘T (new tab), ⌘W (close the pane, or the tab with one pane),
 * ⌘D (split right), ⇧⌘D (split down), ⌘[ and ⌘] (focus). Other keys return undefined.
 */
export function shortcutAction(input: { type: string; meta: boolean; shift: boolean; control: boolean; alt: boolean; key: string; code?: string }): ShortcutAction | undefined {
    if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return undefined;
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    if (key === 'd') return input.shift ? 'down' : 'right';
    if (input.shift) return undefined;
    if (key === 't') return 'newTab';
    if (key === 'w') return 'close';
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
