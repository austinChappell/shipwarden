/**
 * The workspace shortcuts: tabs, splits, the focus between panes and close, as in Ghostty. Also ⌘[ and ⌘] for back and
 * forward, ⌘B for the sidebar, ⇧⌘B for the focus in the sidebar, ⌘E for the right panel, ⌘N for a new worktree and
 * ⇧⌘E for the focus in the file explorer.
 * The tab keys are as in Ghostty: ⌘1 to ⌘8 select a tab, and ⌘9 selects the last tab. ⇧⌘[ and ⇧⌘] select the previous
 * and the next tab. ⌃⇧Tab and ⌃Tab do the same.
 * ⌥⌘1 to ⌥⌘6 open a view: Dashboard, Agents, Tasks, Review, Pipelines and Notes. ⇧⌘0 moves the focus to the workspace.
 * ⌘0 stays the key of the Actual Size menu item.
 */
export type ShortcutAction =
    | 'newTab'
    | 'close'
    | 'right'
    | 'down'
    | 'back'
    | 'forward'
    | 'focusLeft'
    | 'focusRight'
    | 'focusUp'
    | 'focusDown'
    | 'toggleSidebar'
    | 'focusSidebar'
    | 'toggleRightPanel'
    | 'newWorktree'
    | 'focusExplorer'
    | 'focusWorkspace'
    | 'selectTab1'
    | 'selectTab2'
    | 'selectTab3'
    | 'selectTab4'
    | 'selectTab5'
    | 'selectTab6'
    | 'selectTab7'
    | 'selectTab8'
    | 'selectLastTab'
    | 'previousTab'
    | 'nextTab'
    | ViewAction;

/** The actions that open a view of the sidebar (⌥⌘1 to ⌥⌘6). */
export type ViewAction = 'viewDashboard' | 'viewAgents' | 'viewTasks' | 'viewReview' | 'viewPipelines' | 'viewNotes';

const FOCUS_KEYS: Record<string, ShortcutAction> = {
    arrowleft: 'focusLeft',
    arrowright: 'focusRight',
    arrowup: 'focusUp',
    arrowdown: 'focusDown'
};

/** The views of ⌥⌘ and a digit key, by the code of the key. */
const VIEW_KEYS: Record<string, ViewAction> = {
    Digit1: 'viewDashboard',
    Digit2: 'viewAgents',
    Digit3: 'viewTasks',
    Digit4: 'viewReview',
    Digit5: 'viewPipelines',
    Digit6: 'viewNotes'
};

/** The tabs of ⌘ and a digit key, by the digit. ⌘9 selects the last tab, as in Ghostty. */
const TAB_KEYS: Record<string, ShortcutAction> = {
    1: 'selectTab1',
    2: 'selectTab2',
    3: 'selectTab3',
    4: 'selectTab4',
    5: 'selectTab5',
    6: 'selectTab6',
    7: 'selectTab7',
    8: 'selectTab8',
    9: 'selectLastTab'
};

/**
 * Returns the digit of a digit key. The code of the key comes first, because Option and Shift change "key" on macOS.
 * Returns undefined for other keys.
 */
function digitOf(input: { key: string; code?: string }): string | undefined {
    if (input.code) return /^Digit\d$/.test(input.code) ? input.code.slice(5) : undefined;
    return /^\d$/.test(input.key) ? input.key : undefined;
}

/**
 * Returns the workspace action of a key: ⌘T (new tab), ⌘W (close the pane, or the tab with one pane),
 * ⌘D (split right), ⇧⌘D (split down), ⌘[ (back), ⌘] (forward), ⌥⌘ and an arrow key (move the focus to the pane at
 * that side), ⌘B (show or hide the sidebar), ⇧⌘B (move the focus to the sidebar), ⌘E (show or hide the right panel),
 * ⌘N (open the New worktree dialog), ⇧⌘E (move the focus to the file explorer).
 * Also ⌘1 to ⌘8 (select that tab), ⌘9 (select the last tab), ⇧⌘[ and ⌃⇧Tab (select the previous tab), ⇧⌘] and ⌃Tab
 * (select the next tab), ⌥⌘1 to ⌥⌘6 (open a view) and ⇧⌘0 (move the focus to the workspace).
 * Other keys return undefined.
 */
export function shortcutAction(input: {
    type: string;
    meta: boolean;
    shift: boolean;
    control: boolean;
    alt: boolean;
    key: string;
    code?: string;
}): ShortcutAction | undefined {
    if (input.type !== 'keyDown') return undefined;
    // ⌃Tab and ⌃⇧Tab have no ⌘. They are the only workspace keys with Control.
    if (input.control && !input.meta && !input.alt && (input.code === 'Tab' || input.key === 'Tab')) {
        return input.shift ? 'previousTab' : 'nextTab';
    }
    if (!input.meta || input.control) return undefined;
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    const digit = digitOf(input);
    if (input.alt) {
        if (input.shift) return undefined;
        return FOCUS_KEYS[key] ?? (input.code ? VIEW_KEYS[input.code] : undefined);
    }
    if (key === 'd') return input.shift ? 'down' : 'right';
    if (key === 'e') return input.shift ? 'focusExplorer' : 'toggleRightPanel';
    if (key === 'b') return input.shift ? 'focusSidebar' : 'toggleSidebar';
    if (input.shift) {
        // Shift changes "key": ⇧⌘[ sends "{" and ⇧⌘0 sends ")" on a US keyboard. The code stays the same.
        if (input.code === 'BracketLeft' || key === '{') return 'previousTab';
        if (input.code === 'BracketRight' || key === '}') return 'nextTab';
        if (digit === '0') return 'focusWorkspace';
        return undefined;
    }
    if (digit) return TAB_KEYS[digit];
    if (key === 't') return 'newTab';
    if (key === 'w') return 'close';
    if (key === 'n') return 'newWorktree';
    if (input.code === 'BracketLeft' || key === '[') return 'back';
    if (input.code === 'BracketRight' || key === ']') return 'forward';
    return undefined;
}

/**
 * Returns true for ⇧⌘M without other modifier keys. A diff then opens the comment box for the line of the cursor or
 * for the selected lines.
 */
export function isCommentKey(input: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    return key === 'm' && input.metaKey && input.shiftKey && !input.ctrlKey && !input.altKey;
}

/** The app keys of the macOS menu that the main process runs itself. */
export type AppKeyAction = 'quit' | 'quitAndStop' | 'settings' | 'hide';

/**
 * Returns the app action of a key: ⌘Q (quit, the agents keep running), ⇧⌥⌘Q (quit and stop all agents),
 * ⌘, (settings) and ⌘H (hide). A focused terminal takes all keys, so the menu does not get these keys. The main
 * process reads them before the page. Other keys return undefined.
 */
export function appKeyAction(input: {
    type: string;
    meta: boolean;
    shift: boolean;
    control: boolean;
    alt: boolean;
    key: string;
    code?: string;
}): AppKeyAction | undefined {
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

/**
 * Returns the step of a pending-comment key in the changed files of a pull request:
 * 1 for N (the next comment) and -1 for P (the previous comment). Keys with ⌘, Ctrl, Alt or Shift return undefined.
 */
export function pendingCommentStep(input: {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}): 1 | -1 | undefined {
    if (input.metaKey || input.ctrlKey || input.altKey || input.shiftKey) return undefined;
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    if (key === 'n') return 1;
    if (key === 'p') return -1;
    return undefined;
}
