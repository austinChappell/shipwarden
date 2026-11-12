import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { DiffSide } from '@shared/github';
import { findCountText, type RenderedLine } from '../github/diff-notes';
import { IconButton, Input } from './ui';

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

/** Returns the lines that the diff in a file section shows now, with the top of each box. */
export function renderedLines(section: HTMLElement): RenderedLine[] {
    const list: RenderedLine[] = [];
    for (const host of section.querySelectorAll('*')) {
        const root = host.shadowRoot;
        if (!root) continue;
        for (const element of root.querySelectorAll<HTMLElement>('[data-line]')) {
            const line = Number(element.dataset.line);
            if (Number.isFinite(line)) list.push({ line, top: element.getBoundingClientRect().top });
        }
    }
    return list;
}

/** The search bar of the changed files (⌘F). Enter goes to the next match, Shift+Enter to the previous one. */
export function FindBar({
    query,
    caseSensitive,
    count,
    index,
    focusNonce,
    onQuery,
    onCaseSensitive,
    onMove,
    onClose
}: {
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: Each new focusNonce is a new request to focus the input.
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [focusNonce]);
    return (
        <div className="find-bar" role="search">
            <Input
                ref={inputRef}
                size="sm"
                className="find-bar-input"
                icon={<Search size={13} strokeWidth={1.6} />}
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
            <IconButton
                size="sm"
                className="find-case"
                icon="Aa"
                label="Match case"
                aria-pressed={caseSensitive}
                onClick={() => onCaseSensitive(!caseSensitive)}
            />
            <IconButton size="sm" icon={<ChevronUp size={14} />} label="Previous match (Shift+Enter)" disabled={!count} onClick={() => onMove(-1)} />
            <IconButton size="sm" icon={<ChevronDown size={14} />} label="Next match (Enter)" disabled={!count} onClick={() => onMove(1)} />
            <IconButton size="sm" icon={<X size={14} />} label="Close (Escape)" onClick={onClose} />
        </div>
    );
}
