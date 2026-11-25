import {
    chordId,
    formatChord,
    inputMatches,
    inputOfEvent,
    keyNamesOf,
    parseChordSymbols,
    sameChord,
    type KeyChord,
    type KeyEventFields,
    type KeyInput
} from './key-chords';

/**
 * The default keys of ShipWarden. Settings › Keyboard and ~/.shipwarden/keybindings.json can change most of them (see
 * `KEY_COMMANDS` and `keybindings.ts`). The functions here take the keymap with the keys of the user.
 *
 * The workspace shortcuts: tabs, splits, the focus between panes and close, as in Ghostty. Also ⌘[ and ⌘] for back and
 * forward, ⌘B for the sidebar, ⇧⌘B for the focus in the sidebar, ⌘E for the right panel, ⌘N for a new worktree and
 * ⇧⌘E for the focus in the file explorer. ⇧⌘F searches the file contents for the selected text.
 * The tab keys are as in Ghostty: ⌘1 to ⌘8 select a tab, and ⌘9 selects the last tab. ⇧⌘[ and ⇧⌘] select the previous
 * and the next tab. ⌃⇧Tab and ⌃Tab do the same.
 * ⌥⌘1 to ⌥⌘6 open a view: Dashboard, Agents, Tasks, Review, Pipelines and Notes. ⇧⌘0 moves the focus to the workspace.
 * ⇧⌘P opens the command palette. ⇧⌘C copies the relative path of the active file, or the link of the pull request or
 * task on the screen. ⌥⌘R shows that file in Finder. ⌥⌘O opens that file, or the selected worktree, in the external editor.
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
    | 'searchContents'
    | 'focusWorkspace'
    | 'commandPalette'
    | 'copyFilePath'
    | 'revealFileInFinder'
    | 'openInEditor'
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

/**
 * Returns the workspace action of a key, from the keymap: by default ⌘T (new tab), ⌘W (close the pane, or the tab
 * with one pane), ⌘D (split right), ⇧⌘D (split down), and the other keys of `SHORTCUT_INFO`. Settings › Keyboard can
 * change the keys. Other keys return undefined.
 */
export function shortcutAction(input: KeyInput & { type: string }, keymap: Keymap = DEFAULT_KEYMAP): ShortcutAction | undefined {
    if (input.type !== 'keyDown') return undefined;
    return commandForInput(keymap, input, isShortcutAction) as ShortcutAction | undefined;
}

/**
 * Returns true for the comment key (by default ⇧⌘M) of the keymap. A diff then opens the comment box for the line of the cursor or
 * for the selected lines.
 */
export function isCommentKey(input: KeyEventFields, keymap: Keymap = DEFAULT_KEYMAP): boolean {
    return matchesCommand(keymap, 'comment', inputOfEvent(input));
}

/** The keys of the header of a pull request in the Review view. */
export type PullRequestKeyAction = 'openWorktree' | 'openOnHost';

/**
 * Returns the action of a key in the header of a pull request, from the keymap: by default ⌘O (open the worktree of
 * the head branch) and ⇧⌘O (open the pull request on the host). Other keys return undefined.
 */
export function pullRequestKeyAction(input: KeyEventFields, keymap: Keymap = DEFAULT_KEYMAP): PullRequestKeyAction | undefined {
    const event = inputOfEvent(input);
    if (matchesCommand(keymap, 'openWorktree', event)) return 'openWorktree';
    if (matchesCommand(keymap, 'openOnHost', event)) return 'openOnHost';
    return undefined;
}

/** The app keys of the macOS menu that the main process runs itself. */
export type AppKeyAction = 'quit' | 'quitAndStop' | 'settings' | 'checkForUpdates' | 'hide' | 'newWindow';

/** The app keys that Settings › Keyboard cannot change. macOS gives ⌘Q and ⌘H to Quit and Hide. */
export type FixedAppKeyAction = 'quit' | 'hide';

/** The app keys that Settings › Keyboard can change. */
export type RemappableAppKeyAction = Exclude<AppKeyAction, FixedAppKeyAction>;

const QUIT_CHORD: KeyChord = { key: 'Q', meta: true, control: false, alt: false, shift: false };
const HIDE_CHORD: KeyChord = { key: 'H', meta: true, control: false, alt: false, shift: false };

/**
 * Returns the app action of a key: ⌘Q (quit, the agents keep running), ⌘H (hide), and the app keys of the keymap. By
 * default these are ⇧⌥⌘Q (quit and stop all agents), ⌘, (settings), ⇧⌘U (check for updates), and ⇧⌘N (new window).
 * A focused terminal takes all keys, so the menu does not get these keys. The main process reads them before the page.
 * Other keys return undefined.
 */
