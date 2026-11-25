import type { MenuItemConstructorOptions } from 'electron';
import type { HelpAction } from '@shared/onboarding';
import { formatAccelerator } from '@shared/key-chords';
import { DEFAULT_KEYMAP, type KeyCommandId, type Keymap, type ShortcutAction } from '@shared/shortcuts';
import { PROJECT_URL } from '@shared/star-prompt';

/** The GitHub page of ShipWarden. Its README explains the app. */
export { PROJECT_URL };

/** The actions of the menu items. */
export interface MenuActions {
    openSettings(): void;
    /** Opens Settings › About and checks for updates there. */
    checkForUpdates(): void;
    quitAndStopSessions(): void;
    /** Opens one more main window. */
    newWindow(): void;
    sendShortcut(action: ShortcutAction): void;
    /** Sends an item of the Help menu to the page. */
    help(action: HelpAction): void;
    /** Opens a web page in the default browser. */
    openUrl(url: string): void;
}

/** Returns the accelerator of the first key of a command, or undefined for a command without a key. */
export function acceleratorOf(keymap: Keymap, id: KeyCommandId): string | undefined {
    const chord = keymap.keys[id][0];
    return chord ? formatAccelerator(chord) : undefined;
}

/**
 * The macOS menu. It is the standard menu, with "Check for Updates" after "About" and "Quit and Stop All Agents" after
 * "Quit". The Help menu opens the welcome page, the tour, the keyboard shortcuts and the GitHub page of ShipWarden.
 * The keys come from the keymap, so the app builds the menu again after a change of the keybindings.
 */
export function menuTemplate(actions: MenuActions, keymap: Keymap = DEFAULT_KEYMAP): MenuItemConstructorOptions[] {
    const sendShortcut = (action: ShortcutAction) => () => actions.sendShortcut(action);
    const key = (id: KeyCommandId) => acceleratorOf(keymap, id);
    return [
        {
            role: 'appMenu',
            submenu: [
                { role: 'about' },
                { label: 'Check for Updates…', accelerator: key('checkForUpdates'), click: () => actions.checkForUpdates() },
                { type: 'separator' },
                { label: 'Settings…', accelerator: key('settings'), click: () => actions.openSettings() },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit', label: 'Quit ShipWarden (Keep Agents Running)' },
                // macOS gives ⌥⌘Q to its "Quit and Keep Windows" item, so this item uses ⇧⌥⌘Q.
                { label: 'Quit and Stop All Agents…', accelerator: key('quitAndStop'), click: () => actions.quitAndStopSessions() }
            ]
        },
        {
            label: 'File',
            submenu: [
                // The same keys as Ghostty. ⌘W closes a pane, so the window closes with ⇧⌘W.
                { label: 'New Worktree…', accelerator: key('newWorktree'), click: sendShortcut('newWorktree') },
                { label: 'New Window', accelerator: key('newWindow'), click: () => actions.newWindow() },
                { label: 'New Shell Tab', accelerator: key('newTab'), click: sendShortcut('newTab') },
                { label: 'Split Right', accelerator: key('right'), click: sendShortcut('right') },
                { label: 'Split Down', accelerator: key('down'), click: sendShortcut('down') },
                { type: 'separator' },
                { label: 'Select Split Left', accelerator: key('focusLeft'), click: sendShortcut('focusLeft') },
                { label: 'Select Split Right', accelerator: key('focusRight'), click: sendShortcut('focusRight') },
                { label: 'Select Split Above', accelerator: key('focusUp'), click: sendShortcut('focusUp') },
                { label: 'Select Split Below', accelerator: key('focusDown'), click: sendShortcut('focusDown') },
                { type: 'separator' },
                { label: 'Copy File Path or Link', accelerator: key('copyFilePath'), click: sendShortcut('copyFilePath') },
                { label: 'Reveal File in Finder', accelerator: key('revealFileInFinder'), click: sendShortcut('revealFileInFinder') },
                { label: 'Open in Editor', accelerator: key('openInEditor'), click: sendShortcut('openInEditor') },
                { type: 'separator' },
                { label: 'Close Pane', accelerator: key('close'), click: sendShortcut('close') },
                { role: 'close', label: 'Close Window', accelerator: 'Shift+Command+W' }
            ]
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { label: 'Toggle Sidebar', accelerator: key('toggleSidebar'), click: sendShortcut('toggleSidebar') },
                { label: 'Focus Sidebar', accelerator: key('focusSidebar'), click: sendShortcut('focusSidebar') },
                { label: 'Toggle Right Panel', accelerator: key('toggleRightPanel'), click: sendShortcut('toggleRightPanel') },
                { label: 'Focus File Explorer', accelerator: key('focusExplorer'), click: sendShortcut('focusExplorer') },
                { label: 'Search File Contents', accelerator: key('searchContents'), click: sendShortcut('searchContents') },
                // ⌘0 stays the key of Actual Size, so this item uses ⇧⌘0.
                { label: 'Focus Workspace', accelerator: key('focusWorkspace'), click: sendShortcut('focusWorkspace') },
                { label: 'Command Palette…', accelerator: key('commandPalette'), click: sendShortcut('commandPalette') },
                { type: 'separator' },
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Go',
            submenu: [
                { label: 'Back', accelerator: key('back'), click: sendShortcut('back') },
                { label: 'Forward', accelerator: key('forward'), click: sendShortcut('forward') },
                { type: 'separator' },
                { label: 'Dashboard', accelerator: key('viewDashboard'), click: sendShortcut('viewDashboard') },
                { label: 'Agents', accelerator: key('viewAgents'), click: sendShortcut('viewAgents') },
                { label: 'Tasks', accelerator: key('viewTasks'), click: sendShortcut('viewTasks') },
                { label: 'Review', accelerator: key('viewReview'), click: sendShortcut('viewReview') },
                { label: 'Pipelines', accelerator: key('viewPipelines'), click: sendShortcut('viewPipelines') },
                { label: 'Scratch Pad', accelerator: key('viewNotes'), click: sendShortcut('viewNotes') },
                { label: 'Automations', accelerator: key('viewAutomations'), click: sendShortcut('viewAutomations') },
                { type: 'separator' },
                // ⌃⇧Tab and ⌃Tab also select the previous and the next tab.
                { label: 'Select Previous Tab', accelerator: key('previousTab'), click: sendShortcut('previousTab') },
                { label: 'Select Next Tab', accelerator: key('nextTab'), click: sendShortcut('nextTab') },
                {
                    label: 'Select Tab',
                    submenu: [
                        ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map(digit => ({
                            label: `Tab ${digit}`,
                            accelerator: key(`selectTab${digit}`),
                            click: sendShortcut(`selectTab${digit}`)
                        })),
                        { label: 'Last Tab', accelerator: key('selectLastTab'), click: sendShortcut('selectLastTab') }
                    ]
                }
            ]
        },
        { role: 'windowMenu' },
        {
            // The "help" role gives the menu the search field of macOS.
            role: 'help',
            submenu: [
                { label: 'Show Welcome', click: () => actions.help('welcome') },
                { label: 'Take the Tour', click: () => actions.help('tour') },
                { label: 'Keyboard Shortcuts', click: () => actions.help('shortcuts') },
                { type: 'separator' },
                { label: 'ShipWarden on GitHub', click: () => actions.openUrl(PROJECT_URL) }
            ]
        }
    ];
}
