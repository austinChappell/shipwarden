import type { WebContents } from 'electron';
import { BLANK_PAGE, isBrowsableUrl } from '@shared/browser';
import type { McpBrowser, McpPage } from '../mcp/tools';
import {
    CLICK_SCRIPT,
    MAX_PAGE_ELEMENTS,
    MAX_PAGE_TEXT,
    pageCall,
    READ_PAGE_SCRIPT,
    TYPE_SCRIPT,
    type ActResult,
    type ElementTarget,
    type PageRead
} from '@shared/agent-page';
import type { BrowserViews } from './browser-views';

/** The longest time for a new browser tab of the page. */
const TAB_TIMEOUT_MS = 10_000;
/** The longest time for the load of a page. */
const LOAD_TIMEOUT_MS = 30_000;
/** The time that a click or a submit gets to start a navigation. */
const SETTLE_MS = 300;
/** The widest screenshot in pixels. A wider image gets smaller, so that it uses fewer tokens of the agent. */
const MAX_SCREENSHOT_WIDTH = 1280;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export interface AgentBrowserOptions {
    views: BrowserViews;
    /** Asks the page to open a browser tab of the worktree. The page does not select the tab or the worktree. */
    requestTab(url: string, worktree: string): void;
}

/**
 * The MCP browser tools on the browser tab of a worktree. The agent and the user use the same tab, so the user sees
 * what the agent does. The newest browser tab of the worktree is the tab of the agent.
 */
export class AgentBrowser implements McpBrowser {
    constructor(private readonly options: AgentBrowserOptions) {}

    async open(worktree: string, url: string, signal: AbortSignal): Promise<McpPage> {
        if (!isBrowsableUrl(url) || url === BLANK_PAGE) throw new Error(`ShipWarden cannot open "${url}". Use an http or https address.`);
        const { views } = this.options;
        let id = views.viewOf(worktree);
        if (id) views.load(id, url);
        else {
            this.options.requestTab(url, worktree);
            id = await this.waitForTab(worktree, signal);
        }
        // The load can start a moment after the call.
        await delay(100);
        await this.waitForLoad(this.contents(id), signal);
        return this.page(id);
    }

    async read(worktree: string, selector?: string): Promise<PageRead> {
        const id = this.tab(worktree);
        const result = (await this.contents(id).executeJavaScript(
            pageCall(READ_PAGE_SCRIPT, { selector, maxChars: MAX_PAGE_TEXT, maxElements: MAX_PAGE_ELEMENTS }),
            true
        )) as PageRead | { error: string };
        if ('error' in result) throw new Error(result.error);
        return result;
    }

    async screenshot(worktree: string): Promise<{ png: Buffer; page: McpPage; note?: string }> {
        const id = this.tab(worktree);
        const page = this.page(id);
        // A hidden tab with a size gives a correct capture: capturePage makes the page visible for the capture.
        const image = this.options.views.hasSize(id) ? await this.contents(id).capturePage() : undefined;
        if (!image || image.isEmpty()) {
            if (!isBrowsableUrl(page.url) || page.url === BLANK_PAGE) throw new Error('The browser tab shows no page. Call open_page first.');
            const png = await this.options.views.capture(page.url, { width: MAX_SCREENSHOT_WIDTH, wait: { kind: 'none' } });
            return {
                png,
                page,
                note: 'The user did not open the browser tab yet, so ShipWarden loaded the address again in a hidden window. The image does not show the changes that clicks and typed text made on the page.'
            };
        }
        const width = image.getSize().width;
        return { png: (width > MAX_SCREENSHOT_WIDTH ? image.resize({ width: MAX_SCREENSHOT_WIDTH, quality: 'good' }) : image).toPNG(), page };
    }

    async click(worktree: string, target: ElementTarget, signal: AbortSignal): Promise<{ element: string; page: McpPage }> {
        const id = this.tab(worktree);
        const element = await this.act(id, pageCall(CLICK_SCRIPT, target));
        await this.settle(id, signal);
        return { element, page: this.page(id) };
    }

    async type(
        worktree: string,
        target: ElementTarget,
        text: string,
        options: { clear: boolean; submit: boolean },
        signal: AbortSignal
    ): Promise<{ element: string; page: McpPage }> {
        const id = this.tab(worktree);
        const element = await this.act(id, pageCall(TYPE_SCRIPT, { target, text, ...options }));
        if (options.submit) await this.settle(id, signal);
        return { element, page: this.page(id) };
    }

    private async act(id: string, script: string): Promise<string> {
        const result = (await this.contents(id).executeJavaScript(script, true)) as ActResult;
        if (!result.ok) throw new Error(result.error);
        return result.element;
    }

    /** Gives a click or a submit time to start a navigation, then waits for the load. */
    private async settle(id: string, signal: AbortSignal): Promise<void> {
        await delay(SETTLE_MS);
        await this.waitForLoad(this.contents(id), signal);
    }

    private tab(worktree: string): string {
        const id = this.options.views.viewOf(worktree);
        if (!id) throw new Error('This worktree has no browser tab. Call open_page first.');
        return id;
    }

    private contents(id: string): WebContents {
        const contents = this.options.views.contentsOf(id);
        if (!contents) throw new Error('The browser tab closed. Call open_page again.');
        return contents;
    }

    private page(id: string): McpPage {
        const state = this.options.views.state(id);
        if (!state) throw new Error('The browser tab closed. Call open_page again.');
        return { url: state.url, title: state.title, ...(state.loading ? { loading: true } : {}), ...(state.error ? { error: state.error } : {}) };
    }

    private async waitForTab(worktree: string, signal: AbortSignal): Promise<string> {
        const end = Date.now() + TAB_TIMEOUT_MS;
        while (Date.now() < end && !signal.aborted) {
            const id = this.options.views.viewOf(worktree);
            if (id) return id;
            await delay(100);
        }
        throw new Error('ShipWarden did not open a browser tab. Make sure that the ShipWarden window is open, then call open_page again.');
    }

    /** Waits until the page stops loading. A slow page does not fail: the result then has `loading`. */
    private async waitForLoad(contents: WebContents, signal: AbortSignal): Promise<void> {
        const end = Date.now() + LOAD_TIMEOUT_MS;
        while (Date.now() < end && !signal.aborted && !contents.isDestroyed() && contents.isLoading()) await delay(100);
    }
}
