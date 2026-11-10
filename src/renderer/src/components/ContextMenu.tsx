import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight } from 'lucide-react';

/** An item of a context menu. An item with `submenu` opens a menu with more items. */
export type ContextMenuItem =
    | { id: string; label: string; enabled?: boolean; danger?: boolean }
    | { label: string; submenu: ContextMenuItem[]; enabled?: boolean }
    | { type: 'separator' };

/** The point of a root menu. A menu under a button flips to `flipX` and `flipY` when the window has no space. */
interface Point {
    x: number;
    y: number;
    flipX?: number;
    flipY?: number;
}

interface Request extends Point {
    items: ContextMenuItem[];
    /** True when a key opened the menu. The first usable item is then active. */
    keyboard: boolean;
    resolve(id: string | undefined): void;
}

/** The space between a menu and the edge of the window, in pixels. */
const EDGE = 4;

let current: Request | undefined;
const listeners = new Set<() => void>();
let pointer = { x: 0, y: 0 };
/** True when the last input was a key, not a pointer press. */
let lastInputKey = false;

// The menu opens at the last pointer position, as a native context menu does.
// The capture phase records the position before a handler of the page opens the menu.
if (typeof window !== 'undefined') {
    const record = (event: MouseEvent) => { pointer = { x: event.clientX, y: event.clientY }; };
    window.addEventListener('pointerdown', event => { lastInputKey = false; record(event); }, true);
    window.addEventListener('contextmenu', record, true);
    window.addEventListener('keydown', () => { lastInputKey = true; }, true);
}

