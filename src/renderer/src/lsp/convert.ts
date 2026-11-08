import type {
    CompletionItem,
    Diagnostic,
    DocumentHighlight,
    Hover,
    Location,
    LocationLink,
    MarkedString,
    MarkupContent,
    Position,
    Range
} from 'vscode-languageserver-protocol';
import { monaco } from '../editor/monaco';

/** Converts a Monaco position (1-based) to an LSP position (0-based). */
export function toLspPosition(position: monaco.IPosition): Position {
    return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** Converts an LSP range (0-based) to a Monaco range (1-based). */
export function toMonacoRange(range: Range): monaco.IRange {
    return {
        startLineNumber: range.start.line + 1,
        startColumn: range.start.character + 1,
        endLineNumber: range.end.line + 1,
        endColumn: range.end.character + 1
    };
}

export function toLspRange(range: monaco.IRange): Range {
    return {
        start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
        end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
    };
}

/** Converts the result of a definition request. The result can be a location, a list of locations or a list of links. */
export function toLocationLinks(result: Location | Location[] | LocationLink[] | null | undefined): monaco.languages.LocationLink[] {
    if (!result) {
        return [];
    }
    const items = Array.isArray(result) ? result : [result];
    return items.map(item => {
        if ('targetUri' in item) {
            return {
                uri: monaco.Uri.parse(item.targetUri),
                range: toMonacoRange(item.targetRange),
                targetSelectionRange: toMonacoRange(item.targetSelectionRange),
                originSelectionRange: item.originSelectionRange ? toMonacoRange(item.originSelectionRange) : undefined
            };
        }
        return { uri: monaco.Uri.parse(item.uri), range: toMonacoRange(item.range) };
    });
}

export function toLocations(result: Location[] | null | undefined): monaco.languages.Location[] {
    return (result ?? []).map(location => ({ uri: monaco.Uri.parse(location.uri), range: toMonacoRange(location.range) }));
}

function markedStringToMarkdown(value: MarkedString): monaco.IMarkdownString {
    if (typeof value === 'string') {
        return { value };
    }
    return { value: `\`\`\`${value.language}\n${value.value}\n\`\`\`` };
}

/** Converts LSP documentation to Monaco Markdown. Plain text shows as text, not as Markdown. */
export function toMarkdown(content: MarkupContent | MarkedString | MarkedString[] | string | undefined): monaco.IMarkdownString[] {
    if (!content) {
        return [];
    }
    if (Array.isArray(content)) {
        return content.map(markedStringToMarkdown);
    }
    if (typeof content === 'object' && 'kind' in content) {
        if (content.kind === 'markdown') {
            return [{ value: content.value }];
        }
        return [{ value: content.value.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&').replace(/\n/g, '  \n') }];
    }
    return [markedStringToMarkdown(content)];
}

export function toHover(hover: Hover | null | undefined): monaco.languages.Hover | null {
    if (!hover) {
        return null;
    }
    const contents = toMarkdown(hover.contents).filter(item => item.value.trim().length > 0);
    if (contents.length === 0) {
        return null;
    }
    return { contents, range: hover.range ? toMonacoRange(hover.range) : undefined };
}

export function toHighlights(highlights: DocumentHighlight[] | null | undefined): monaco.languages.DocumentHighlight[] {
    return (highlights ?? []).map(highlight => ({
        range: toMonacoRange(highlight.range),
        // LSP: 1 = Text, 2 = Read, 3 = Write. Monaco: 0 = Text, 1 = Read, 2 = Write.
        kind: highlight.kind ? highlight.kind - 1 : monaco.languages.DocumentHighlightKind.Text
    }));
}

/** LSP severity: 1 = Error, 2 = Warning, 3 = Information, 4 = Hint. */
function toMarkerSeverity(severity: number | undefined): monaco.MarkerSeverity {
    switch (severity) {
        case 2:
            return monaco.MarkerSeverity.Warning;
        case 3:
            return monaco.MarkerSeverity.Info;
        case 4:
            return monaco.MarkerSeverity.Hint;
        default:
            return monaco.MarkerSeverity.Error;
    }
}

export function toMarkers(diagnostics: Diagnostic[]): monaco.editor.IMarkerData[] {
    return diagnostics.map(diagnostic => ({
        ...toMonacoRange(diagnostic.range),
        severity: toMarkerSeverity(diagnostic.severity),
        // LSP 3.18 permits Markdown messages. Monaco markers show plain text.
        message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
        source: diagnostic.source,
        code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
        tags: diagnostic.tags?.map(tag => (tag === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated))
    }));
}

/** The names of the LSP completion item kinds, in LSP order. The first kind has the value 1. */
const COMPLETION_KIND_NAMES = [
    'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property',
    'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant',
    'Struct', 'Event', 'Operator', 'TypeParameter'
] as const;

function toCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
    const name = kind ? COMPLETION_KIND_NAMES[kind - 1] : undefined;
    return name ? monaco.languages.CompletionItemKind[name] : monaco.languages.CompletionItemKind.Text;
}

/** An LSP completion item with the original item, so that the resolve request can use it. */
export interface ShipWardenCompletionItem extends monaco.languages.CompletionItem {
    lspItem: CompletionItem;
    /** The key of the server that supplied the item. */
    serverKey?: string;
}

export function toCompletionItem(item: CompletionItem, defaultRange: monaco.IRange): ShipWardenCompletionItem {
    let range: monaco.languages.CompletionItem['range'] = defaultRange;
    let insertText = item.insertText ?? item.label;
    if (item.textEdit) {
        insertText = item.textEdit.newText;
        range = 'range' in item.textEdit
            ? toMonacoRange(item.textEdit.range)
            : { insert: toMonacoRange(item.textEdit.insert), replace: toMonacoRange(item.textEdit.replace) };
    }
    const documentation = item.documentation ? toMarkdown(item.documentation)[0] : undefined;
    return {
        label: item.labelDetails ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description } : item.label,
        kind: toCompletionKind(item.kind),
        detail: item.detail,
        documentation,
        sortText: item.sortText,
        filterText: item.filterText,
        preselect: item.preselect,
        insertText,
        // LSP: insertTextFormat 2 is a snippet.
        insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        range,
        commitCharacters: item.commitCharacters,
        additionalTextEdits: item.additionalTextEdits?.map(edit => ({ range: toMonacoRange(edit.range), text: edit.newText })),
        tags: item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
        lspItem: item
    };
}
