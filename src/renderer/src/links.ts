import { isBrowsableUrl, linkTarget, type ClickModifiers } from '@shared/browser';

/** Opens an address in the in-app browser. App sets it. Without it, links open in the default browser. */
type AppBrowserOpener = (url: string) => boolean;

let appBrowser: AppBrowserOpener | undefined;

/** Sets the function that opens the in-app browser. Returns a function that removes it. */
export function setAppBrowserOpener(opener: AppBrowserOpener): () => void {
    appBrowser = opener;
    return () => {
        if (appBrowser === opener) appBrowser = undefined;
    };
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/**
 * Opens a web link (http or https). All link clicks of the app go through this function.
 * - ⇧⌘-click opens the in-app browser.
 * - ⌘-click, and a plain click outside the terminal, open the default browser.
 * `needsModifier` is true for the terminal: a plain click there does nothing.
 * Returns false when the link did not open.
 */
export function openLink(url: string, click?: ClickModifiers, options: { needsModifier?: boolean } = {}): boolean {
    if (!isBrowsableUrl(url) || url === 'about:blank') return false;
    const target = linkTarget(click, { needsModifier: options.needsModifier, isMac });
    if (target === 'none') return false;
    if (target === 'app' && appBrowser?.(url)) return true;
    window.shipwarden.github.openInBrowser(url);
    return true;
}
