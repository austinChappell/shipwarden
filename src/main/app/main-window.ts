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
    onClosed(): void;
    /** Runs for each key before the page gets it. */
    onInput(event: Electron.Event, input: Electron.Input): void;
}

/**
 * Holds the main window of the app. The window can close and open again, so other parts get it with `get()`.
 */
export class MainWindow {
    private window: BrowserWindow | undefined;
    /** The background of a new window: the background of the active theme, so the window does not flash another color. */
    private background = activePalette(DEFAULT_APPEARANCE, true).palette.bg;

    /** Returns the window, or undefined when no window is open. */
    get(): BrowserWindow | undefined {
        return this.window;
    }

    /** Sends a message to the page. Without a window, it does nothing. */
    send(channel: string, ...args: unknown[]): void {
        this.window?.webContents.send(channel, ...args);
    }

    /** Makes native parts (menus, dialogs, scroll bars) follow the color scheme, and remembers the window background. */
    applyAppearance(appearance: Appearance): void {
        nativeTheme.themeSource = appearance.scheme;
        this.background = activePalette(appearance, nativeTheme.shouldUseDarkColors).palette.bg;
    }

    /** Opens a new main window. */
    create(options: MainWindowOptions): void {
        const window = new BrowserWindow({
            width: 1440,
            height: 920,
            minWidth: 800,
            minHeight: 500,
            show: false,
            title: 'ShipWarden',
            backgroundColor: this.background,
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 14, y: 13 },
            webPreferences: {
                preload: options.preload,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                // The built-in PDF viewer of Chromium is a plugin. Without this option, a PDF frame stays empty.
                plugins: true
            }
        });
        this.window = window;
        window.on('ready-to-show', () => this.window?.show());
        window.on('closed', () => {
            options.onClosed();
            this.window = undefined;
        });
        window.webContents.on('before-input-event', (event, input) => options.onInput(event, input));
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
    }
}