export function appKeyAction(input: KeyInput & { type: string }, keymap: Keymap = DEFAULT_KEYMAP): AppKeyAction | undefined {
    if (input.type !== 'keyDown') return undefined;
    if (inputMatches(input, QUIT_CHORD)) return 'quit';
    if (inputMatches(input, HIDE_CHORD)) return 'hide';
    return commandForInput(keymap, input, isRemappableAppKey) as RemappableAppKeyAction | undefined;
}

/** Returns true for the clear key (by default ⌘K) of the keymap. A focused terminal then clears its screen and scrollback. */
export function isClearKey(input: KeyEventFields, keymap: Keymap = DEFAULT_KEYMAP): boolean {
    return matchesCommand(keymap, 'clearTerminal', inputOfEvent(input));
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
export const SHORTCUT_GROUPS = ['Worktrees and tabs', 'Splits', 'Views', 'Panels and focus', 'History', 'App', 'Terminal, editor, and review'] as const;

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
    viewNotes: { label: 'Scratch Pad', keys: ['⌥⌘6'], group: 'Views' },
    viewAutomations: { label: 'Automations', keys: ['⌥⌘7'], group: 'Views' },
    toggleSidebar: { label: 'Show or hide the sidebar', keys: ['⌘B'], group: 'Panels and focus' },
    focusSidebar: { label: 'Move the focus to the sidebar', keys: ['⇧⌘B'], group: 'Panels and focus' },
    toggleRightPanel: { label: 'Show or hide the right panel', keys: ['⌘E'], group: 'Panels and focus' },
    focusExplorer: { label: 'Move the focus to the file explorer', keys: ['⇧⌘E'], group: 'Panels and focus' },
    searchContents: { label: 'Search the file contents for the selected text', keys: ['⇧⌘F'], group: 'Panels and focus' },
    focusWorkspace: { label: 'Move the focus to the workspace', keys: ['⇧⌘0'], group: 'Panels and focus' },
    copyFilePath: { label: 'Copy the relative path of the active file, or the link of a pull request or task', keys: ['⇧⌘C'], group: 'Worktrees and tabs' },
    revealFileInFinder: { label: 'Show the active file in Finder', keys: ['⌥⌘R'], group: 'Worktrees and tabs' },
    openInEditor: { label: 'Open the active file or the worktree in the external editor', keys: ['⌥⌘O'], group: 'Worktrees and tabs' },
    commandPalette: { label: 'Open the command palette', keys: ['⇧⌘P'], group: 'App' },
    back: { label: 'Back', keys: ['⌘['], group: 'History' },
    forward: { label: 'Forward', keys: ['⌘]'], group: 'History' }
};

/** The text of each app key. A test checks each key combination with `appKeyAction`. */
export const APP_KEY_INFO: Record<AppKeyAction, ShortcutInfo> = {
    settings: { label: 'Settings', keys: ['⌘,'], group: 'App' },
    checkForUpdates: { label: 'Check for updates', keys: ['⇧⌘U'], group: 'App' },
    newWindow: { label: 'Open a new window', keys: ['⇧⌘N'], group: 'App' },
    hide: { label: 'Hide ShipWarden', keys: ['⌘H'], group: 'App' },
    quit: { label: 'Quit ShipWarden. The agents continue to run.', keys: ['⌘Q'], group: 'App' },
    quitAndStop: { label: 'Quit and stop all agents', keys: ['⇧⌥⌘Q'], group: 'App' }
};

/** The keys that work only in one place: a terminal, an editor, a diff, or the header of a pull request. */
export type ScopedKeyAction = 'clearTerminal' | 'askAgent' | 'toggleBlame' | 'comment' | 'openWorktree' | 'openOnHost';

/** The keys of a terminal, an editor, and a diff. A test checks each key combination with its function. */
export const OTHER_KEY_INFO = {
    clearTerminal: { label: 'Clear the terminal screen and scrollback', keys: ['⌘K'], group: 'Terminal, editor, and review' },
    pasteImage: { label: 'Paste an image into Claude Code or Codex', keys: ['⌃V'], group: 'Terminal, editor, and review' },
    askAgent: { label: 'Ask the agent about the selected lines of the editor', keys: ['⇧⌘A'], group: 'Terminal, editor, and review' },
    toggleBlame: { label: 'Show or hide git blame in the editor', keys: ['⌥⌘B'], group: 'Terminal, editor, and review' },
    comment: { label: 'Comment on the selected lines of a diff', keys: ['⇧⌘M'], group: 'Terminal, editor, and review' },
    openWorktree: { label: 'Open the worktree of a pull request', keys: ['⌘O'], group: 'Terminal, editor, and review' },
    openOnHost: { label: 'Open a pull request on GitHub', keys: ['⇧⌘O'], group: 'Terminal, editor, and review' }
} as const satisfies Record<ScopedKeyAction | 'pasteImage', ShortcutInfo>;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Commands and keymaps                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The ID of a command that Settings › Keyboard and ~/.shipwarden/keybindings.json can give a different key. */
export type KeyCommandId = ShortcutAction | RemappableAppKeyAction | ScopedKeyAction;

