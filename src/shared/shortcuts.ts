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

/** The actions that open a view of the sidebar (⌥⌘1 to ⌥⌘7). */
export type ViewAction = 'viewDashboard' | 'viewAgents' | 'viewTasks' | 'viewReview' | 'viewPipelines' | 'viewNotes' | 'viewAutomations';

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
    Digit6: 'viewNotes',
    Digit7: 'viewAutomations'
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

/** The keys of the header of a pull request in the Review view. */
export type PullRequestKeyAction = 'openWorktree' | 'openOnHost';

/**
 * Returns the action of a key in the header of a pull request: ⌘O (open the worktree of the head branch) and ⇧⌘O (open
 * the pull request on the host). Other keys return undefined.
 */
export function pullRequestKeyAction(input: {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}): PullRequestKeyAction | undefined {
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    if (key !== 'o' || !input.metaKey || input.ctrlKey || input.altKey) return undefined;
    return input.shiftKey ? 'openOnHost' : 'openWorktree';
}

/** The app keys of the macOS menu that the main process runs itself. */
export type AppKeyAction = 'quit' | 'quitAndStop' | 'settings' | 'checkForUpdates' | 'hide';

/**
 * Returns the app action of a key: ⌘Q (quit, the agents keep running), ⇧⌥⌘Q (quit and stop all agents),
 * ⌘, (settings), ⇧⌘U (check for updates) and ⌘H (hide). A focused terminal takes all keys, so the menu does not get these keys. The main
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
    if (key === 'u') return input.shift && !input.alt ? 'checkForUpdates' : undefined;
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

/** The sequence that Shift+Tab sends (back tab). Claude Code then changes its mode. */
export const BACK_TAB = '\x1b[Z';

/**
 * Returns true for Shift+Tab without other modifier keys.
 * ghostty-web 0.4 sends a plain Tab for Shift+Tab, so the terminal must send the back-tab sequence itself.
 */