function emit() {
    listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function close(id: string | undefined) {
    const request = current;
    current = undefined;
    emit();
    request?.resolve(id);
}

/**
 * Shows a context menu of the app at the pointer. Resolves the ID of the chosen item, or undefined when the user
 * closes the menu. A new menu closes the menu that is open.
 * With `anchor`, the menu opens below the anchor, for example below the button that opens the menu.
 */
export function showContextMenu(items: ContextMenuItem[], anchor?: DOMRect | Element): Promise<string | undefined> {
    close(undefined);
    const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    const point: Point = rect ? { x: rect.left, y: rect.bottom + 2, flipX: rect.right, flipY: rect.top - 2 } : pointer;
    return new Promise(resolve => {
        current = { items, x: point.x, y: point.y, flipX: point.flipX, flipY: point.flipY, keyboard: lastInputKey, resolve };
        emit();
    });
}

/** True for an item that the user can choose or open. */
function usable(item: ContextMenuItem): boolean {
    return !('type' in item) && item.enabled !== false;
}

interface PanelProps {
    items: ContextMenuItem[];
    /** The point of a root menu. */
    point?: Point;
    /** The item that opens a submenu, and the menu that holds that item. */
    anchor?: { item: DOMRect; parent: DOMRect };
    /** The index of the first active item, for a submenu that the keyboard opens. -1 for none. */
    initialActive: number;
    onChoose(id: string): void;
    /** Closes this menu only. The root menu closes all menus. */
    onBack(): void;
}

function MenuPanel({ items, point, anchor, initialActive, onChoose, onBack }: PanelProps) {
    const panel = useRef<HTMLDivElement>(null);
    const rows = useRef<(HTMLDivElement | null)[]>([]);
    const [active, setActive] = useState(initialActive);
    const [open, setOpen] = useState<{ index: number; fromKey: boolean } | undefined>();
    const [position, setPosition] = useState<{ left: number; top: number } | undefined>();

    // Measure the menu, then put it fully in the window.
    useLayoutEffect(() => {
        const element = panel.current;
        if (!element) return;
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        const maxLeft = window.innerWidth - width - EDGE;
        const maxTop = window.innerHeight - height - EDGE;
        let left: number;
        let top: number;
        if (anchor) {
            // A submenu opens on the right of its menu. When there is no space, it opens on the left.
            left = anchor.parent.right - 2;
            if (left > maxLeft) left = anchor.parent.left - width + 2;
            top = anchor.item.top - 5;
        } else {
            left = point?.x ?? 0;
            top = point?.y ?? 0;
            // When there is no space on the right or below, the menu opens on the other side of the pointer.
            if (left > maxLeft) left = (point?.flipX ?? left) - width;
            if (top > maxTop) top = (point?.flipY ?? top) - height;
        }
        setPosition({
            left: Math.max(EDGE, Math.min(left, maxLeft)),
            top: Math.max(EDGE, Math.min(top, maxTop))
        });
    }, [anchor, point]);

    useEffect(() => {
        if (!open) panel.current?.focus({ preventScroll: true });
    }, [open]);

    const firstUsable = () => items.findIndex(usable);
    const lastUsable = () => items.length - 1 - [...items].reverse().findIndex(usable);

    const step = (direction: 1 | -1) => {
        if (!items.some(usable)) return;
        // With no active item, ArrowDown starts at the first item and ArrowUp at the last item.
        let index = active < 0 ? (direction === 1 ? -1 : 0) : active;
        do {
            index = (index + direction + items.length) % items.length;
        } while (!usable(items[index]));
        setActive(index);
    };

    const activate = (index: number, fromKey: boolean) => {
        const item = items[index];
        if (!item || !usable(item) || 'type' in item) return;
        if ('submenu' in item) setOpen({ index, fromKey });
        else onChoose(item.id);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        event.stopPropagation();
        const keys: Record<string, () => void> = {
            ArrowDown: () => step(1),
            ArrowUp: () => step(-1),
            ArrowRight: () => { if (active >= 0 && 'submenu' in items[active]) activate(active, true); },
            ArrowLeft: () => { if (anchor) onBack(); },
            Home: () => setActive(firstUsable()),
            End: () => { if (items.some(usable)) setActive(lastUsable()); },
            Escape: onBack,
            // Tab closes all the menus. The focus goes back to the element that had it before.
            Tab: () => close(undefined),
            Enter: () => activate(active, true),
            ' ': () => activate(active, true)
        };
        const action = keys[event.key];
        if (!action) return;
        event.preventDefault();
        action();
    };

    const openItem = open ? items[open.index] : undefined;
    const openRow = open ? rows.current[open.index] : null;

    return (
        <div
            ref={panel}
            className="context-menu"
            role="menu"
            tabIndex={-1}
            style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
            onKeyDown={onKeyDown}
            onContextMenu={event => event.preventDefault()}
        >
            {items.map((item, index) => {
                if ('type' in item) return <div key={index} className="context-menu-separator" role="separator" />;
                const enabled = item.enabled !== false;
                const hasSubmenu = 'submenu' in item;
                const danger = 'danger' in item && item.danger;
                return (
                    <div
                        key={index}
                        ref={element => { rows.current[index] = element; }}
                        className={`context-menu-item${index === active ? ' active' : ''}${enabled ? '' : ' disabled'}${danger ? ' danger' : ''}`}
                        role="menuitem"
                        aria-disabled={!enabled}
                        aria-haspopup={hasSubmenu ? 'menu' : undefined}
                        aria-expanded={hasSubmenu ? open?.index === index : undefined}
                        onPointerEnter={() => {
                            if (!enabled) return;
                            setActive(index);
                            setOpen(hasSubmenu ? { index, fromKey: false } : undefined);
                        }}
                        onPointerLeave={() => { if (!hasSubmenu || open?.index !== index) setActive(-1); }}
                        onClick={() => activate(index, false)}
                    >
                        <span className="context-menu-label">{item.label}</span>
                        {hasSubmenu && <ChevronRight className="context-menu-chevron" size={13} strokeWidth={1.8} />}
                    </div>
                );
            })}
            {openItem && 'submenu' in openItem && openRow && panel.current && (
                <MenuPanel
                    key={open!.index}
                    items={openItem.submenu}
                    anchor={{ item: openRow.getBoundingClientRect(), parent: panel.current.getBoundingClientRect() }}
                    initialActive={open!.fromKey ? openItem.submenu.findIndex(usable) : -1}
                    onChoose={onChoose}
                    onBack={() => setOpen(undefined)}
                />
            )}
        </div>
    );
}

/** Shows the context menu of `showContextMenu`. Put it one time at the root of the page. */
export function ContextMenuHost() {
    const request = useSyncExternalStore(subscribe, () => current);
    const previousFocus = useRef<Element | null>(null);

    useEffect(() => {
        if (!request) return;
        previousFocus.current = document.activeElement;
        const dismiss = () => close(undefined);
        window.addEventListener('blur', dismiss);
        window.addEventListener('resize', dismiss);
        return () => {
            window.removeEventListener('blur', dismiss);
            window.removeEventListener('resize', dismiss);
            // Give the focus back to the element that had it before the menu opened.
            if (previousFocus.current instanceof HTMLElement && document.contains(previousFocus.current)) previousFocus.current.focus();
        };
    }, [request]);

    if (!request) return null;
    return (
        <div
            className="context-menu-layer"
            onPointerDown={event => { if (event.target === event.currentTarget) close(undefined); }}
            onContextMenu={event => {
                event.preventDefault();
                if (event.target === event.currentTarget) close(undefined);
            }}
        >
            <MenuPanel
                key={`${request.x},${request.y}`}
                items={request.items}
                point={request}
                initialActive={request.keyboard ? request.items.findIndex(usable) : -1}
                onChoose={id => close(id)}
                onBack={() => close(undefined)}
            />
        </div>
    );
}
