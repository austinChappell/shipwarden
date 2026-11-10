import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import type { ShortcutAction } from '@shared/shortcuts';
import { menuTemplate } from './menu';

/** Returns the menu template and the actions that its items called. */
function recordActions() {
    const calls: string[] = [];
    const template = menuTemplate({
        openSettings: () => calls.push('settings'),
        quitAndStopSessions: () => calls.push('quitAndStop'),
        sendShortcut: (action: ShortcutAction) => calls.push(`shortcut:${action}`)
    });
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
        expect(template.map(menu => menu.role ?? menu.label)).toEqual(['appMenu', 'File', 'editMenu', 'View', 'Go', 'windowMenu']);
    });

    it('gives each accelerator to one item only', () => {
        const { template } = recordActions();
        const accelerators = allItems(template).map(entry => entry.accelerator).filter(Boolean);
        expect(new Set(accelerators).size).toBe(accelerators.length);
    });

    it('opens the settings and quits with the app menu items', () => {
        const { calls, template } = recordActions();
        click(item(template, 'Settings…'));
        click(item(template, 'Quit and Stop All Agents…'));
        expect(calls).toEqual(['settings', 'quitAndStop']);
        expect(item(template, 'Quit and Stop All Agents…').accelerator).toBe('Shift+Alt+Command+Q');
    });

    it('sends the shortcut of a workspace item to the page', () => {
        const { calls, template } = recordActions();
        click(item(template, 'New Worktree…'));
        click(item(template, 'Close Pane'));
        click(item(template, 'Pipelines'));
        expect(calls).toEqual(['shortcut:newWorktree', 'shortcut:close', 'shortcut:viewPipelines']);
    });

    it('has a tab item for each digit, and ⌘9 selects the last tab', () => {
        const { calls, template } = recordActions();
        const tabs = item(template, 'Select Tab').submenu as MenuItemConstructorOptions[];
        expect(tabs.map(entry => entry.accelerator)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => `Command+${digit}`));
        tabs.forEach(click);
        expect(calls).toEqual([...[1, 2, 3, 4, 5, 6, 7, 8].map(digit => `shortcut:selectTab${digit}`), 'shortcut:selectLastTab']);
    });
});