/**
 * The place where a key works. A "global" key works in all of the window, and the main process reads it before the
 * page. The other keys work only in their place. Two keys in two different places (not "global") do not conflict.
 */
export type KeyScope = 'global' | 'terminal' | 'editor' | 'diff' | 'pullRequest';

/** A command that can get a different key. */
export interface KeyCommand {
    id: KeyCommandId;
    label: string;
    group: ShortcutGroup;
    scope: KeyScope;
    /** The keys of `SHORTCUT_INFO`, `APP_KEY_INFO`, or `OTHER_KEY_INFO`. */
    defaults: readonly KeyChord[];
}

const SCOPES: Record<ScopedKeyAction, KeyScope> = {
    clearTerminal: 'terminal',
    askAgent: 'editor',
    toggleBlame: 'editor',
    comment: 'diff',
    openWorktree: 'pullRequest',
    openOnHost: 'pullRequest'
};

const REMAPPABLE_APP_KEYS: readonly RemappableAppKeyAction[] = ['settings', 'checkForUpdates', 'newWindow', 'quitAndStop'];

function defaultChords(info: ShortcutInfo): KeyChord[] {
    return info.keys.map(text => {
        const chord = parseChordSymbols(text);
        if (!chord) throw new Error(`The default key "${text}" is not a key combination.`);
        return chord;
    });
}

/** All commands that can get a different key, in the order of the Keyboard section. The first command wins a conflict. */
export const KEY_COMMANDS: readonly KeyCommand[] = [
    ...(Object.entries(SHORTCUT_INFO) as [ShortcutAction, ShortcutInfo][]).map(([id, info]) => ({
        id,
        label: info.label,
        group: info.group,
        scope: 'global' as const,
        defaults: defaultChords(info)
    })),
    ...REMAPPABLE_APP_KEYS.map(id => ({
        id,
        label: APP_KEY_INFO[id].label,
        group: APP_KEY_INFO[id].group,
        scope: 'global' as const,
        defaults: defaultChords(APP_KEY_INFO[id])
    })),
    ...(Object.keys(SCOPES) as ScopedKeyAction[]).map(id => ({
        id,
        label: OTHER_KEY_INFO[id].label,
        group: OTHER_KEY_INFO[id].group,
        scope: SCOPES[id],
        defaults: defaultChords(OTHER_KEY_INFO[id])
    }))
];

const COMMANDS_BY_ID = new Map<string, KeyCommand>(KEY_COMMANDS.map(command => [command.id, command]));

/** Returns the command of an ID, or undefined for an ID that is not a command. */
export function keyCommand(id: string): KeyCommand | undefined {
    return COMMANDS_BY_ID.get(id);
}

/** Returns true when the value is the ID of a command. */
export function isKeyCommandId(value: unknown): value is KeyCommandId {
    return typeof value === 'string' && COMMANDS_BY_ID.has(value);
}

function isShortcutAction(id: KeyCommandId): boolean {
    return id in SHORTCUT_INFO;
}

function isRemappableAppKey(id: KeyCommandId): boolean {
    return (REMAPPABLE_APP_KEYS as readonly string[]).includes(id);
}

/** The keys of each command, and the commands of each key. */
export interface Keymap {
    /** The keys of each command. An empty list means that the command has no key. */
    keys: Readonly<Record<KeyCommandId, readonly KeyChord[]>>;
    /** The commands of each key, by `chordId`, in the order of `KEY_COMMANDS`. */
    byChord: ReadonlyMap<string, readonly KeyCommandId[]>;
}

/** Makes a keymap from the keys of each command. A command without an entry gets its default keys. */
export function buildKeymap(keys: Partial<Record<KeyCommandId, readonly KeyChord[]>> = {}): Keymap {
    const all = {} as Record<KeyCommandId, readonly KeyChord[]>;
    const byChord = new Map<string, KeyCommandId[]>();
    for (const command of KEY_COMMANDS) {
        const chords = keys[command.id] ?? command.defaults;
        all[command.id] = chords;
        for (const chord of chords) {
            const id = chordId(chord);
            const list = byChord.get(id) ?? [];
            if (!list.includes(command.id)) list.push(command.id);
            byChord.set(id, list);
        }
    }
    return { keys: all, byChord };
}

