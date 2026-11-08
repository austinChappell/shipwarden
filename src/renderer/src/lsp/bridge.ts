import type {
    CompletionItem,
    CompletionList,
    Diagnostic,
    DocumentDiagnosticReport,
    DocumentHighlight,
    Hover,
    Location,
    LocationLink,
    PublishDiagnosticsParams,
    TextDocumentContentChangeEvent
} from 'vscode-languageserver-protocol';
import { lspLanguageId, rootForPath, sortChangesForLsp, type LspServerInfo, type LspServerMessage } from '@shared/lsp';
import { documents } from '../editor/documents';
import { monaco } from '../editor/monaco';
import {
    toCompletionItem,
    toHighlights,
    toHover,
    toLocationLinks,
    toLocations,
    toLspPosition,
    toMarkers,
    type ShipWardenCompletionItem
} from './convert';

/** The Monaco languages that get LSP providers. */
const MONACO_LANGUAGES = ['typescript', 'javascript', 'rust', 'python', 'go'];
const MARKER_OWNER = 'lsp';
const CHANGE_DEBOUNCE_MS = 100;
const DIAGNOSTICS_DEBOUNCE_MS = 300;
/** Peek views need a model for each file in the results. ShipWarden loads at most this number of files. */
const MAX_PRELOADED_MODELS = 50;
const TRIGGER_CHARACTERS = ['.', ':', '"', '\'', '/', '@', '<', '#', '`'];

/** One Monaco model that a language server knows about. */
interface SyncedDocument {
    model: monaco.editor.ITextModel;
    uri: string;
    root: string;
    server: LspServerInfo;
    version: number;
    pending: TextDocumentContentChangeEvent[];
    flushTimer?: ReturnType<typeof setTimeout>;
    diagnosticsTimer?: ReturnType<typeof setTimeout>;
    disposables: monaco.IDisposable[];
}

/** Opens a file of a worktree in the app, at a position. */
export type FileOpener = (root: string, path: string, line: number, column: number) => void;

/**
 * Connects Monaco to the language servers in the main process.
 * Each model belongs to the worktree that contains its file. Requests go to the server of that worktree.
 */
export class LspBridge {
    private roots: string[] = [];
    private readonly synced = new Map<string, SyncedDocument>();
    /** Diagnostics that arrived before the model of the file existed. */
    private readonly pendingDiagnostics = new Map<string, Diagnostic[]>();
    private opener: FileOpener | undefined;
    private readonly api = window.shipwarden;

    constructor() {
        // Language servers supply these features now. The built-in TypeScript worker sees only one file at a time.
        const modeConfiguration = {
            completionItems: false,
            hovers: false,
            documentSymbols: true,
            definitions: false,
            references: false,
            documentHighlights: false,
            rename: false,
            diagnostics: false,
            documentRangeFormattingEdits: true,
            signatureHelp: true,
            onTypeFormattingEdits: true,
            codeActions: false,
            inlayHints: false
        };
        monaco.typescript.typescriptDefaults.setModeConfiguration(modeConfiguration);
        monaco.typescript.javascriptDefaults.setModeConfiguration(modeConfiguration);

        this.registerProviders();
        this.registerOpener();
        this.api.lsp.onMessage(message => this.onServerMessage(message));
        monaco.editor.getModels().forEach(model => this.track(model));
        monaco.editor.onDidCreateModel(model => this.track(model));
    }

    /** Sets the worktree roots. A model gets a language server only when its file is in one of these roots. */
    setRoots(roots: string[]): void {
        this.roots = [...roots];
        monaco.editor.getModels().forEach(model => this.track(model));
    }

    setOpener(opener: FileOpener): void {
        this.opener = opener;
    }