export function isShiftTab(input: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
    return (input.code === 'Tab' || input.key === 'Tab') && input.shiftKey && !input.metaKey && !input.ctrlKey && !input.altKey;
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

/** The groups of the Keyboard Shortcuts page, in the order of the page. */
export const SHORTCUT_GROUPS = ['Worktrees and tabs', 'Splits', 'Views', 'Panels and focus', 'History', 'App', 'Terminal and review'] as const;

export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

/** The text of a shortcut on the Keyboard Shortcuts page. `keys` has one or more key combinations, for example "⇧⌘D". */
export interface ShortcutInfo {
    label: string;
    keys: readonly string[];
    group: ShortcutGroup;
}

/**
 * The text of each workspace shortcut. The type needs an entry for each action, and a test checks that each key
 * combination gives its action in `shortcutAction`. So the Keyboard Shortcuts page cannot get out of date.
 */
export const SHORTCUT_INFO: Record<ShortcutAction, ShortcutInfo> = {
    newWorktree: { label: 'New worktree', keys: ['⌘N'], group: 'Worktrees and tabs' },
    newTab: { label: 'New shell tab', keys: ['⌘T'], group: 'Worktrees and tabs' },
    close: { label: 'Close the pane, or the tab with one pane', keys: ['⌘W'], group: 'Worktrees and tabs' },
    selectTab1: { label: 'Select tab 1', keys: ['⌘1'], group: 'Worktrees and tabs' },
    selectTab2: { label: 'Select tab 2', keys: ['⌘2'], group: 'Worktrees and tabs' },
    selectTab3: { label: 'Select tab 3', keys: ['⌘3'], group: 'Worktrees and tabs' },
    selectTab4: { label: 'Select tab 4', keys: ['⌘4'], group: 'Worktrees and tabs' },
    selectTab5: { label: 'Select tab 5', keys: ['⌘5'], group: 'Worktrees and tabs' },
    selectTab6: { label: 'Select tab 6', keys: ['⌘6'], group: 'Worktrees and tabs' },
    selectTab7: { label: 'Select tab 7', keys: ['⌘7'], group: 'Worktrees and tabs' },
    selectTab8: { label: 'Select tab 8', keys: ['⌘8'], group: 'Worktrees and tabs' },
    selectLastTab: { label: 'Select the last tab', keys: ['⌘9'], group: 'Worktrees and tabs' },
    previousTab: { label: 'Select the previous tab', keys: ['⇧⌘[', '⌃⇧Tab'], group: 'Worktrees and tabs' },
    nextTab: { label: 'Select the next tab', keys: ['⇧⌘]', '⌃Tab'], group: 'Worktrees and tabs' },
    right: { label: 'Split right', keys: ['⌘D'], group: 'Splits' },
    down: { label: 'Split down', keys: ['⇧⌘D'], group: 'Splits' },
    focusLeft: { label: 'Select the split at the left', keys: ['⌥⌘←'], group: 'Splits' },
    focusRight: { label: 'Select the split at the right', keys: ['⌥⌘→'], group: 'Splits' },
    focusUp: { label: 'Select the split above', keys: ['⌥⌘↑'], group: 'Splits' },
    focusDown: { label: 'Select the split below', keys: ['⌥⌘↓'], group: 'Splits' },
    viewDashboard: { label: 'Dashboard', keys: ['⌥⌘1'], group: 'Views' },
    viewAgents: { label: 'Agents', keys: ['⌥⌘2'], group: 'Views' },
    viewTasks: { label: 'Tasks', keys: ['⌥⌘3'], group: 'Views' },
    viewReview: { label: 'Review', keys: ['⌥⌘4'], group: 'Views' },
    viewPipelines: { label: 'Pipelines', keys: ['⌥⌘5'], group: 'Views' },
    viewNotes: { label: 'Notes', keys: ['⌥⌘6'], group: 'Views' },
    viewAutomations: { label: 'Automations', keys: ['⌥⌘7'], group: 'Views' },
    toggleSidebar: { label: 'Show or hide the sidebar', keys: ['⌘B'], group: 'Panels and focus' },
    focusSidebar: { label: 'Move the focus to the sidebar', keys: ['⇧⌘B'], group: 'Panels and focus' },
    toggleRightPanel: { label: 'Show or hide the right panel', keys: ['⌘E'], group: 'Panels and focus' },
    focusExplorer: { label: 'Move the focus to the file explorer', keys: ['⇧⌘E'], group: 'Panels and focus' },
    focusWorkspace: { label: 'Move the focus to the workspace', keys: ['⇧⌘0'], group: 'Panels and focus' },
    back: { label: 'Back', keys: ['⌘['], group: 'History' },
    forward: { label: 'Forward', keys: ['⌘]'], group: 'History' }
};

/** The text of each app key. A test checks each key combination with `appKeyAction`. */
export const APP_KEY_INFO: Record<AppKeyAction, ShortcutInfo> = {
    settings: { label: 'Settings', keys: ['⌘,'], group: 'App' },
    checkForUpdates: { label: 'Check for updates', keys: ['⇧⌘U'], group: 'App' },
    hide: { label: 'Hide ShipWarden', keys: ['⌘H'], group: 'App' },
    quit: { label: 'Quit ShipWarden. The agents continue to run.', keys: ['⌘Q'], group: 'App' },
    quitAndStop: { label: 'Quit and stop all agents', keys: ['⇧⌥⌘Q'], group: 'App' }
};

/** The keys of a terminal and a diff. A test checks each key combination with its function. */
export const OTHER_KEY_INFO = {
    clear: { label: 'Clear the terminal screen and scrollback', keys: ['⌘K'], group: 'Terminal and review' },
    pasteImage: { label: 'Paste an image into Claude Code or Codex', keys: ['⌃V'], group: 'Terminal and review' },
    comment: { label: 'Comment on the selected lines of a diff', keys: ['⇧⌘M'], group: 'Terminal and review' },
    openWorktree: { label: 'Open the worktree of a pull request', keys: ['⌘O'], group: 'Terminal and review' },
    openOnHost: { label: 'Open a pull request on GitHub', keys: ['⇧⌘O'], group: 'Terminal and review' }
} as const satisfies Record<string, ShortcutInfo>;

/** Returns all shortcuts, in the order of the groups. Each entry is one action. */
export function allShortcuts(): ShortcutInfo[] {
    const all = [...Object.values(SHORTCUT_INFO), ...Object.values(APP_KEY_INFO), ...Object.values(OTHER_KEY_INFO)];
    return SHORTCUT_GROUPS.flatMap(group => all.filter(item => item.group === group));
}

/** A row of the Keyboard Shortcuts page. A range row shows its first and last key, for example "⌘1 to ⌘8". */
export interface ShortcutRow extends ShortcutInfo {
    range?: boolean;
}

/** The tab actions that the page shows as one row. */
const TAB_RANGE: readonly ShortcutAction[] = ['selectTab1', 'selectTab2', 'selectTab3', 'selectTab4', 'selectTab5', 'selectTab6', 'selectTab7', 'selectTab8'];

/** Returns the rows of the Keyboard Shortcuts page: all shortcuts, with ⌘1 to ⌘8 in one row. */
export function shortcutRows(): ShortcutRow[] {
    const tabs = new Set(TAB_RANGE.map(action => SHORTCUT_INFO[action]));
    const rows: ShortcutRow[] = [];
    for (const item of allShortcuts()) {
        if (!tabs.has(item)) rows.push(item);
        else if (item === SHORTCUT_INFO.selectTab1) {
            rows.push({
                label: 'Select tab 1 to 8',
                keys: [SHORTCUT_INFO.selectTab1.keys[0], SHORTCUT_INFO.selectTab8.keys[0]],
                group: item.group,
                range: true
            });
        }
    }
    return rows;
}

/** A key combination as the key event of a browser or of Electron gives it. */
export interface ParsedKeys {
    meta: boolean;
    shift: boolean;
    control: boolean;
    alt: boolean;
    key: string;
    code: string;
}

const KEY_CODES: Record<string, { key: string; code: string }> = {
    '[': { key: '[', code: 'BracketLeft' },
    ']': { key: ']', code: 'BracketRight' },
    ',': { key: ',', code: 'Comma' },
    '←': { key: 'ArrowLeft', code: 'ArrowLeft' },
    '→': { key: 'ArrowRight', code: 'ArrowRight' },
    '↑': { key: 'ArrowUp', code: 'ArrowUp' },
    '↓': { key: 'ArrowDown', code: 'ArrowDown' },
    Tab: { key: 'Tab', code: 'Tab' }
};

/**
 * Reads a key combination of the Keyboard Shortcuts page, for example "⇧⌘D", into the key event that it makes.
 * Returns undefined for text that is not a key combination.
 */
export function parseKeys(text: string): ParsedKeys | undefined {
    const match = /^([⌃⌥⇧⌘]*)(.+)$/u.exec(text);
    if (!match) return undefined;
    const modifiers = match[1];
    const name = match[2];
    let key: string;
    let code: string;
    if (KEY_CODES[name]) ({ key, code } = KEY_CODES[name]);
    else if (/^[A-Z]$/.test(name)) [key, code] = [name.toLowerCase(), `Key${name}`];
    else if (/^\d$/.test(name)) [key, code] = [name, `Digit${name}`];
    else return undefined;
    return { meta: modifiers.includes('⌘'), shift: modifiers.includes('⇧'), control: modifiers.includes('⌃'), alt: modifiers.includes('⌥'), key, code };
}

/** Splits a key combination into its keys for the page, for example "⇧⌘D" into "⇧", "⌘" and "D". */
export function keyParts(text: string): string[] {
    const match = /^([⌃⌥⇧⌘]*)(.+)$/u.exec(text);
    return match ? [...match[1], match[2]] : [text];
}