/** The keymap with the default keys. */
export const DEFAULT_KEYMAP: Keymap = buildKeymap();

/**
 * Returns the first command of the key event that `accept` accepts. The key names of the event come in their order
 * (see `keyNamesOf`), and the commands of one key come in the order of `KEY_COMMANDS`.
 */
export function commandForInput(keymap: Keymap, input: KeyInput, accept: (id: KeyCommandId) => boolean): KeyCommandId | undefined {
    for (const key of keyNamesOf(input)) {
        const ids = keymap.byChord.get(chordId({ key, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift }));
        const id = ids?.find(accept);
        if (id) return id;
    }
    return undefined;
}

/** Returns true when the key event is a key of the command in the keymap. */
export function matchesCommand(keymap: Keymap, id: KeyCommandId, input: KeyInput): boolean {
    return keymap.keys[id].some(chord => inputMatches(input, chord));
}

/** Returns the keys of a command in the form of the UI, for example ["⇧⌘["]. An empty list means no key. */
export function keyLabels(keymap: Keymap, id: KeyCommandId): string[] {
    return keymap.keys[id].map(formatChord);
}

/** Returns the first key of a command in the form of the UI, for example "⇧⌘P". Returns undefined for no key. */
export function keyLabel(keymap: Keymap, id: KeyCommandId): string | undefined {
    const chord = keymap.keys[id][0];
    return chord ? formatChord(chord) : undefined;
}

/**
 * Replaces the default keys in a help text with the keys of the keymap. For example, "Press ⌘N" becomes "Press ⌥⌘N"
 * when the user gave "New worktree" the key ⌥⌘N. A key that is not the default key of a command stays as it is. A
 * command without a key gets the text "no key".
 */
export function remapKeyText(text: string, keymap: Keymap): string {
    if (keymap === DEFAULT_KEYMAP) return text;
    return text.replace(KEY_TOKEN, token => {
        const chord = parseChordSymbols(token);
        if (!chord) return token;
        const id = DEFAULT_KEYMAP.byChord.get(chordId(chord))?.[0];
        if (!id) return token;
        const current = keymap.keys[id];
        if (current.some(other => sameChord(other, chord))) return token;
        return current[0] ? formatChord(current[0]) : 'no key';
    });
}

/** A key combination in a text, for example "⇧⌘P" or "⌥⌘←". A letter key must not continue as a word ("⌘Enter"). */
const KEY_TOKEN = /[⌃⌥⇧⌘]+(?:Tab|Space|F1[0-2]|F[1-9]|[A-Z](?![A-Za-z])|[0-9]|[←→↑↓↩⎋⌫⌦[\],./;'`=\\-])/gu;

/** Returns all shortcuts, in the order of the groups. Each entry is one action. The keys come from the keymap. */
export function allShortcuts(keymap: Keymap = DEFAULT_KEYMAP): ShortcutInfo[] {
    const current = (id: string, info: ShortcutInfo): ShortcutInfo => (isKeyCommandId(id) ? { ...info, keys: keyLabels(keymap, id) } : info);
    const all = [SHORTCUT_INFO, APP_KEY_INFO, OTHER_KEY_INFO].flatMap(table => Object.entries(table).map(([id, info]) => current(id, info)));
    return SHORTCUT_GROUPS.flatMap(group => all.filter(item => item.group === group));
}

/** A row of the Keyboard Shortcuts page. A range row shows its first and last key, for example "⌘1 to ⌘8". */
export interface ShortcutRow extends ShortcutInfo {
    range?: boolean;
}

/** The tab actions that the page shows as one row. */
const TAB_RANGE: readonly ShortcutAction[] = ['selectTab1', 'selectTab2', 'selectTab3', 'selectTab4', 'selectTab5', 'selectTab6', 'selectTab7', 'selectTab8'];

/**
 * Returns the rows of the Keyboard Shortcuts page: all shortcuts, with ⌘1 to ⌘8 in one row. The tab keys get one row
 * only while all of them have their default keys.
 */
export function shortcutRows(keymap: Keymap = DEFAULT_KEYMAP): ShortcutRow[] {
    const all = allShortcuts(keymap);
    const tabLabels = new Set(TAB_RANGE.map(action => SHORTCUT_INFO[action].label));
    const defaultTabs = TAB_RANGE.every(action => keymap.keys[action] === DEFAULT_KEYMAP.keys[action]);
    const rows: ShortcutRow[] = [];
    for (const item of all) {
        if (!defaultTabs || !tabLabels.has(item.label)) rows.push(item);
        else if (item.label === SHORTCUT_INFO.selectTab1.label) {
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
