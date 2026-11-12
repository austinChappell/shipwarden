import type { ReactNode } from 'react';
import { SquareArrowOutUpRight, X } from 'lucide-react';
import { leafOfTab, type PaneLayout, type PaneNode, type SplitSide } from '@shared/panes';
import { SplitDivider } from '../components/SplitDivider';
import { IconButton } from '../components/ui';
import { nearestSide, type TabKey } from './tabs';

interface Props {
    layout: PaneLayout;
    node: PaneNode;
    /** Shows the view of a tab. `focused` is false for a pane without the focus. */
    renderTab: (tab: TabKey, focused: boolean) => ReactNode;
    tabTitle: (tab: TabKey) => string;
    /** The tab that the user drags now. */
    draggingTab: TabKey | undefined;
    /** The pane and the side under the pointer while the user drags a tab. */
    dropTarget: { leafId: string; side: SplitSide } | undefined;
    setDropTarget: (update: (current: { leafId: string; side: SplitSide } | undefined) => { leafId: string; side: SplitSide } | undefined) => void;
    onFocusPane: (leafId: string) => void;
    onResize: (splitId: string, ratio: number) => void;
    onMoveToTab: (leafId: string) => void;
    onClosePane: (leafId: string) => void;
    /** Drops the dragged tab at a side of a pane. */
    onDrop: (dragged: TabKey, leafId: string, side: SplitSide) => void;
}

/** The pane side that is nearest to the pointer. The dropped tab goes to that side. */
function dropSide(event: React.DragEvent<HTMLElement>): SplitSide {
    const rect = event.currentTarget.getBoundingClientRect();
    return nearestSide((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
}

/** Shows a node of the split view: a pane with its tab, or a split with a divider between its two parts. */
export function PaneTree(props: Props): ReactNode {
    const { layout, node, renderTab, tabTitle, draggingTab, dropTarget, setDropTarget } = props;
    const split = layout.root.kind === 'split';
    if (node.kind === 'split') {
        return (
            <div key={node.id} className={`pane-split ${node.direction}`}>
                <div className="pane-slot" style={{ flexBasis: `${node.ratio * 100}%` }}>
                    <PaneTree {...props} node={node.first} />
                </div>
                <SplitDivider direction={node.direction} ratio={node.ratio} onResize={ratio => props.onResize(node.id, ratio)} />
                <div className="pane-slot" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
                    <PaneTree {...props} node={node.second} />
                </div>
            </div>
        );
    }
    const focused = !split || layout.focused === node.id;
    const target = dropTarget?.leafId === node.id ? dropTarget.side : undefined;
    return (
        <div
            key={node.id}
            data-pane={node.id}
            className={`pane${split ? (focused ? ' focused' : ' unfocused') : ''}`}
            onMouseDownCapture={() => props.onFocusPane(node.id)}
        >
            {renderTab(node.tab, focused)}
            {split && (
                <div className="pane-actions">
                    <span className="pane-title">{tabTitle(node.tab)}</span>
                    <IconButton
                        size="sm"
                        icon={<SquareArrowOutUpRight size={13} strokeWidth={1.7} />}
                        label="Move to its own tab"
                        onClick={() => props.onMoveToTab(node.id)}
                    />
                    <IconButton size="sm" icon={<X size={13} strokeWidth={1.8} />} label="Close this pane" onClick={() => props.onClosePane(node.id)} />
                </div>
            )}
            {draggingTab && !leafOfTab(layout, draggingTab) && (
                // A layer over the pane takes the drag events, so the editor or the terminal below does not take the drop.
                <div
                    className="pane-drop-layer"
                    onDragOver={event => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        const side = dropSide(event);
                        if (target !== side) setDropTarget(() => ({ leafId: node.id, side }));
                    }}
                    onDragLeave={() => setDropTarget(current => (current?.leafId === node.id ? undefined : current))}
                    onDrop={event => {
                        event.preventDefault();
                        props.onDrop(draggingTab, node.id, dropSide(event));
                    }}
                >
                    {target && <div className={`pane-drop-zone ${target}`} />}
                </div>
            )}
        </div>
    );
}
