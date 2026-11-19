import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { moveIndex, reorderKeyDelta } from './reorder';

/** The place where a dragged item goes: before or after another item. */
interface DropTarget {
    key: string;
    after: boolean;
}

/**
 * Drag and drop to change the order of a list. `onMove` gets the key of the dragged item and its new index.
 * The returned `itemProps` go on each item. `dropClass` gives the class that shows the drop line.
 * The `onKeyDown` handler of each item calls `moveByKey`, so Alt+Up and Alt+Down move the item from the keyboard.
 */
export function useReorder(keys: readonly string[], onMove: (key: string, toIndex: number) => void, enabled = true) {
    const [dragged, setDragged] = useState<string>();
    const [target, setTarget] = useState<DropTarget>();

    const end = () => {
        setDragged(undefined);
        setTarget(undefined);
    };

    const itemProps = (key: string) =>
        enabled
            ? {
                  draggable: true,
                  'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
                  onDragStart: (event: DragEvent) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', key);
                      setDragged(key);
                  },
                  onDragOver: (event: DragEvent<HTMLElement>) => {
                      if (dragged === undefined) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const box = event.currentTarget.getBoundingClientRect();
                      const after = event.clientY > box.top + box.height / 2;
                      if (target?.key !== key || target.after !== after) setTarget({ key, after });
                  },
                  onDrop: (event: DragEvent) => {
                      event.preventDefault();
                      if (dragged !== undefined && target) {
                          const from = keys.indexOf(dragged);
                          let to = keys.indexOf(target.key) + (target.after ? 1 : 0);
                          if (from < to) to -= 1;
                          if (from !== -1 && from !== to) onMove(dragged, to);
                      }
                      end();
                  },
                  onDragEnd: end
              }
            : {};

    const dropClass = (key: string) => {
        if (dragged === undefined) return '';
        if (dragged === key) return ' dragging';
        return target?.key === key ? (target.after ? ' drop-after' : ' drop-before') : '';
    };

    /** The item that a key moved. It gets the focus again when the list shows the new order. */
    const moved = useRef<{ element: HTMLElement; key: string; to: number } | undefined>(undefined);
    useEffect(() => {
        const item = moved.current;
        if (!item || keys.indexOf(item.key) !== item.to) return;
        moved.current = undefined;
        if (item.element.isConnected && document.activeElement !== item.element) item.element.focus();
        item.element.scrollIntoView({ block: 'nearest' });
    }, [keys]);

    /** Alt+Up and Alt+Down move the item one place. Returns true when the handler used the key. */
    const moveByKey = (event: ReactKeyboardEvent<HTMLElement>, key: string): boolean => {
        const delta = enabled ? reorderKeyDelta(event) : undefined;
        if (delta === undefined) return false;
        event.preventDefault();
        event.stopPropagation();
        const to = moveIndex(keys, key, delta);
        if (to !== undefined) {
            moved.current = { element: event.currentTarget, key, to };
            onMove(key, to);
        }
        return true;
    };

    /** The tooltip text that tells how to change the order. Undefined when the order cannot change. */
    const hint = enabled ? 'Drag, or press ⌥↑ or ⌥↓, to change the order' : undefined;

    return { itemProps, dropClass, moveByKey, hint };
}
