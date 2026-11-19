import { BrowserWindow, nativeTheme, shell } from 'electron';
import { activePalette, DEFAULT_APPEARANCE, type Appearance } from '@shared/themes';

/** The files and the callbacks of a new main window. */
export interface MainWindowOptions {
    /** The preload script of the page. */
    preload: string;
    /** The URL of the development server. With this URL, the window loads the URL instead of `page`. */
    devServerUrl?: string;
    /** The HTML file of the page. */
    page: string;
    /** Runs when the window closes. */
    onClosed(window: BrowserWindow): void;
    /** Runs for each key before the page gets it. */
    onInput(window: BrowserWindow, event: Electron.Event, input: Electron.Input): void;
}

/** The offset of a new window from the active window, so that the new window does not cover it fully. */
const CASCADE_OFFSET = 24;

/**
 * Holds the main windows of the app. The user can open more than one window (⇧⌘N). Each window shows its own page.
 * A window can close and open again, so other parts get a window with `get()`.
 */
export class MainWindow {
    /** The open windows. The last item is the window that had the focus last. */
    private readonly windows: BrowserWindow[] = [];
    /** The background of a new window: the background of the active theme, so the window does not flash another color. */
    private background = activePalette(DEFAULT_APPEARANCE, true).palette.bg;

    /** Returns the window that had the focus last, or undefined when no window is open. */
    get(): BrowserWindow | undefined {
        return this.windows.at(-1);
    }

    /** Returns all open windows. */
    all(): readonly BrowserWindow[] {
        return this.windows;
    }

    /** Returns the main window of a page, or undefined when the page is not in a main window. */
    fromContents(contents: Electron.WebContents): BrowserWindow | undefined {
        return this.windows.find(window => !window.isDestroyed() && window.webContents === contents);
    }

    /** Sends a message to the pages of all windows. Without a window, it does nothing. */
    send(channel: string, ...args: unknown[]): void {
        for (const window of this.windows) {
            if (!window.isDestroyed()) window.webContents.send(channel, ...args);
        }
    }

    /** Sends a message to the page of the window that had the focus last. Without a window, it does nothing. */
    sendToActive(channel: string, ...args: unknown[]): void {
        const window = this.get();
        if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
    }

    /** Makes native parts (menus, dialogs, scroll bars) follow the color scheme, and remembers the window background. */
    applyAppearance(appearance: Appearance): void {
        nativeTheme.themeSource = appearance.scheme;
        this.background = activePalette(appearance, nativeTheme.shouldUseDarkColors).palette.bg;
    }

    /** Opens a new main window. A second window opens a small distance below and right of the active window. */
    create(options: MainWindowOptions): BrowserWindow {
        const active = this.get();
        const place = active && !active.isDestroyed() && !active.isFullScreen() ? active.getBounds() : undefined;
        const window = new BrowserWindow({
            width: place?.width ?? 1440,
            height: place?.height ?? 920,
            ...(place ? { x: place.x + CASCADE_OFFSET, y: place.y + CASCADE_OFFSET } : {}),
            minWidth: 800,
            minHeight: 500,
            show: false,
            title: 'ShipWarden',
            backgroundColor: this.background,
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 14, y: 13 },
            // On macOS, the first click on an inactive window only activates the window. The page does not get the click.
            // Then the focus goes back to the last focused pane, not to the pane that the user clicked. This option sends
            // the first click to the page.
            acceptFirstMouse: true,
            webPreferences: {
                preload: options.preload,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                // The built-in PDF viewer of Chromium is a plugin. Without this option, a PDF frame stays empty.
                plugins: true
            }
        });
        this.windows.push(window);
        window.on('ready-to-show', () => {
            if (!window.isDestroyed()) window.show();
        });
        window.on('focus', () => this.moveToEnd(window));
        window.on('closed', () => {
            this.remove(window);
            options.onClosed(window);
        });
        window.webContents.on('before-input-event', (event, input) => options.onInput(window, event, input));
        // Open web links in the default browser, not in a new app window.
        window.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/.test(url)) {
                shell.openExternal(url);
            }
            return { action: 'deny' };
        });

        if (options.devServerUrl) {
            window.loadURL(options.devServerUrl);
        } else {
            window.loadFile(options.page);
        }
        return window;
    }

    private moveToEnd(window: BrowserWindow): void {
        this.remove(window);
        this.windows.push(window);
    }

    private remove(window: BrowserWindow): void {
        const index = this.windows.indexOf(window);
        if (index >= 0) this.windows.splice(index, 1);
    }
}