    private async track(model: monaco.editor.ITextModel): Promise<void> {
        const uri = model.uri.toString();
        if (this.synced.has(uri) || model.uri.scheme !== 'file' || model.isDisposed()) {
            return;
        }
        const path = model.uri.path;
        const root = rootForPath(this.roots, path);
        const languageId = lspLanguageId(path);
        if (!root || !languageId) {
            return;
        }
        let server: LspServerInfo | undefined;
        try {
            server = await this.api.lsp.ensure(root, languageId);
        } catch (error) {
            console.warn('ShipWarden could not start the language server:', error);
        }
        if (!server || model.isDisposed() || this.synced.has(uri)) {
            return;
        }

        const document: SyncedDocument = { model, uri, root, server, version: 1, pending: [], disposables: [] };
        this.synced.set(uri, document);
        this.api.lsp.notify(server.key, 'textDocument/didOpen', {
            textDocument: { uri, languageId, version: document.version, text: model.getValue() }
        });
        document.disposables.push(
            model.onDidChangeContent(event => this.onChange(document, event)),
            model.onWillDispose(() => this.untrack(document))
        );
        const pending = this.pendingDiagnostics.get(uri);
        if (pending) {
            monaco.editor.setModelMarkers(model, MARKER_OWNER, toMarkers(pending));
            this.pendingDiagnostics.delete(uri);
        }
        this.scheduleDiagnostics(document);
    }

    private untrack(document: SyncedDocument): void {
        clearTimeout(document.flushTimer);
        clearTimeout(document.diagnosticsTimer);
        document.disposables.forEach(disposable => disposable.dispose());
        this.synced.delete(document.uri);
        this.api.lsp.notify(document.server.key, 'textDocument/didClose', { textDocument: { uri: document.uri } });
    }

