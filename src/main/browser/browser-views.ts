import { app, BrowserWindow, session, shell, WebContentsView, type Certificate, type Input, type Session, type WebContents } from 'electron';
import { BLANK_PAGE, isBrowsableUrl, type BrowserBounds, type BrowserFindOptions, type BrowserState } from '@shared/browser';
import { SELECTOR_TIMEOUT_MS, type ScreenshotWait } from '@shared/screenshots';
import { verifyWithExtraCas } from './extra-ca-verify';

/** The session of all browser views. It is not the session of the app, so a page cannot read the data of the app. */
const PARTITION = 'persist:shipwarden-browser';

/** The permissions that a page gets without a question. All other permission requests are refused. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/** Chromium error -3 (ERR_ABORTED): a new navigation stopped the load. This is not an error for the user. */
const ERR_ABORTED = -3;

/** The height of the window of a capture before ShipWarden measures the page. */
const CAPTURE_START_HEIGHT = 900;
/** The largest height of a capture in CSS pixels. A longer page is cut at this height. */
const CAPTURE_MAX_HEIGHT = 8000;
/** The longest time for the load of a page to capture. */
const CAPTURE_LOAD_TIMEOUT_MS = 30_000;

/** The options of a screenshot. */
export interface CaptureOptions {
    /** The page width in CSS pixels. */
    width: number;
    wait: ScreenshotWait;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Rejects with the message when the promise does not settle in time. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface BrowserViewEvents {
    /** The state of a view changed: the address, the title, the history or the load state. */
    onState(state: BrowserState): void;
    /** A page asked for a new window, for example with a link that has target="_blank". */
    onOpenTab(url: string, openerId: string): void;
    /** A view got the keyboard focus. */
    onFocus(id: string): void;
    /** A key goes to a view. Return true when the app used the key. The page then does not get it. */
    onInput(id: string, input: Input): boolean;
    /** A find in a page has a result. `active` is the number of the current match, from 1. */
    onFound(id: string, active: number, matches: number): void;
}

interface Entry {
    view: WebContentsView;
    /** The window of the page that made the view. The view shows in this window only. */
    owner: BrowserWindow;
    /** True while the view is in the window. */
    attached: boolean;
    /** The worktree of the browser tab. The MCP browser tools use the tab of the worktree of the agent. */
    worktree?: string;
    error?: string;
    /** The address of the load that failed. The view keeps the page before it, so getURL() does not return it. */
    failedUrl?: string;
}

/**
 * The in-app browser. Each browser tab of a page has one WebContentsView in the window of that page.
 * The page sends the place of the tab content, and the view shows there, above the page.
 *
 * Security:
 * - The views have no preload script, no Node integration, context isolation and the sandbox.
 * - The views use their own session. The page of the app and the browser pages do not share cookies or storage.
 * - Only http, https and the blank page load. Other schemes are refused.
 * - All permission requests are refused, except the clipboard write.
 */
export class BrowserViews {
    private readonly views = new Map<string, Entry>();
    private browserSession: Session | undefined;

    constructor(
        /** The PEM of the extra CA certificates of Settings › Network. */
        private readonly extraCas: () => readonly string[],
        private readonly events: BrowserViewEvents
    ) {}

    /**
     * Makes a view for a browser tab of the page in `owner` and loads the address. Does nothing when the view exists.
     * `worktree` is the worktree of the tab.
     */
    create(id: string, url: string, owner: BrowserWindow, worktree?: string): void {
        if (owner.isDestroyed() || this.views.has(id)) return;
        const view = new WebContentsView({
            webPreferences: {
                session: this.session(),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                navigateOnDragDrop: false,
                spellcheck: true
            }
        });
        view.setBackgroundColor('#ffffff');
        view.setVisible(false);
        const entry: Entry = { view, owner, attached: false, ...(worktree ? { worktree } : {}) };
        this.views.set(id, entry);
        this.listen(id, entry);
        this.load(id, url);
    }

