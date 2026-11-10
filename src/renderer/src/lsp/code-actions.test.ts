import { describe, expect, it } from 'vitest';
import type { CodeAction, Diagnostic } from 'vscode-languageserver-protocol';
import { APPLY_CODE_ACTION_COMMAND, diagnosticsForMarkers, isCommand, markersForDiagnostics, needsResolve, toMonacoCodeAction } from './code-actions';

const unused: Diagnostic = {
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } },
    message: "'foo' is unused.",
    data: { fixId: 'unused' }
};
const missing: Diagnostic = {
    range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } },
    message: "Cannot find name 'bar'."
};
// Monaco markers have 1-based ranges and a severity.
const unusedMarker = { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 8, message: "'foo' is unused.", severity: 4 };
const otherMarker = { startLineNumber: 9, startColumn: 1, endLineNumber: 9, endColumn: 2, message: 'Syntax error.', severity: 8 };

describe('diagnosticsForMarkers', () => {
    it('returns the original LSP diagnostics of the markers', () => {
        expect(diagnosticsForMarkers([unused, missing], [unusedMarker, otherMarker])).toEqual([unused]);
    });

    it('does not match a marker with a different message', () => {
        expect(diagnosticsForMarkers([unused], [{ ...unusedMarker, message: 'Other.' }])).toEqual([]);
    });
});

describe('markersForDiagnostics', () => {
    it('returns the markers of the diagnostics', () => {
        expect(markersForDiagnostics([unusedMarker, otherMarker], [unused])).toEqual([unusedMarker]);
        expect(markersForDiagnostics([unusedMarker], undefined)).toEqual([]);
    });
});

describe('toMonacoCodeAction', () => {
    it('converts a code action to a Monaco action that runs the ShipWarden command', () => {
        const action: CodeAction = { title: 'Remove unused variable', kind: 'quickfix', diagnostics: [unused], isPreferred: true, data: 1 };
        expect(toMonacoCodeAction(action, 'tsc:/r', [unusedMarker, otherMarker])).toEqual({
            title: 'Remove unused variable',
            kind: 'quickfix',
            isPreferred: true,
            disabled: undefined,
            diagnostics: [unusedMarker],
            command: { id: APPLY_CODE_ACTION_COMMAND, title: 'Remove unused variable', arguments: ['tsc:/r', action] }
        });
    });

    it('converts a plain LSP command', () => {
        const command = { title: 'Organize imports', command: 'organize', arguments: ['file:///a.ts'] };
        expect(isCommand(command)).toBe(true);
        expect(toMonacoCodeAction(command, 'k', [])).toEqual({
            title: 'Organize imports',
            command: { id: APPLY_CODE_ACTION_COMMAND, title: 'Organize imports', arguments: ['k', command] }
        });
    });

    it('keeps the reason of a disabled action', () => {
        const action: CodeAction = { title: 'Extract', kind: 'refactor.extract', disabled: { reason: 'Select an expression.' } };
        expect(isCommand(action)).toBe(false);
        expect(toMonacoCodeAction(action, 'k', []).disabled).toBe('Select an expression.');
    });
});

describe('needsResolve', () => {
    it('resolves an action without an edit only when the server supports resolve', () => {
        expect(needsResolve({ title: 'Fix', data: 1 }, true)).toBe(true);
        expect(needsResolve({ title: 'Fix', data: 1 }, false)).toBe(false);
        expect(needsResolve({ title: 'Fix', edit: { changes: {} } }, true)).toBe(false);
    });
});
