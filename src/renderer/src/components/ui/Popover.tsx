import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** The space between the anchor and the popover, in pixels. */
const GAP = 4;
/** The smallest space between the popover and the edge of the window, in pixels. */
const MARGIN = 8;

interface Rect {
    top: number;
    bottom: number;
    left: number;
    width: number;
}

/**
 * Calculates the position of a popover below its anchor. When the space below is too small and the space above is
 * larger, the popover goes above the anchor. The popover stays inside the window.
 */
export function popoverPosition(anchor: Rect, size: { width: number; height: number }, window: { width: number; height: number }): CSSProperties {
    const below = window.height - anchor.bottom - GAP - MARGIN;
    const above = anchor.top - GAP - MARGIN;
    const up = size.height > below && above > below;
    const maxHeight = Math.max(80, up ? above : below);
    const left = Math.max(MARGIN, Math.min(anchor.left, window.width - size.width - MARGIN));
    return up
        ? { left, bottom: window.height - anchor.top + GAP, maxHeight, minWidth: anchor.width }
        : { left, top: anchor.bottom + GAP, maxHeight, minWidth: anchor.width };
}

interface Props {
    /** The element that the popover shows below, for example the button that opens it. */
    anchor: RefObject<HTMLElement | null>;
    onClose(): void;
    className?: string;
    children: ReactNode;
}

/**
 * A popover in a layer above the page. A scroll area or a dialog does not cut it. A click outside the popover and
 * outside the anchor closes it. A scroll outside the popover also closes it, because the anchor moves.
 */
export function Popover({ anchor, onClose, className, children }: Props) {
    const ref = useRef<HTMLDivElement>(null);
    const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden', top: 0, left: 0 });
    const close = useRef(onClose);
    close.current = onClose;

    useLayoutEffect(() => {
        const place = () => {
            const target = anchor.current;
            const element = ref.current;
            if (!target || !element) return;
            const box = target.getBoundingClientRect();
            setStyle(
                popoverPosition(
                    { top: box.top, bottom: box.bottom, left: box.left, width: box.width },
                    { width: element.offsetWidth, height: element.scrollHeight },
                    { width: window.innerWidth, height: window.innerHeight }
                )
            );
        };
        place();
        // The content can change its size, for example when the options load. Then the position changes too.
        const observer = new ResizeObserver(place);
        if (ref.current) observer.observe(ref.current);
        const inside = (target: EventTarget | null) => target instanceof Node && (!!ref.current?.contains(target) || !!anchor.current?.contains(target));
        const onDown = (event: MouseEvent) => {
            if (!inside(event.target)) close.current();
        };
        const onScroll = (event: Event) => {
            if (!(event.target instanceof Node && ref.current?.contains(event.target))) close.current();
        };
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', place);
        return () => {
            observer.disconnect();
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', place);
        };
    }, [anchor]);

    return createPortal(
        <div ref={ref} className={`popover${className ? ` ${className}` : ''}`} style={style}>
            {children}
        </div>,
        document.body
    );
}