    /**
     * Shows the view at a place in the window, or hides it (`bounds` is null).
     * `bounds` is in CSS pixels of the page. The zoom of the page changes the size of a CSS pixel.
     */
    setBounds(id: string, bounds: BrowserBounds | null): void {
        const entry = this.views.get(id);
        if (!entry || entry.owner.isDestroyed()) return;
        const window = entry.owner;
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
            entry.view.setVisible(false);
            return;
        }
        if (!entry.attached) {
            window.contentView.addChildView(entry.view);
            entry.attached = true;
        }
        const zoom = window.webContents.getZoomFactor();
        entry.view.setBounds({
            x: Math.round(bounds.x * zoom),
            y: Math.round(bounds.y * zoom),
            width: Math.round(bounds.width * zoom),
            height: Math.round(bounds.height * zoom)
        });
        entry.view.setVisible(true);
    }

    /** Loads an address in a view. An address that the browser does not show is refused. */
    load(id: string, url: string): void {
        const entry = this.views.get(id);
        if (!entry) return;
        const target = isBrowsableUrl(url) ? url : BLANK_PAGE;
        entry.error = undefined;
        entry.failedUrl = undefined;
        entry.view.webContents.loadURL(target).catch(() => {
            // did-fail-load reports the error. This catch only stops an unhandled rejection.
        });
    }

    back(id: string): void {
        const history = this.views.get(id)?.view.webContents.navigationHistory;
        if (history?.canGoBack()) history.goBack();
    }

    forward(id: string): void {
        const history = this.views.get(id)?.view.webContents.navigationHistory;
        if (history?.canGoForward()) history.goForward();
    }

    reload(id: string): void {
        const entry = this.views.get(id);
        if (!entry) return;
        const failed = entry.failedUrl;
        entry.error = undefined;
        entry.failedUrl = undefined;
        if (failed) this.load(id, failed);
        else entry.view.webContents.reload();
    }

    stop(id: string): void {
        this.views.get(id)?.view.webContents.stop();
    }

    /** Gives the keyboard focus to the page of a view. */
    focus(id: string): void {
        this.views.get(id)?.view.webContents.focus();
    }

    /** Finds the text in the page. An empty text stops the find. The found-in-page event gives the result. */
    find(id: string, text: string, options: BrowserFindOptions): void {
        const contents = this.views.get(id)?.view.webContents;
        if (!contents || contents.isDestroyed()) return;
        if (!text) {
            contents.stopFindInPage('clearSelection');
            this.events.onFound(id, 0, 0);
            return;
        }
        // In Electron, findNext is true for the first request of a new text.
        contents.findInPage(text, { findNext: !options.next, forward: options.forward, matchCase: options.matchCase });
    }

    /** Stops the find in the page and removes the highlights. */
    stopFind(id: string): void {
        const contents = this.views.get(id)?.view.webContents;
        if (contents && !contents.isDestroyed()) contents.stopFindInPage('clearSelection');
    }

    /** Opens the developer tools of the page in a separate window. */
    toggleDevTools(id: string): void {
        const contents = this.views.get(id)?.view.webContents;
        if (!contents) return;
        if (contents.isDevToolsOpened()) contents.closeDevTools();
        else contents.openDevTools({ mode: 'detach' });
    }

    state(id: string): BrowserState | undefined {
        const entry = this.views.get(id);
        if (!entry || entry.view.webContents.isDestroyed()) return undefined;
        const contents = entry.view.webContents;
        return {
            id,
            url: entry.failedUrl ?? contents.getURL(),
            title: contents.getTitle(),
            canGoBack: contents.navigationHistory.canGoBack(),
            canGoForward: contents.navigationHistory.canGoForward(),
            loading: contents.isLoading(),
            error: entry.error
        };
    }

