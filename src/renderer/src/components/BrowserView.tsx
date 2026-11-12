import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from 'lucide-react';
import { BLANK_PAGE, normalizeAddress, type BrowserBounds } from '@shared/browser';
import { browserStore, useBrowserStates } from '../browser/browser-store';
import { Button, IconButton, Input } from './ui';

interface Props {
    /** The ID of the browser view in the main process. */
    id: string;
    /** True when the view must not show, for example while the user drags a tab onto the panes. */
    hidden?: boolean;
    /** False for a pane of a split view without the focus. Such a view does not take the keyboard. */
    focused?: boolean;
    onClose(): void;
}

/**
 * Elements of the page that show above the tab content: dialogs and menus. The browser view is a native view above
 * the page, so it hides while one of them shows.
 */
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .modal';

/** True when a dialog or a menu of the page is above a part of the rectangle. */
function covered(rect: DOMRect): boolean {
    for (const overlay of document.querySelectorAll(OVERLAY_SELECTOR)) {
        const other = overlay.getBoundingClientRect();
        if (other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top) return true;
    }
    return false;
}

function sameBounds(a: BrowserBounds | null, b: BrowserBounds | null): boolean {
    if (!a || !b) return a === b;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * A browser tab: the toolbar (back, forward, reload, the address bar, open in the default browser, close) and the page.
 * The page is a WebContentsView of the main process. This component keeps the view at the place of its content element.
 */
export function BrowserView({ id, hidden, focused = true, onClose }: Props) {
    const api = window.shipwarden.browser;
    const state = useBrowserStates().get(id);
    const url = state?.url ?? '';
    const [address, setAddress] = useState(url === BLANK_PAGE ? '' : url);
    const [addressError, setAddressError] = useState<string>();
    const [editing, setEditing] = useState(false);
    const content = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const showPage = !hidden && !state?.error;

    // The address bar shows the address of the page, except while the user types.
    useEffect(() => {
        if (!editing) setAddress(url === BLANK_PAGE ? '' : url);
    }, [url, editing]);

    // The main process can send the state before this view mounts. Ask for it one time.
    useEffect(() => {
        void api.state(id).then(current => current && browserStore.set(current));
    }, [api, id]);

    // Keep the native view at the place of the content element. The place can change without a resize (for example
    // when the sidebar closes), so the loop reads the place in each frame and sends only a change.
    useEffect(() => {
        let sent: BrowserBounds | null | undefined;
        let frame = 0;
        const update = () => {
            const element = content.current;
            let bounds: BrowserBounds | null = null;
            if (element && showPage) {
                const rect = element.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && !covered(rect)) {
                    bounds = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
                }
            }
            if (sent === undefined || !sameBounds(sent, bounds)) {
                api.setBounds(id, bounds);
                sent = bounds;
            }
            frame = requestAnimationFrame(update);
        };
        update();
        return () => {
            cancelAnimationFrame(frame);
            api.setBounds(id, null);
        };
    }, [api, id, showPage]);

    // When the tab gets the focus: a tab without an address selects the address bar, else the page gets the keyboard.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The focus moves only when the tab shows or gets the focus. A change of state must not move the focus.
    useEffect(() => {
        if (!focused) return;
        if (!state || state.url === BLANK_PAGE || state.url === '') input.current?.focus();
        else api.focus(id);
    }, [id, focused]);

    // ⌘L in the page selects the address bar.
    useEffect(
        () =>
            api.onFocusAddress(target => {
                if (target === id) {
                    input.current?.focus();
                    input.current?.select();
                }
            }),
        [api, id]
    );

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const next = normalizeAddress(address);
        if (!next) {
            setAddressError('The browser opens only http and https addresses.');
            return;
        }
        setAddressError(undefined);
        setEditing(false);
        input.current?.blur();
        api.load(id, next);
        api.focus(id);
    };

    const openExternal = () => {
        if (url && url !== BLANK_PAGE) window.shipwarden.github.openInBrowser(url);
    };

    return (
        <div className="editor browser-view">
            <form className="diff-header browser-toolbar" onSubmit={submit}>
                <IconButton size="sm" icon={<ArrowLeft size={14} strokeWidth={1.7} />} label="Back" disabled={!state?.canGoBack} onClick={() => api.back(id)} />
                <IconButton
                    size="sm"
                    icon={<ArrowRight size={14} strokeWidth={1.7} />}
                    label="Forward"
                    disabled={!state?.canGoForward}
                    onClick={() => api.forward(id)}
                />
                {state?.loading ? (
                    <IconButton size="sm" icon={<X size={14} strokeWidth={1.7} />} label="Stop" onClick={() => api.stop(id)} />
                ) : (
                    <IconButton size="sm" icon={<RotateCw size={14} strokeWidth={1.7} />} label="Reload (⌘R)" onClick={() => api.reload(id)} />
                )}
                <Input
                    ref={input}
                    size="sm"
                    className="browser-address"
                    invalid={!!addressError}
                    icon={<Globe size={13} strokeWidth={1.6} />}
                    value={address}
                    spellCheck={false}
                    placeholder="Type an address or a search (⌘L)"
                    aria-label="Address"
                    title={addressError}
                    onFocus={event => {
                        setEditing(true);
                        event.currentTarget.select();
                    }}
                    onBlur={() => setEditing(false)}
                    onChange={event => {
                        setAddress(event.target.value);
                        setAddressError(undefined);
                    }}
                    onKeyDown={event => {
                        if (event.key === 'Escape') {
                            setAddress(url === BLANK_PAGE ? '' : url);
                            setAddressError(undefined);
                            event.currentTarget.blur();
                        }
                    }}
                />
                <IconButton
                    size="sm"
                    icon={<ExternalLink size={14} strokeWidth={1.7} />}
                    label="Open in the default browser"
                    disabled={!url || url === BLANK_PAGE}
                    onClick={openExternal}
                />
                <IconButton size="sm" icon={<X size={14} strokeWidth={1.8} />} label="Close the browser tab" onClick={onClose} />
            </form>
            {state?.loading && <div className="browser-progress" />}
            {addressError && <div className="editor-failure">{addressError}</div>}
            <div className="browser-content" ref={content}>
                {state?.error && (
                    <div className="browser-error">
                        <p>The page did not load: {state.error}</p>
                        <p className="browser-error-url">{state.url}</p>
                        <Button onClick={() => api.reload(id)}>Try again</Button>
                    </div>
                )}
            </div>
        </div>
    );
}