    private onChange(document: SyncedDocument, event: monaco.editor.IModelContentChangedEvent): void {
        // TextDocumentSyncKind: 1 = Full, 2 = Incremental.
        const sync = document.server.capabilities.textDocumentSync;
        const kind = typeof sync === 'number' ? sync : sync?.change ?? 2;
        if (kind === 1) {
            document.pending = [{ text: document.model.getValue() }];
        } else {
            for (const change of sortChangesForLsp(event.changes)) {
                document.pending.push({
                    range: {
                        start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
                        end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 }
                    },
                    rangeLength: change.rangeLength,
                    text: change.text
                });
            }
        }
        clearTimeout(document.flushTimer);
        document.flushTimer = setTimeout(() => this.flush(document), CHANGE_DEBOUNCE_MS);
    }

    /** Sends the collected changes to the server. Each request calls this first, so the server has the current text. */
    private flush(document: SyncedDocument): void {
        clearTimeout(document.flushTimer);
        if (document.pending.length === 0) {
            return;
        }
        document.version++;
        this.api.lsp.notify(document.server.key, 'textDocument/didChange', {
            textDocument: { uri: document.uri, version: document.version },
            contentChanges: document.pending
        });
        document.pending = [];
        this.scheduleDiagnostics(document);
    }

    private scheduleDiagnostics(document: SyncedDocument): void {
        if (!document.server.capabilities.diagnosticProvider) {
            return;
        }
        clearTimeout(document.diagnosticsTimer);
        document.diagnosticsTimer = setTimeout(() => this.pullDiagnostics(document), DIAGNOSTICS_DEBOUNCE_MS);
    }

    private async pullDiagnostics(document: SyncedDocument): Promise<void> {
        try {
            const report = await this.api.lsp.request(document.server.key, 'textDocument/diagnostic', {
                textDocument: { uri: document.uri }
            }) as DocumentDiagnosticReport;
            if (report.kind === 'full' && !document.model.isDisposed()) {
                monaco.editor.setModelMarkers(document.model, MARKER_OWNER, toMarkers(report.items));
            }
        } catch {
            // The server cancelled the request because the text changed. The next change pulls again.
        }
    }

    private onServerMessage(message: LspServerMessage): void {
        if (message.method === 'textDocument/publishDiagnostics') {
            const params = message.params as PublishDiagnosticsParams;
            const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
            if (model) {
                monaco.editor.setModelMarkers(model, MARKER_OWNER, toMarkers(params.diagnostics));
            } else {
                this.pendingDiagnostics.set(params.uri, params.diagnostics);
            }
        } else if (message.method === 'workspace/diagnostic/refresh') {
            this.documentsOf(message.key).forEach(document => this.scheduleDiagnostics(document));
        } else if (message.method === 'shipwarden/serverExited') {
            // The server stopped. Forget its documents, so that the next model change can start a new server.
            for (const document of this.documentsOf(message.key)) {
                document.disposables.forEach(disposable => disposable.dispose());
                this.synced.delete(document.uri);
                monaco.editor.setModelMarkers(document.model, MARKER_OWNER, []);
            }
        }
    }

    private documentsOf(key: string): SyncedDocument[] {
        return [...this.synced.values()].filter(document => document.server.key === key);
    }

    /** Returns the synced document of the model after it sends its pending changes. */
    private ready(model: monaco.editor.ITextModel): SyncedDocument | undefined {
        const document = this.synced.get(model.uri.toString());
        if (document) {
            this.flush(document);
        }
        return document;
    }

    private async request<T>(document: SyncedDocument, method: string, params: object): Promise<T | undefined> {
        try {
            return await this.api.lsp.request(document.server.key, method, { textDocument: { uri: document.uri }, ...params }) as T;
        } catch {
            return undefined;
        }
    }

    /**
     * Makes sure that a Monaco model exists for each URI. Peek views and the editor opener need the models.
     * Files in a worktree use the document store, so that an open tab and the peek view share one model.
     */
    private async preloadModels(uris: monaco.Uri[]): Promise<void> {
        const unique = [...new Map(uris.map(uri => [uri.toString(), uri])).values()].slice(0, MAX_PRELOADED_MODELS);
        await Promise.all(unique.map(async uri => {
            if (monaco.editor.getModel(uri) || uri.scheme !== 'file') {
                return;
            }
            const root = rootForPath(this.roots, uri.path);
            try {
                if (root) {
                    await documents.open(root, uri.path.slice(root.length + 1));
                } else if (!monaco.editor.getModel(uri)) {
                    const content = await this.api.files.readExternal(uri.path);
                    if (!monaco.editor.getModel(uri)) {
                        monaco.editor.createModel(content, undefined, uri);
                    }
                }
            } catch {
                // The file is not readable. Monaco shows the location without a preview.
            }
        }));
    }

    private registerProviders(): void {
        const selector = MONACO_LANGUAGES;

        monaco.languages.registerDefinitionProvider(selector, {
            provideDefinition: async (model, position) => {
                const document = this.ready(model);
                if (!document) {
                    return null;
                }
                const result = await this.request<Location | Location[] | LocationLink[]>(document, 'textDocument/definition', { position: toLspPosition(position) });
                const links = toLocationLinks(result);
                await this.preloadModels(links.map(link => link.uri));
                return links;
            }
        });

        monaco.languages.registerTypeDefinitionProvider(selector, {
            provideTypeDefinition: async (model, position) => {
                const document = this.ready(model);
                if (!document || !document.server.capabilities.typeDefinitionProvider) {
                    return null;
                }
                const result = await this.request<Location | Location[] | LocationLink[]>(document, 'textDocument/typeDefinition', { position: toLspPosition(position) });
                const links = toLocationLinks(result);
                await this.preloadModels(links.map(link => link.uri));
                return links;
            }
        });

        monaco.languages.registerImplementationProvider(selector, {
            provideImplementation: async (model, position) => {
                const document = this.ready(model);
                if (!document || !document.server.capabilities.implementationProvider) {
                    return null;
                }
                const result = await this.request<Location | Location[] | LocationLink[]>(document, 'textDocument/implementation', { position: toLspPosition(position) });
                const links = toLocationLinks(result);
                await this.preloadModels(links.map(link => link.uri));
                return links;
            }
        });

        monaco.languages.registerReferenceProvider(selector, {
            provideReferences: async (model, position, context) => {
                const document = this.ready(model);
                if (!document) {
                    return null;
                }
                const result = await this.request<Location[]>(document, 'textDocument/references', {
                    position: toLspPosition(position),
                    context: { includeDeclaration: context.includeDeclaration }
                });
                const locations = toLocations(result);
                await this.preloadModels(locations.map(location => location.uri));
                return locations;
            }
        });

        monaco.languages.registerHoverProvider(selector, {
            provideHover: async (model, position) => {
                const document = this.ready(model);
                if (!document) {
                    return null;
                }
                return toHover(await this.request<Hover>(document, 'textDocument/hover', { position: toLspPosition(position) }));
            }
        });

        monaco.languages.registerDocumentHighlightProvider(selector, {
            provideDocumentHighlights: async (model, position) => {
                const document = this.ready(model);
                if (!document || !document.server.capabilities.documentHighlightProvider) {
                    return null;
                }
                return toHighlights(await this.request<DocumentHighlight[]>(document, 'textDocument/documentHighlight', { position: toLspPosition(position) }));
            }
        });

        monaco.languages.registerCompletionItemProvider(selector, {
            triggerCharacters: TRIGGER_CHARACTERS,
            provideCompletionItems: async (model, position, context) => {
                const document = this.ready(model);
                const provider = document?.server.capabilities.completionProvider;
                if (!document || !provider) {
                    return { suggestions: [] };
                }
                // A trigger character that the server does not list is a normal request. LSP: 1 = Invoked, 2 = TriggerCharacter.
                const character = context.triggerCharacter;
                const lspContext = character && provider.triggerCharacters?.includes(character)
                    ? { triggerKind: 2, triggerCharacter: character }
                    : { triggerKind: 1 };
                if (character && lspContext.triggerKind === 1) {
                    return { suggestions: [] };
                }
                const result = await this.request<CompletionItem[] | CompletionList>(document, 'textDocument/completion', {
                    position: toLspPosition(position),
                    context: lspContext
                });
                const items = Array.isArray(result) ? result : result?.items ?? [];
                const word = model.getWordUntilPosition(position);
                const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
                return {
                    suggestions: items.map(item => ({ ...toCompletionItem(item, defaultRange), serverKey: document.server.key })),
                    incomplete: !Array.isArray(result) && !!result?.isIncomplete
                };
            },
            resolveCompletionItem: async item => {
                const shipwardenItem = item as ShipWardenCompletionItem;
                const server = [...this.synced.values()].find(document => document.server.key === shipwardenItem.serverKey)?.server;
                if (!server?.capabilities.completionProvider?.resolveProvider || !shipwardenItem.lspItem) {
                    return item;
                }
                try {
                    const resolved = await this.api.lsp.request(server.key, 'completionItem/resolve', shipwardenItem.lspItem) as CompletionItem;
                    const converted = toCompletionItem(resolved, item.range as monaco.IRange);
                    return { ...item, detail: converted.detail ?? item.detail, documentation: converted.documentation ?? item.documentation };
                } catch {
                    return item;
                }
            }
        });
    }

    /** Opens "go to definition" targets in another file as an app tab. */
    private registerOpener(): void {
        monaco.editor.registerEditorOpener({
            openCodeEditor: (_source, resource, selectionOrPosition) => {
                const root = rootForPath(this.roots, resource.path);
                if (!root || !this.opener) {
                    return false;
                }
                let line = 1;
                let column = 1;
                if (selectionOrPosition && 'startLineNumber' in selectionOrPosition) {
                    line = selectionOrPosition.startLineNumber;
                    column = selectionOrPosition.startColumn;
                } else if (selectionOrPosition) {
                    line = selectionOrPosition.lineNumber;
                    column = selectionOrPosition.column;
                }
                this.opener(root, resource.path.slice(root.length + 1), line, column);
                return true;
            }
        });
    }
}

export const lspBridge = new LspBridge();
