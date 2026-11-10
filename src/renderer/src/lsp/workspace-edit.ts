import type { IRange } from 'monaco-editor';
import type { Position, TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol';
import { toMonacoRange } from './ranges';

/** The text edits of a workspace edit for one file. */
export interface FileEdits {
    uri: string;
    /** The document version that the server used. Null or undefined means that the version is not known. */
    version?: number | null;
    edits: TextEdit[];
}

export interface CollectedEdits {
    files: FileEdits[];
    /** The kinds of the file operations (create, rename, delete) in the edit. ShipWarden does not apply them. */
    resourceOperations: string[];
}

/**
 * Collects the text edits of a workspace edit for each file.
 * When `documentChanges` is set, the LSP specification says that the client ignores `changes`.
 */
export function collectFileEdits(edit: WorkspaceEdit): CollectedEdits {
    const files = new Map<string, FileEdits>();
    const resourceOperations: string[] = [];
    const add = (uri: string, edits: readonly TextEdit[], version?: number | null): void => {
        let file = files.get(uri);
        if (!file) {
            file = { uri, version, edits: [] };
            files.set(uri, file);
        }
        // An annotated edit has more fields. Keep only the range and the text.
        file.edits.push(...edits.map(item => ({ range: item.range, newText: item.newText })));
    };
    if (edit.documentChanges) {
        for (const change of edit.documentChanges) {
            if ('kind' in change) {
                resourceOperations.push(change.kind);
            } else {
                add(change.textDocument.uri, change.edits as TextEdit[], change.textDocument.version);
            }
        }
    } else if (edit.changes) {
        for (const [uri, edits] of Object.entries(edit.changes)) {
            add(uri, edits);
        }
    }
    return { files: [...files.values()], resourceOperations };
}

/** Converts LSP text edits to Monaco edit operations. */
export function toMonacoEdits(edits: readonly TextEdit[]): { range: IRange; text: string }[] {
    return edits.map(edit => ({ range: toMonacoRange(edit.range), text: edit.newText }));
}

/** Returns the offset of each line start. */
function lineStarts(text: string): number[] {
    const starts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) === 10) {
            starts.push(index + 1);
        }
    }
    return starts;
}

/**
 * Converts an LSP position to an offset in the text.
 * A character after the line end goes to the line end. A line after the last line goes to the text end.
 */
function offsetAt(text: string, starts: readonly number[], position: Position): number {
    if (position.line < 0) {
        return 0;
    }
    if (position.line >= starts.length) {
        return text.length;
    }
    const start = starts[position.line];
    const hasNext = position.line + 1 < starts.length;
    // The line end is before the line break. A line break can be "\n" or "\r\n".
    let end = hasNext ? starts[position.line + 1] - 1 : text.length;
    if (hasNext && end > start && text.charCodeAt(end - 1) === 13) {
        end--;
    }
    return Math.min(start + Math.max(position.character, 0), end);
}

/**
 * Applies LSP text edits to a text and returns the new text.
 * All ranges refer to the original text. Inserts at the same position keep their order in the list.
 * Throws an error when two edits overlap.
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
    const starts = lineStarts(text);
    const items = edits
        .map((edit, index) => ({
            start: offsetAt(text, starts, edit.range.start),
            end: offsetAt(text, starts, edit.range.end),
            text: edit.newText,
            index
        }))
        .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
    let result = '';
    let cursor = 0;
    for (const item of items) {
        if (item.end < item.start) {
            throw new Error('An edit has a range end before its range start.');
        }
        if (item.start < cursor) {
            throw new Error('Two edits change the same text.');
        }
        result += text.slice(cursor, item.start) + item.text;
        cursor = item.end;
    }
    return result + text.slice(cursor);
}
