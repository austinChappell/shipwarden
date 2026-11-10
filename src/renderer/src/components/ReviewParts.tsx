import { Fragment, useEffect, useRef, type RefObject } from 'react';
import { CircleCheck, CircleX, Clock } from 'lucide-react';
import { checkLevel, type CheckSummary } from '@shared/review-queue';
import { NAV_ITEM } from '../keyboard/list-nav';

/** One entry of the key legend at the bottom of a page. */
export interface LegendItem {
    keys: string[];
    label: string;
}

/** The row of keys at the bottom of a Review page. */
export function KeyLegend({ items }: { items: LegendItem[] }) {
    return (
        <footer className="key-legend" aria-label="Keyboard shortcuts">
            {items.map(item => (
                <span key={item.label} className="key-legend-item">
                    {item.keys.map(key => <kbd key={key}>{key}</kbd>)}
                    <span>{item.label}</span>
                </span>
            ))}
        </footer>
    );
}

/** A count in a column. Zero shows a dash. */
export function CountPill({ value, tone }: { value: number; tone: 'info' | 'accent' | 'plain' }) {
    if (value === 0) return <span className="count-pill-none">—</span>;
    return <span className={`count-pill ${tone}`}>{value}</span>;
}

/** The checks of one pull request, as an icon and a short text. */
export function ChecksLabel({ checks }: { checks: CheckSummary }) {
    const level = checkLevel(checks);
    const props = { size: 14, strokeWidth: 1.8 };
    if (level === 'failing') return <span className="checks-label failing"><CircleX {...props} />{checks.failing || 1} failing</span>;
    if (level === 'running') return <span className="checks-label running"><Clock {...props} />Running</span>;
    if (level === 'passing') return <span className="checks-label passing"><CircleCheck {...props} />Checks pass</span>;
    return <span className="checks-label none">No checks</span>;
}

/** Joins the parts with a middle dot. */
export function Dotted({ parts }: { parts: React.ReactNode[] }) {
    const shown = parts.filter(part => part !== null && part !== undefined && part !== false && part !== '');
    return <>{shown.map((part, index) => <Fragment key={index}>{index > 0 && ' · '}{part}</Fragment>)}</>;
}

function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
}

/**
 * Moves the focus between the list items in the container. `delta` is +1 for the next item and -1 for the previous item.
 * Without a focused item, the first item gets the focus.
 */
export function stepFocus(container: HTMLElement | null, delta: number): void {
    const items = [...(container?.querySelectorAll<HTMLElement>(NAV_ITEM) ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = index === -1 ? items[0] : items[Math.min(items.length - 1, Math.max(0, index + delta))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
}

/**
 * Adds the page keys of a Review page. j and Down move to the next item, k and Up move to the previous item.
 * The other keys come from `keys`, by `event.key`. The keys work when the focus is in `root` or on the page body,
 * and not in a text field. Keys with ⌘, Ctrl or Alt do not apply.
 */
export function usePageKeys(root: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>, keys: Record<string, () => void>, enabled = true): void {
    const keysRef = useRef(keys);
    keysRef.current = keys;
    useEffect(() => {
        if (!enabled) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
            if (isEditable(event.target)) return;
            const target = event.target as Node | null;
            const inside = target === document.body || (!!target && !!root.current?.contains(target));
            if (!inside) return;
            let action: (() => void) | undefined;
            if (event.key === 'j' || (event.key === 'ArrowDown' && target === document.body)) action = () => stepFocus(list.current, 1);
            else if (event.key === 'k' || (event.key === 'ArrowUp' && target === document.body)) action = () => stepFocus(list.current, -1);
            else action = keysRef.current[event.key];
            if (!action) return;
            event.preventDefault();
            action();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [root, list, enabled]);
}

/** Returns the value of a data attribute of the focused list item, or undefined. */
export function focusedData(name: string): string | undefined {
    const element = document.activeElement;
    return element instanceof HTMLElement && element.matches(NAV_ITEM) ? element.dataset[name] : undefined;
}

/**
 * Gives the focus to the item that matches `selector` in the container, after the first render.
 * Without a match, the first item gets the focus. It does nothing when another element has the focus.
 * It runs again each time `ready` changes from false to true.
 */
export function useInitialFocus(container: RefObject<HTMLElement | null>, selector: string | undefined, ready: boolean): void {
    const done = useRef(false);
    // A page that hides and shows again (not ready, then ready) gives the focus again.
    useEffect(() => {
        if (!ready) done.current = false;
    }, [ready]);
    useEffect(() => {
        if (done.current || !ready) return;
        done.current = true;
        const active = document.activeElement;
        if (active && active !== document.body && !container.current?.contains(active)) return;
        const element = (selector && container.current?.querySelector<HTMLElement>(selector)) || container.current?.querySelector<HTMLElement>(NAV_ITEM);
        element?.focus({ preventScroll: false });
        element?.scrollIntoView({ block: 'nearest' });
    }, [container, selector, ready]);
}
