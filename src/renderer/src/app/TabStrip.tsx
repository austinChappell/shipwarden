import { Columns2, X } from 'lucide-react';
import { leaves, type PaneLayout } from '@shared/panes';
import { moveTabFocus } from '../tablist';
import { isStripItemActive, type StripItem, type TabKey } from './tabs';
import type { TabInfo } from './tab-info';

interface Props {
    items: StripItem[];
    activeTab: TabKey | undefined;
    info: (key: TabKey) => TabInfo;
    onSelect: (key: TabKey) => void;
    /** Moves the entry at `index` one step to the left (-1) or to the right (1). */
    onMove: (index: number, step: 1 | -1) => void;
    onCloseTab: (key: TabKey) => void;
    onCloseGroup: (group: PaneLayout) => void;
    onDragStart: (key: TabKey) => void;
    onDragEnd: () => void;
}

/** The tab strip of the worktree view. A split tab shows the number of its panes. */
export function TabStrip({ items, activeTab, info, onSelect, onMove, onCloseTab, onCloseGroup, onDragStart, onDragEnd }: Props) {
    /**
     * The keys of a tab in the tab strip. ← and → move the focus to the previous or the next tab. Enter and Space select
     * the tab. ⌃⇧← and ⌃⇧→ move the tab.
     */
    const tabKeyDown = (event: React.KeyboardEvent<HTMLElement>, index: number, key: TabKey) => {
        if (event.target !== event.currentTarget) return;
        if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            onMove(index, event.key === 'ArrowLeft' ? -1 : 1);
            return;
        }
        if (moveTabFocus(event)) return;
        if ((event.key === 'Enter' || event.key === ' ') && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            onSelect(key);
        }
    };

    /** The drag start of a tab. The tab can go to a side of a pane (a split) or into a pane. */
    const tabDragProps = (key: TabKey) => ({
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
            event.dataTransfer.setData('text/plain', key);
            event.dataTransfer.effectAllowed = 'move';
            onDragStart(key);
        },
        onDragEnd
    });

    return (
        <div
            className="tabs"
            role="tablist"
            aria-label="Tabs"
            onWheel={event => {
                // The strip has no scroll bar. A mouse wheel scrolls vertically, so turn that into a sideways scroll.
                if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                    event.currentTarget.scrollLeft += event.deltaY;
                }
            }}
        >
            {items.map((item, index) => {
                const { key, group } = item;
                const tab = info(key);
                const count = group ? leaves(group.root).length : 1;
                const active = isStripItemActive(item, activeTab);
                return (
                    <div
                        key={group ? group.root.id : key}
                        className={`tab${active ? ' active' : ''}${tab.dirty ? ' dirty' : ''}${tab.exited ? ' exited' : ''}${group ? ' split-tab' : ''}`}
                        title={group ? `${count} panes: ${leaves(group.root).map(leaf => info(leaf.tab).title).join(', ')}` : tab.tooltip}
                        role="tab"
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        onClick={() => onSelect(key)}
                        onKeyDown={event => tabKeyDown(event, index, key)}
                        {...tabDragProps(key)}
                    >
                        {group ? <Columns2 className="tab-icon" size={14} strokeWidth={1.5} /> : tab.icon}
                        <span className="tab-title">{tab.title}</span>
                        {group && <span className="tab-count">{count}</span>}
                        <button
                            className="tab-close"
                            // Only the close button of the selected tab is in the Tab order.
                            tabIndex={active ? 0 : -1}
                            title={group ? 'Close the tab and all its panes' : tab.dirty ? 'Unsaved changes. Close file.' : 'Close'}
                            onClick={event => {
                                event.stopPropagation();
                                if (group) onCloseGroup(group);
                                else onCloseTab(key);
                            }}
                        >
                            <span className="tab-dirty-dot" />
                            <X size={13} strokeWidth={1.75} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
