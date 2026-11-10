import type { editor, languages } from 'monaco-editor';
import type { CodeAction, Command, Diagnostic } from 'vscode-languageserver-protocol';
import { toMonacoRange } from './ranges';

/** The Monaco command that applies an LSP code action or runs an LSP command. */
export const APPLY_CODE_ACTION_COMMAND = 'shipwarden.lsp.applyCodeAction';

/** The fields of a Monaco marker that identify a diagnostic. */
type MarkerKey = Pick<editor.IMarkerData, 'startLineNumber' | 'startColumn' | 'endLineNumber' | 'endColumn' | 'message'>;

/** A code action result can be a code action or a plain command. A plain command has a string in `command`. */
export function isCommand(item: Command | CodeAction): item is Command {
    return typeof item.command === 'string';
}

function diagnosticMessage(diagnostic: Diagnostic): string {
    return typeof diagnostic.message === 'string' ? diagnostic.message : (diagnostic.message as { value: string }).value;
}

function matches(marker: MarkerKey, diagnostic: Diagnostic): boolean {
    const range = toMonacoRange(diagnostic.range);
    return marker.startLineNumber === range.startLineNumber
        && marker.startColumn === range.startColumn
        && marker.endLineNumber === range.endLineNumber
        && marker.endColumn === range.endColumn
        && marker.message === diagnosticMessage(diagnostic);
}

/**
 * Returns the LSP diagnostics of the Monaco markers.
 * The server needs the original diagnostics, because they can have a `data` field.
 */
export function diagnosticsForMarkers(diagnostics: readonly Diagnostic[], markers: readonly MarkerKey[]): Diagnostic[] {
    return diagnostics.filter(diagnostic => markers.some(marker => matches(marker, diagnostic)));
}

/** Returns the Monaco markers of the LSP diagnostics. */
export function markersForDiagnostics<T extends MarkerKey>(markers: readonly T[], diagnostics: readonly Diagnostic[] | undefined): T[] {
    if (!diagnostics || diagnostics.length === 0) {
        return [];
    }
    return markers.filter(marker => diagnostics.some(diagnostic => matches(marker, diagnostic)));
}

/**
 * Converts an LSP code action or command to a Monaco code action.
 * The Monaco action runs a ShipWarden command. This command resolves the action, applies its edit and runs its command.
 */
export function toMonacoCodeAction<T extends editor.IMarkerData>(item: Command | CodeAction, serverKey: string, markers: readonly T[]): languages.CodeAction {
    const command: languages.Command = { id: APPLY_CODE_ACTION_COMMAND, title: item.title, arguments: [serverKey, item] };
    if (isCommand(item)) {
        return { title: item.title, command };
    }
    const diagnostics = markersForDiagnostics(markers, item.diagnostics);
    return {
        title: item.title,
        kind: item.kind,
        isPreferred: item.isPreferred,
        disabled: item.disabled?.reason,
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
        command
    };
}

/** A code action without an edit needs a resolve request, when the server supports it. */
export function needsResolve(action: CodeAction, resolveProvider: boolean): boolean {
    return resolveProvider && !action.edit;
}
