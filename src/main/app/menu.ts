import type { MenuItemConstructorOptions } from 'electron';
import type { HelpAction } from '@shared/onboarding';
import type { ShortcutAction } from '@shared/shortcuts';

/** The GitHub page of ShipWarden. Its README explains the app. */
export const PROJECT_URL = 'https://github.com/austinChappell/shipwarden';

/** The actions of the menu items. */
export interface MenuActions {
    openSettings(): void;
    /** Opens Settings › About and checks for updates there. */
    checkForUpdates(): void;
    quitAndStopSessions(): void;
    sendShortcut(action: ShortcutAction): void;
    /** Sends an item of the Help menu to the page. */
    help(action: HelpAction): void;
    /** Opens a web page in the default browser. */
    openUrl(url: string): void;
}

/**
 * The macOS menu. It is the standard menu, with "Check for Updates" after "About" and "Quit and Stop All Agents" after
 * "Quit". The Help menu opens the welcome page, the tour, the keyboard shortcuts and the GitHub page of ShipWarden.
 */
export function menuTemplate(actions: MenuActions): MenuItemConstructorOptions[] {
    const sendShortcut = (action: ShortcutAction) => () => actions.sendShortcut(action);
    return [
        {
            role: 'appMenu',
            submenu: [
                { role: 'about' },
                { label: 'Check for Updates…', accelerator: 'Shift+Command+U', click: () => actions.checkForUpdates() },
                { type: 'separator' },
                { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => actions.openSettings() },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit', label: 'Quit ShipWarden (Keep Agents Running)' },
                // macOS gives ⌥⌘Q to its "Quit and Keep Windows" item, so this item uses ⇧⌥⌘Q.
                { label: 'Quit and Stop All Agents…', accelerator: 'Shift+Alt+Command+Q', click: () => actions.quitAndStopSessions() }
            ]
        },
        {
            label: 'File',
            submenu: [
                // The same keys as Ghostty. ⌘W closes a pane, so the window closes with ⇧⌘W.
                { label: 'New Worktree…', accelerator: 'Command+N', click: sendShortcut('newWorktree') },
                { label: 'New Shell Tab', accelerator: 'Command+T', click: sendShortcut('newTab') },
                { label: 'Split Right', accelerator: 'Command+D', click: sendShortcut('right') },
                { label: 'Split Down', accelerator: 'Shift+Command+D', click: sendShortcut('down') },
                { type: 'separator' },
                { label: 'Select Split Left', accelerator: 'Alt+Command+Left', click: sendShortcut('focusLeft') },
                { label: 'Select Split Right', accelerator: 'Alt+Command+Right', click: sendShortcut('focusRight') },
                { label: 'Select Split Above', accelerator: 'Alt+Command+Up', click: sendShortcut('focusUp') },
                { label: 'Select Split Below', accelerator: 'Alt+Command+Down', click: sendShortcut('focusDown') },
                { type: 'separator' },
                { label: 'Copy Relative Path of File', accelerator: 'Shift+Command+C', click: sendShortcut('copyFilePath') },
                { label: 'Reveal File in Finder', accelerator: 'Alt+Command+R', click: sendShortcut('revealFileInFinder') },
                { type: 'separator' },
                { label: 'Close Pane', accelerator: 'Command+W', click: sendShortcut('close') },
                { role: 'close', label: 'Close Window', accelerator: 'Shift+Command+W' }
            ]
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { label: 'Toggle Sidebar', accelerator: 'Command+B', click: sendShortcut('toggleSidebar') },
                { label: 'Focus Sidebar', accelerator: 'Shift+Command+B', click: sendShortcut('focusSidebar') },
                { label: 'Toggle Right Panel', accelerator: 'Command+E', click: sendShortcut('toggleRightPanel') },
                { label: 'Focus File Explorer', accelerator: 'Shift+Command+E', click: sendShortcut('focusExplorer') },
                // ⌘0 stays the key of Actual Size, so this item uses ⇧⌘0.
                { label: 'Focus Workspace', accelerator: 'Shift+Command+0', click: sendShortcut('focusWorkspace') },
                { label: 'Command Palette…', accelerator: 'Shift+Command+P', click: sendShortcut('commandPalette') },
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
                { label: 'Back', accelerator: 'Command+[', click: sendShortcut('back') },
                { label: 'Forward', accelerator: 'Command+]', click: sendShortcut('forward') },
                { type: 'separator' },
                { label: 'Dashboard', accelerator: 'Alt+Command+1', click: sendShortcut('viewDashboard') },
                { label: 'Agents', accelerator: 'Alt+Command+2', click: sendShortcut('viewAgents') },
                { label: 'Tasks', accelerator: 'Alt+Command+3', click: sendShortcut('viewTasks') },
                { label: 'Review', accelerator: 'Alt+Command+4', click: sendShortcut('viewReview') },
                { label: 'Pipelines', accelerator: 'Alt+Command+5', click: sendShortcut('viewPipelines') },
                { label: 'Notes', accelerator: 'Alt+Command+6', click: sendShortcut('viewNotes') },
                { label: 'Automations', accelerator: 'Alt+Command+7', click: sendShortcut('viewAutomations') },
                { type: 'separator' },
                // ⌃⇧Tab and ⌃Tab also select the previous and the next tab.
                { label: 'Select Previous Tab', accelerator: 'Shift+Command+[', click: sendShortcut('previousTab') },
                { label: 'Select Next Tab', accelerator: 'Shift+Command+]', click: sendShortcut('nextTab') },
                {
                    label: 'Select Tab',
                    submenu: [
                        ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map(digit => ({
                            label: `Tab ${digit}`,
                            accelerator: `Command+${digit}`,
                            click: sendShortcut(`selectTab${digit}`)
                        })),
                        { label: 'Last Tab', accelerator: 'Command+9', click: sendShortcut('selectLastTab') }
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
