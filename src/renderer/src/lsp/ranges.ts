import type { IPosition, IRange } from 'monaco-editor';
import type { Position, Range } from 'vscode-languageserver-protocol';

/** Converts a Monaco position (1-based) to an LSP position (0-based). */
export function toLspPosition(position: IPosition): Position {
    return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** Converts an LSP range (0-based) to a Monaco range (1-based). */
export function toMonacoRange(range: Range): IRange {
    return {
        startLineNumber: range.start.line + 1,
        startColumn: range.start.character + 1,
        endLineNumber: range.end.line + 1,
        endColumn: range.end.character + 1
    };
}

export function toLspRange(range: IRange): Range {
    return {
        start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
        end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
    };
}
