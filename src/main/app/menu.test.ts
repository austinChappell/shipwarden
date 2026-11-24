import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { formatChord, parseChord } from '@shared/key-chords';
import { keymapOf } from '@shared/keybindings';
import { DEFAULT_KEYMAP, SHORTCUT_INFO, type Keymap, type ShortcutAction } from '@shared/shortcuts';
import { menuTemplate, PROJECT_URL } from './menu';

/** Returns the menu template and the actions that its items called. */
function recordActions(keymap: Keymap = DEFAULT_KEYMAP) {
    const calls: string[] = [];
    const template = menuTemplate(
        {
            openSettings: () => calls.push('settings'),
            checkForUpdates: () => calls.push('updates'),
            quitAndStopSessions: () => calls.push('quitAndStop'),
            newWindow: () => calls.push('newWindow'),
            sendShortcut: (action: ShortcutAction) => calls.push(`shortcut:${action}`),
            help: action => calls.push(`help:${action}`),
            openUrl: url => calls.push(`url:${url}`)
        },
        keymap
    );
    return { calls, template };
}

/** Returns all items of the template, also the items of the submenus. */
function allItems(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    return items.flatMap(item => [item, ...(Array.isArray(item.submenu) ? allItems(item.submenu) : [])]);
}

/** Returns the item with this label. */
function item(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
    const found = allItems(template).find(entry => entry.label === label);
    if (!found) throw new Error(`The menu has no item "${label}".`);
    return found;
}

/** Clicks a menu item. The menu actions do not read the arguments of the click. */
function click(entry: MenuItemConstructorOptions): void {
    (entry.click as () => void)();
}

describe('menuTemplate', () => {
    it('has the menus in the macOS order', () => {
        const { template } = recordActions();
        expect(template.map(menu => menu.role ?? menu.label)).toEqual(['appMenu', 'File', 'editMenu', 'View', 'Go', 'windowMenu', 'help']);
    });

    it('gives each accelerator to one item only', () => {
        const { template } = recordActions();
        const accelerators = allItems(template)
            .map(entry => entry.accelerator)
            .filter(Boolean);
        expect(new Set(accelerators).size).toBe(accelerators.length);
    });

    it('opens the settings, checks for updates and quits with the app menu items', () => {
        const { calls, template } = recordActions();
        click(item(template, 'Settings…'));
        click(item(template, 'Check for Updates…'));
        click(item(template, 'Quit and Stop All Agents…'));
        expect(calls).toEqual(['settings', 'updates', 'quitAndStop']);
        expect(item(template, 'Check for Updates…').accelerator).toBe('CmdOrCtrl+Shift+U');
        click(item(template, 'New Window'));
        expect(calls).toContain('newWindow');
        expect(item(template, 'New Window').accelerator).toBe('CmdOrCtrl+Shift+N');
        expect(item(template, 'Quit and Stop All Agents…').accelerator).toBe('CmdOrCtrl+Alt+Shift+Q');
    });

    it('sends the shortcut of a workspace item to the page', () => {
        const { calls, template } = recordActions();
        click(item(template, 'New Worktree…'));
        click(item(template, 'Close Pane'));
        click(item(template, 'Pipelines'));
        expect(calls).toEqual(['shortcut:newWorktree', 'shortcut:close', 'shortcut:viewPipelines']);
    });

    it('sends the Help items to the page and opens the GitHub page', () => {
        const { calls, template } = recordActions();
        click(item(template, 'Show Welcome'));
        click(item(template, 'Take the Tour'));
        click(item(template, 'Keyboard Shortcuts'));
        click(item(template, 'ShipWarden on GitHub'));
        expect(calls).toEqual(['help:welcome', 'help:tour', 'help:shortcuts', `url:${PROJECT_URL}`]);
        expect(PROJECT_URL).toBe('https://github.com/austinChappell/shipwarden');
    });

    it('has a tab item for each digit, and ⌘9 selects the last tab', () => {
        const { calls, template } = recordActions();
        const tabs = item(template, 'Select Tab').submenu as MenuItemConstructorOptions[];
        expect(tabs.map(entry => entry.accelerator)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => `CmdOrCtrl+${digit}`));
        tabs.forEach(click);
        expect(calls).toEqual([...[1, 2, 3, 4, 5, 6, 7, 8].map(digit => `shortcut:selectTab${digit}`), 'shortcut:selectLastTab']);
    });

    it('shows the same keys as the Keyboard Shortcuts page', () => {
        // "CmdOrCtrl+Alt+Shift+D" becomes "⌥⇧⌘D", the order of the page.
        const symbols = (accelerator: string) => {
            const chord = parseChord(accelerator);
            if (!chord) throw new Error(`"${accelerator}" is not an accelerator.`);
            return formatChord(chord);
        };
        const { calls, template } = recordActions();
        let checked = 0;
        for (const entry of allItems(template)) {
            if (!entry.accelerator || !entry.click) continue;
            calls.length = 0;
            click(entry);
            const action = calls[0]?.startsWith('shortcut:') ? (calls[0].slice('shortcut:'.length) as ShortcutAction) : undefined;
            if (!action) continue;
            expect(SHORTCUT_INFO[action].keys, `${entry.label}`).toContain(symbols(String(entry.accelerator)));
            checked++;
        }
        expect(checked).toBeGreaterThan(20);
    });

    it('takes the keys of the keymap, and leaves out the key of a command without a key', () => {
        const { template } = recordActions(keymapOf({ commandPalette: ['CmdOrCtrl+Shift+K'], newTab: [] }));
        expect(item(template, 'Command Palette…').accelerator).toBe('CmdOrCtrl+Shift+K');
        expect(item(template, 'New Shell Tab').accelerator).toBeUndefined();
        expect(item(template, 'Split Right').accelerator).toBe('CmdOrCtrl+D');
    });
});
