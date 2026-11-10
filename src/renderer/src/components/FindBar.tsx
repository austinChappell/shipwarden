import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { DiffSide } from '@shared/github';
import { findCountText } from '../github/diff-notes';

/**
 * Returns the element of a diff line. The diff is in a shadow root. A removed line has the old line number,
 * and the other lines have the new line number. Returns undefined when the line is not rendered.
 */
export function findLineElement(section: HTMLElement, side: DiffSide, line: number): HTMLElement | undefined {
    for (const host of section.querySelectorAll('*')) {
        const root = host.shadowRoot;
        if (!root) continue;
        for (const element of root.querySelectorAll<HTMLElement>(`[data-line="${line}"]`)) {
            const removed = (element.dataset.lineType ?? '').includes('deletion');
            if (removed === (side === 'LEFT')) return element;
        }
    }
    return undefined;
}

/** The search bar of the changed files (⌘F). Enter goes to the next match, Shift+Enter to the previous one. */
export function FindBar({ query, caseSensitive, count, index, focusNonce, onQuery, onCaseSensitive, onMove, onClose }: {
    query: string;
    caseSensitive: boolean;
    count: number;
    index: number;
    focusNonce: number;
    onQuery(value: string): void;
    onCaseSensitive(value: boolean): void;
    onMove(step: 1 | -1): void;
    onClose(): void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [focusNonce]);
    return (
        <div className="find-bar" role="search">
            <Search size={13} strokeWidth={1.6} />
            <input
                ref={inputRef}
                value={query}
                placeholder="Find in the changes"
                aria-label="Find in the changes"
                onChange={event => onQuery(event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        onMove(event.shiftKey ? -1 : 1);
                    }
                    if (event.key === 'Escape') onClose();
                }}
            />
            <span className="find-count">{findCountText(query, count, index)}</span>
            <button className={`icon-button find-case${caseSensitive ? ' selected' : ''}`} title="Match case" aria-pressed={caseSensitive} onClick={() => onCaseSensitive(!caseSensitive)}>Aa</button>
            <button className="icon-button" title="Previous match (Shift+Enter)" disabled={!count} onClick={() => onMove(-1)}><ChevronUp size={14} /></button>
            <button className="icon-button" title="Next match (Enter)" disabled={!count} onClick={() => onMove(1)}><ChevronDown size={14} /></button>
            <button className="icon-button" title="Close (Escape)" onClick={onClose}><X size={14} /></button>
        </div>
    );
}
