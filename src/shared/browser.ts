/**
 * The in-app browser: shared types and the rules for addresses and link clicks.
 * The main process shows each browser tab in a WebContentsView. The page shows the toolbar.
 */

/** The state of one browser view. The main process sends it to the page after each change. */
export interface BrowserState {
    id: string;
    /** The address of the page. */
    url: string;
    title: string;
    canGoBack: boolean;
    canGoForward: boolean;
    loading: boolean;
    /** The error of the last load, for example "ERR_NAME_NOT_RESOLVED". */
    error?: string;
}

/** The position and the size of a browser view in the window, in CSS pixels. */
export interface BrowserBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The page that a new browser tab shows when it has no address. */
export const BLANK_PAGE = 'about:blank';

/** The search page for a text that is not an address. */
export const SEARCH_URL = 'https://www.google.com/search?q=';

/** True when the browser can show the address: http, https and the blank page. Other schemes stay blocked. */
export function isBrowsableUrl(url: string): boolean {
    if (url === BLANK_PAGE) return true;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/** True for a host that is on this computer or on a local network. Such a host gets http, not https. */
function isLocalHost(host: string): boolean {
    const name = host.replace(/:\d+$/, '').toLowerCase();
    return (
        name === 'localhost' ||
        name.endsWith('.localhost') ||
        name.endsWith('.local') ||
        name === '[::1]' ||
        /^127(\.\d{1,3}){3}$/.test(name) ||
        /^0\.0\.0\.0$/.test(name) ||
        /^10(\.\d{1,3}){3}$/.test(name) ||
        /^192\.168(\.\d{1,3}){2}$/.test(name) ||
        /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(name)
    );
}

/**
 * Converts the text of the address bar to an address.
 * - An http or https address stays as it is.
 * - A host such as "localhost:3000" or "127.0.0.1" gets "http://".
 * - A text with a dot and no spaces, such as "github.com/x", gets "https://".
 * - Other text becomes a search.
 * Returns undefined for an empty text and for a scheme that the browser does not show (for example "file:").
 */
export function normalizeAddress(input: string): string | undefined {
    const text = input.trim();
    if (!text) return undefined;
    if (text === BLANK_PAGE) return BLANK_PAGE;
    if (/^https?:\/\//i.test(text)) {
        return isBrowsableUrl(text) ? new URL(text).href : undefined;
    }
    // A scheme such as "file:", "javascript:" or "chrome:". A host with a port ("localhost:3000") is not a scheme.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
    if (scheme && !/^[^\s/:]+:\d+(\/|$)/.test(text)) {
        return undefined;
    }
    if (!/\s/.test(text)) {
        const host = text.split(/[/?#]/)[0];
        if (isLocalHost(host)) return toUrl(`http://${text}`);
        if (/^[^.]+(\.[^.]+)+$/.test(host) && /[a-z]/i.test(host.split('.').pop() ?? '')) return toUrl(`https://${text}`);
        if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)) return toUrl(`http://${text}`);
    }
    return SEARCH_URL + encodeURIComponent(text);
}

function toUrl(text: string): string | undefined {
    try {
        return new URL(text).href;
    } catch {
        return undefined;
    }
}

/** The modifier keys of a click. A React or a DOM mouse event has them. */
export interface ClickModifiers {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey?: boolean;
}

/** Where a link opens: in the default browser of the system, in the in-app browser, or nowhere. */
export type LinkTarget = 'system' | 'app' | 'none';

/**
 * Returns where a clicked link opens.
 * - ⇧⌘-click (⇧Ctrl-click on other systems) opens the in-app browser.
 * - ⌘-click opens the default browser.
 * - A click with no modifier opens the default browser, except when `needsModifier` is true. The terminal sets it,
 *   because a click in a terminal selects text.
 * `isMac` selects ⌘ (true) or Ctrl (false) as the primary modifier.
 */
export function linkTarget(click: ClickModifiers | undefined, options: { needsModifier?: boolean; isMac?: boolean } = {}): LinkTarget {
    const isMac = options.isMac ?? true;
    const primary = click ? (isMac ? click.metaKey : click.ctrlKey) : false;
    if (primary && click?.shiftKey) return 'app';
    if (primary) return 'system';
    return options.needsModifier ? 'none' : 'system';
}

/** The tab key of a browser tab: "b:<id>". */
export function browserTabKey(id: string): string {
    return `b:${id}`;
}

/** A short title for a browser tab: the page title, else the host, else "New tab". */
export function browserTabTitle(state: Pick<BrowserState, 'title' | 'url'> | undefined): string {
    if (state?.title && state.title !== state.url) return state.title;
    if (state?.url && state.url !== BLANK_PAGE) {
        try {
            return new URL(state.url).host || state.url;
        } catch {
            return state.url;
        }
    }
    return 'New tab';
}