    /**
     * Captures a full-page PNG of an address. The page loads in a hidden window with the session of the browser pane,
     * so it has the same cookies and the same certificate rules. The window closes after the capture.
     * The image has the width of the page in CSS pixels. A page that is longer than CAPTURE_MAX_HEIGHT is cut.
     */
    async capture(url: string, options: CaptureOptions): Promise<Buffer> {
        if (!isBrowsableUrl(url) || url === BLANK_PAGE) throw new Error(`ShipWarden cannot capture "${url}". Use an http or https address.`);
        const window = new BrowserWindow({
            show: false,
            width: options.width,
            height: CAPTURE_START_HEIGHT,
            useContentSize: true,
            enableLargerThanScreen: true,
            paintWhenInitiallyHidden: true,
            webPreferences: {
                session: this.session(),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                navigateOnDragDrop: false,
                spellcheck: false
            }
        });
        const contents = window.webContents;
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-attach-webview', event => event.preventDefault());
        contents.on('will-navigate', event => {
            if (!isBrowsableUrl(event.url)) event.preventDefault();
        });
        try {
            try {
                await withTimeout(contents.loadURL(url), CAPTURE_LOAD_TIMEOUT_MS, 'The page did not load in 30 seconds.');
            } catch (error) {
                const detail = error instanceof Error ? error.message.replace(/\s*\(-?\d+\) loading .*$/, '') : String(error);
                throw new Error(`ShipWarden cannot open ${url}: ${detail}. Make sure that the dev server is running.`);
            }
            if (options.wait.kind === 'delay') {
                await delay(options.wait.ms);
            } else if (options.wait.kind === 'selector') {
                await this.waitForSelector(window, options.wait.selector);
            }
            const height = Number(
                await contents.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)', true)
            );
            const fullHeight = Math.min(Math.max(Number.isFinite(height) ? Math.ceil(height) : CAPTURE_START_HEIGHT, 200), CAPTURE_MAX_HEIGHT);
            window.setContentSize(options.width, fullHeight);
            // The page needs a moment to paint at the new size.
            await delay(300);
            const image = await contents.capturePage(undefined, { stayHidden: true });
            if (image.isEmpty()) throw new Error(`The capture of ${url} gave an empty image.`);
            const size = image.getSize();
            return (size.width > options.width ? image.resize({ width: options.width, quality: 'best' }) : image).toPNG();
        } finally {
            if (!window.isDestroyed()) window.destroy();
        }
    }

    /** Waits until an element matches the CSS selector. It rejects after SELECTOR_TIMEOUT_MS. */
    private async waitForSelector(window: BrowserWindow, selector: string): Promise<void> {
        const script = `!!document.querySelector(${JSON.stringify(selector)})`;
        const end = Date.now() + SELECTOR_TIMEOUT_MS;
        while (Date.now() < end) {
            let found = false;
            try {
                found = (await window.webContents.executeJavaScript(script, true)) === true;
            } catch {
                throw new Error(`"${selector}" is not a valid CSS selector.`);
            }
            if (found) return;
            await delay(200);
        }
        throw new Error(`No element matched "${selector}" in ${SELECTOR_TIMEOUT_MS / 1000} seconds.`);
    }

    /** Removes a view and closes its page. */
    destroy(id: string): void {
        const entry = this.views.get(id);
        if (!entry) return;
        this.views.delete(id);
        if (entry.attached && !entry.owner.isDestroyed()) {
            entry.owner.contentView.removeChildView(entry.view);
        }
        if (!entry.view.webContents.isDestroyed()) {
            entry.view.webContents.close();
        }
    }

    /** Removes the views of a window, for example when the window closes. */
    destroyOwnedBy(window: BrowserWindow): void {
        [...this.views].filter(([, entry]) => entry.owner === window).forEach(([id]) => this.destroy(id));
    }

    /** Returns the window of a view, or undefined when the view does not exist. */
    ownerOf(id: string): BrowserWindow | undefined {
        return this.views.get(id)?.owner;
    }

    /** Returns the newest view of a worktree, or undefined when the worktree has no browser tab. */
    viewOf(worktree: string): string | undefined {
        return [...this.views].reverse().find(([, entry]) => entry.worktree === worktree && !entry.view.webContents.isDestroyed())?.[0];
    }

    /** Returns the page of a view, or undefined when the view does not exist. */
    contentsOf(id: string): WebContents | undefined {
        const contents = this.views.get(id)?.view.webContents;
        return contents && !contents.isDestroyed() ? contents : undefined;
    }

    /**
     * True when the view was in its window one time or more, so its page has a size. A view that never showed has no
     * size, and a capture of it is empty.
     */
    hasSize(id: string): boolean {
        return !!this.views.get(id)?.attached;
    }

    /** The IDs of the views. */
    ids(): string[] {
        return [...this.views.keys()];
    }

    private listen(id: string, entry: Entry): void {
        const contents = entry.view.webContents;
        const send = () => {
            const state = this.state(id);
            if (state) this.events.onState(state);
        };
        contents.on('did-start-loading', send);
        contents.on('did-stop-loading', send);
        contents.on('did-navigate', () => {
            entry.error = undefined;
            entry.failedUrl = undefined;
            send();
        });
        contents.on('did-navigate-in-page', send);
        contents.on('page-title-updated', send);
        contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
            if (!isMainFrame || code === ERR_ABORTED) return;
            entry.error = description || `Error ${code}`;
            entry.failedUrl = url;
            send();
        });
        contents.on('focus', () => this.events.onFocus(id));
        contents.on('found-in-page', (_event, result) => this.events.onFound(id, result.activeMatchOrdinal, result.matches));
        contents.on('before-input-event', (event, input) => {
            if (this.events.onInput(id, input)) event.preventDefault();
        });
        // A new window becomes a new browser tab. The page does not get a reference to the new window.
        contents.setWindowOpenHandler(({ url }) => {
            if (isBrowsableUrl(url)) this.events.onOpenTab(url, id);
            else this.openOtherScheme(url);
            return { action: 'deny' };
        });
        const guard = (event: { preventDefault(): void; url: string }) => {
            if (!isBrowsableUrl(event.url)) {
                event.preventDefault();
                this.openOtherScheme(event.url);
            }
        };
        contents.on('will-navigate', guard);
        contents.on('will-redirect', guard);
        // A page cannot attach a <webview> with other settings.
        contents.on('will-attach-webview', event => event.preventDefault());
    }

    /** A "mailto:" link opens the mail app. The browser refuses all other schemes. */
    private openOtherScheme(url: string): void {
        if (/^mailto:/i.test(url)) {
            void shell.openExternal(url);
        }
    }

    /** The browser session. It is made at the first use, because a session needs the app to be ready. */
    private session(): Session {
        if (this.browserSession) return this.browserSession;
        const browser = session.fromPartition(PARTITION);
        // Some sites refuse or change for an unknown browser. Remove the names of Electron and the app.
        browser.setUserAgent(app.userAgentFallback.replace(/\s(Electron|shipwarden|ShipWarden)\/\S+/g, ''));
        browser.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
        browser.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
        // Chromium uses the macOS keychain. On a network that inspects TLS traffic, the CA file of Settings › Network
        // can contain a CA that the keychain does not have. A chain that Chromium refuses gets a second check with it.
        browser.setCertificateVerifyProc((request, callback) => {
            if (request.verificationResult === 'net::OK') {
                callback(-3);
                return;
            }
            const extra = this.extraCas();
            const authorityError = /ERR_CERT_AUTHORITY_INVALID/.test(request.verificationResult);
            if (authorityError && extra.length > 0 && verifyWithExtraCas(request.hostname, chainOf(request.certificate), extra)) {
                callback(0);
                return;
            }
            callback(-3);
        });
        this.browserSession = browser;
        return browser;
    }
}

/** The PEM of a certificate and of each issuer above it. */
function chainOf(certificate: Certificate): string[] {
    const chain: string[] = [];
    let current: Certificate | undefined = certificate;
    // A self-signed certificate is its own issuer. The limit stops a loop.
    while (current && chain.length < 10) {
        chain.push(current.data);
        if (current.issuerCert === current || current.issuerCert?.data === current.data) break;
        current = current.issuerCert;
    }
    return chain;
}
