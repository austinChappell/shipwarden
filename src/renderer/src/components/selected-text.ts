import { useEffect, type RefObject } from 'react';
import { showContextMenu } from './ContextMenu';

/** A request to open a search bar (⌘F). A new `at` value is a new request. `text` goes into the search field. */
export interface FindRequest {
    at: number;
    text?: string;
}

/** Returns true when the element is a text field. A text field has its own selection and its own copy. */
function isTextField(element: Element | null): boolean {
    return !!element?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/**
 * Returns the selected text of the page. Returns undefined when the selection is empty, when a text field has the focus,
 * or when the selection is not in `root`. The diff is in a shadow root. The page selection then starts at an element
 * that contains the diff, so `root.contains` also finds a selection in the diff.
 */
export function selectedText(root?: Node | null): string | undefined {
    if (isTextField(document.activeElement)) return undefined;
    // Do not use isCollapsed. For a selection in a shadow root, the page selection is collapsed at the host but has the text.
    const selection = document.getSelection();
    if (selection?.type !== 'Range') return undefined;
    const text = selection.toString();
    if (!text) return undefined;
    if (root && !(selection.anchorNode && root.contains(selection.anchorNode))) return undefined;
    return text;
}

/**
 * Returns the text for the search field from a selection. The search finds text in one line only,
 * so a selection of more than one line gives undefined. One line break at the end is removed.
 */
export function findText(text: string | undefined): string | undefined {
    const line = text?.replace(/\r?\n$/, '');
    if (!line || /[\r\n]/.test(line)) return undefined;
    return line;
}

/** Makes a find request with the selected text of the page. */
export function findRequest(root?: Node | null): FindRequest {
    return { at: Date.now(), text: findText(selectedText(root)) };
}

function copy(text: string): void {
    navigator.clipboard.writeText(text).catch(error => console.error('[copy] The selected text was not copied:', error));
}

/**
 * Adds a "Copy" menu to the selected text in `root`, also to the text in a diff. A right click on a selection opens the menu.
 * ⌘C needs no code here: the Edit menu of the app copies the selection.
 * The listener reads `root` at each event, so a root that renders later also works.
 */
export function useCopySelection(root: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        const onContextMenu = (event: MouseEvent) => {
            const element = root.current;
            const target = event.target instanceof Element ? event.target : undefined;
            if (event.defaultPrevented || !element || !target || !element.contains(target) || isTextField(target)) return;
            const text = selectedText(element);
            if (!text) return;
            event.preventDefault();
            void showContextMenu([{ id: 'copy', label: 'Copy' }]).then(choice => {
                if (choice === 'copy') copy(text);
            });
        };
        window.addEventListener('contextmenu', onContextMenu);
        return () => window.removeEventListener('contextmenu', onContextMenu);
    }, [root]);
}
