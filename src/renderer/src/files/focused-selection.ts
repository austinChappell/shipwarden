import { monaco } from '../editor/monaco';
import { terminalPool } from '../terminal/terminal-pool';
import { searchText, selectedText } from '../components/selected-text';

/** Returns the selected text of the focused editor, also of each side of a diff. Returns undefined without a focused editor. */
function editorSelection(): string | undefined {
    const editor = monaco.editor.getEditors().find(item => item.hasTextFocus());
    if (!editor) return undefined;
    const model = editor.getModel();
    const selection = editor.getSelection();
    return model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : '';
}

/** Returns the selected text of the focused terminal. Returns undefined without a focused terminal. */
function terminalSelection(): string | undefined {
    const active = document.activeElement;
    if (!active) return undefined;
    for (const terminal of terminalPool.terminals.values()) {
        if (terminal.element?.contains(active)) {
            return terminal.hasSelection() ? terminal.getSelection() : '';
        }
    }
    return undefined;
}

/** Returns the selected text of the focused text field. Returns undefined when no text field has the focus. */
function fieldSelection(): string | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return undefined;
    const { selectionStart, selectionEnd, value } = active;
    return selectionStart !== null && selectionEnd !== null ? value.slice(selectionStart, selectionEnd) : '';
}

/**
 * Returns the selected text for the content search: the selection of the focused editor, terminal or text field, else
 * the selection of the page. Returns undefined when nothing is selected.
 */
export function focusedSelection(): string | undefined {
    return searchText(editorSelection() ?? terminalSelection() ?? fieldSelection() ?? selectedText());
}
