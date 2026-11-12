import { useEffect, useRef } from 'react';
import { BLANK_PAGE, browserTabKey } from '@shared/browser';
import { browserStore } from '../browser/browser-store';
import { setAppBrowserOpener } from '../links';
import { browserIds, worktreeOfBrowser, type ExtraTab } from './tabs';

const api = window.shipwarden;

interface Options {
    extraTabs: Record<string, ExtraTab[]>;
    openExtra: (root: string, tab: ExtraTab) => void;
    /** The worktree for a new browser tab when the caller gives no worktree. */
    defaultRoot: string | undefined;
    selectedPath: string | undefined;
    setSelectedPath: (path: string) => void;
    setMainView: (view: 'worktree' | 'terminal') => void;
    /** The home folder. The Terminal view keeps its tabs under it. */
    homeFolder: string | undefined;
    /** Moves the focus to the pane of a browser tab. */
    focusBrowserPane: (id: string) => void;
}

/**
 * The in-app browser tabs. Links in the app and new windows of a page open in a browser tab.
 * Returns the function that opens an address in a new browser tab.
 */
export function useBrowserTabs({ extraTabs, openExtra, defaultRoot, selectedPath, setSelectedPath, setMainView, homeFolder, focusBrowserPane }: Options) {
    /**
     * Opens an address in a new browser tab of a worktree: `root`, else the selected worktree, else the first worktree
     * of the project. The worktree view then shows. A tab of the home folder shows in the Terminal view.
     * Returns false when the project has no worktree.
     */
    const openBrowser = (url: string, root?: string): boolean => {
        const target = root ?? defaultRoot;
        if (!target) return false;
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        browserStore.set({ id, url, title: '', canGoBack: false, canGoForward: false, loading: url !== BLANK_PAGE });
        api.browser.create(id, url);
        openExtra(target, { key: browserTabKey(id), kind: 'browser', id });
        if (target === homeFolder) {
            setMainView('terminal');
            return true;
        }
        if (target !== selectedPath) setSelectedPath(target);
        setMainView('worktree');
        return true;
    };
    const openBrowserRef = useRef(openBrowser);
    openBrowserRef.current = openBrowser;
    const extraTabsRef = useRef(extraTabs);
    extraTabsRef.current = extraTabs;
    useEffect(() => {
        const removeOpener = setAppBrowserOpener(url => openBrowserRef.current(url));
        // A page asked for a new window: a new browser tab in the worktree of the page.
        const removeOpenTab = api.browser.onOpenTab((url, openerId) => {
            openBrowserRef.current(url, worktreeOfBrowser(extraTabsRef.current, openerId));
        });
        return () => {
            removeOpener();
            removeOpenTab();
        };
    }, []);

    // The main process keeps a view for each browser tab. Close the views of the tabs that closed.
    const shownBrowsers = useRef(new Set<string>());
    useEffect(() => {
        const ids = browserIds(extraTabs);
        for (const id of shownBrowsers.current) {
            if (!ids.has(id)) {
                api.browser.destroy(id);
                browserStore.remove(id);
            }
        }
        shownBrowsers.current = ids;
    }, [extraTabs]);

    const focusBrowserPaneRef = useRef(focusBrowserPane);
    focusBrowserPaneRef.current = focusBrowserPane;
    useEffect(() => api.browser.onFocus(id => focusBrowserPaneRef.current(id)), []);

    return openBrowser;
}
