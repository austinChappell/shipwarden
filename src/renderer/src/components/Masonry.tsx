import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
    children: ReactNode;
    /** The layout uses 2 columns when each column can have this width. */
    minColumnWidth: number;
    /** The space between the columns and between the items, in pixels. */
    gap: number;
    /**
     * The items move to other columns only when this value or the column count changes, for example after a load.
     * A change in the height of an item (an expanded comment) does not move the items.
     */
    layoutKey: string;
}

/** Places each item in the shorter of at most 2 columns, in the order of the items. */
export function Masonry({ children, minColumnWidth, gap, layoutKey }: Props) {
    const root = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
    const items = Children.toArray(children);
    const [columns, setColumns] = useState(1);
    const [placement, setPlacement] = useState<number[]>([]);

    useEffect(() => {
        const element = root.current;
        if (!element) return;
        const observer = new ResizeObserver(() => setColumns(element.clientWidth >= minColumnWidth * 2 + gap ? 2 : 1));
        observer.observe(element);
        return () => observer.disconnect();
    }, [minColumnWidth, gap]);

    useLayoutEffect(() => {
        if (columns === 1) {
            setPlacement(items.map(() => 0));
            return;
        }
        const heights = [0, 0];
        const next = items.map((_, index) => {
            const column = heights[0] <= heights[1] ? 0 : 1;
            heights[column] += (itemRefs.current[index]?.offsetHeight ?? 0) + gap;
            return column;
        });
        setPlacement(current => (current.length === next.length && current.every((value, index) => value === next[index]) ? current : next));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [columns, layoutKey, items.length]);

    return (
        <div ref={root} className="masonry" style={{ gap }}>
            {Array.from({ length: columns }, (_, column) => (
                <div key={column} className="masonry-column" style={{ gap }}>
                    {items.map((item, index) => ((placement[index] ?? index % columns) === column ? (
                        <div key={index} ref={element => { itemRefs.current[index] = element; }}>{item}</div>
                    ) : null))}
                </div>
            ))}
        </div>
    );
}
