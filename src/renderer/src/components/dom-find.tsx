import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { FindBar } from './FindBar';
import { claimLogFind, isFindShortcut, type LogFindOwner, openLogFind, releaseLogFind } from './log-find';

/** The names of the CSS highlights. styles.css gives their colors with ::highlight(). */
const ALL = 'find-match';
const CURRENT = 'find-current';

/** True when the text node is in a field, or in an element that the page does not show. */
function skipNode(node: Node): boolean {
    const parent = node.parentElement;
    return !parent || !!parent.closest('input, textarea, script, style, [data-find-skip]') || parent.getClientRects().length === 0;
}

/**
 * Returns the ranges of `query` in the text of `root`, in the order of the document.
 * A match can go across elements, for example across the end of a code span. Without `caseSensitive`, "A" and "a" match.
 */
export function findTextRanges(root: Element, query: string, caseSensitive: boolean): Range[] {
    if (!query) return [];
    const nodes: Text[] = [];
    const starts: number[] = [];
    let text = '';
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (skipNode(node)) continue;
        nodes.push(node as Text);
        starts.push(text.length);
        text += node.nodeValue ?? '';
    }
    // toLowerCase can change the length of a few characters. Then the search matches the case, so that each offset stays correct.
    const lower = text.toLowerCase();
    const ignoreCase = !caseSensitive && lower.length === text.length;
    const haystack = ignoreCase ? lower : text;
    const needle = ignoreCase ? query.toLowerCase() : query;

    // Returns the text node and the offset in it of a position in the full text.
    const locate = (position: number, end: boolean): [Text, number] => {
        let low = 0;
        let high = starts.length - 1;
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            // The end of a match stays in the node of its last character.
            if (end ? starts[middle] < position : starts[middle] <= position) low = middle;
            else high = middle - 1;
        }
        return [nodes[low], position - starts[low]];
    };

    const ranges: Range[] = [];
    for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) {
        const range = root.ownerDocument.createRange();
        range.setStart(...locate(index, false));
        range.setEnd(...locate(index + needle.length, true));
        ranges.push(range);
    }
    return ranges;
}

/** Shows the ranges with the CSS highlights. No ranges removes the highlights. */
function paint(ranges: Range[], current: number): void {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    CSS.highlights.set(ALL, new Highlight(...ranges));
    CSS.highlights.set(CURRENT, new Highlight(...(ranges[current] ? [ranges[current]] : [])));
}

interface FindState {
    open: boolean;
    query: string;
    caseSensitive: boolean;
    count: number;
    index: number;
    focusNonce: number;
}

const CLOSED: FindState = { open: false, query: '', caseSensitive: false, count: 0, index: 0, focusNonce: 0 };

/**
 * ⌘F for the text of a view, for example the chat of an agent. The view owns ⌘F after a click or a focus in it.
 * A click or a focus in a different place removes the ownership. Returns the search bar, or null when it is closed.
 * Put the bar in an element that does not scroll, so that the bar stays at the top.
 */
export function useDomFind(rootRef: RefObject<HTMLElement | null>, label: string) {
    const [find, setFind] = useState<FindState>(CLOSED);
    const ranges = useRef<Range[]>([]);
    const barRef = useRef<HTMLDivElement>(null);

    /** Finds the matches and shows one. A step of 0 keeps the index of the current match. */
    const search = useCallback(
        (query: string, caseSensitive: boolean, step: -1 | 0 | 1, from = 0) => {
            const root = rootRef.current;
            const found = root ? findTextRanges(root, query, caseSensitive) : [];
            ranges.current = found;
            const index = found.length ? (((from + step) % found.length) + found.length) % found.length : 0;
            paint(found, index);
            found[index]?.startContainer.parentElement?.scrollIntoView({ block: 'center' });
            setFind(state => ({ ...state, query, caseSensitive, count: found.length, index }));
        },
        [rootRef]
    );

    const close = useCallback(() => {
        ranges.current = [];
        paint([], 0);
        setFind(state => ({ ...state, open: false }));
    }, []);

    // The newest state for the owner, which the effect below makes one time.
    const latest = useRef({ find, search });
    latest.current = { find, search };

    useEffect(() => {
        const owner: LogFindOwner = {
            open() {
                const root = rootRef.current;
                // A view in a tab that is not selected has no box.
                if (!root || root.getClientRects().length === 0) return false;
                const { find, search } = latest.current;
                const selected = window.getSelection()?.toString() ?? '';
                const query = selected && !selected.includes('\n') && root.contains(window.getSelection()?.anchorNode ?? null) ? selected : find.query;
                setFind(state => ({ ...state, open: true, focusNonce: state.focusNonce + 1 }));
                search(query, find.caseSensitive, 0, find.open ? find.index : 0);
                return true;
            }
        };
        const onTouch = (event: Event) => {
            if (!(event.target instanceof Node)) return;
            if (rootRef.current?.contains(event.target) || barRef.current?.contains(event.target)) claimLogFind(owner);
            else releaseLogFind(owner);
        };
        const onKey = (event: KeyboardEvent) => {
            if (isFindShortcut(event)) openLogFind(event);
        };
        window.addEventListener('pointerdown', onTouch, true);
        window.addEventListener('focusin', onTouch, true);
        window.addEventListener('keydown', onKey, true);
        return () => {
            releaseLogFind(owner);
            // The highlights are for the full page. Remove them only when they are the matches of this view.
            if (ranges.current.length) paint([], 0);
            window.removeEventListener('pointerdown', onTouch, true);
            window.removeEventListener('focusin', onTouch, true);
            window.removeEventListener('keydown', onKey, true);
        };
    }, [rootRef]);

    if (!find.open) return null;
    return (
        <div className="floating-find" ref={barRef}>
            <FindBar
                label={label}
                query={find.query}
                caseSensitive={find.caseSensitive}
                count={find.count}
                index={find.index}
                focusNonce={find.focusNonce}
                onQuery={value => search(value, find.caseSensitive, 0, find.index)}
                onCaseSensitive={value => search(find.query, value, 0, find.index)}
                onMove={step => search(find.query, find.caseSensitive, step, find.index)}
                onClose={close}
            />
        </div>
    );
}
