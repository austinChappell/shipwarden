import type {
    ApplyWorkspaceEditParams,
    ApplyWorkspaceEditResult,
    CodeAction,
    Command,
    CompletionItem,
    CompletionList,
    Diagnostic,
    DocumentDiagnosticReport,
    DocumentHighlight,
    Hover,
    Location,
    LocationLink,
    PrepareRenameResult,
    PublishDiagnosticsParams,
    TextDocumentContentChangeEvent,
    TextEdit,
    WorkspaceEdit
} from 'vscode-languageserver-protocol';
import { lspLanguageId, rootForPath, SERVER_CRASHED, sortChangesForLsp, type LspServerCrash, type LspServerInfo, type LspServerMessage } from '@shared/lsp';
import { documents } from '../editor/documents';
import { monaco } from '../editor/monaco';
import { APPLY_CODE_ACTION_COMMAND, diagnosticsForMarkers, isCommand, needsResolve, toMonacoCodeAction } from './code-actions';
import {
    toCompletionItem,
    toHighlights,
    toHover,
    toLocationLinks,
    toLocations,
    toLspPosition,
    toLspRange,
    toMarkers,
    toMonacoRange,
    type ShipWardenCompletionItem
} from './convert';
import { missingServers } from './missing-servers';
import { serverCrashes } from './server-crashes';
import { applyTextEdits, collectFileEdits, toMonacoEdits } from './workspace-edit';

/** The Monaco languages that get LSP providers. */
const MONACO_LANGUAGES = ['typescript', 'javascript', 'rust', 'python', 'go', 'ruby'];
const MARKER_OWNER = 'lsp';
const CHANGE_DEBOUNCE_MS = 100;
const DIAGNOSTICS_DEBOUNCE_MS = 300;
/** Peek views need a model for each file in the results. ShipWarden loads at most this number of files. */
const MAX_PRELOADED_MODELS = 50;
const TRIGGER_CHARACTERS = ['.', ':', '"', "'", '/', '@', '<', '#', '`'];

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

/** One file of a workspace edit, after the checks. */
type FileChange =
    /** The document store has the file. The edit goes to the model. A model without unsaved changes is saved. */
    | { kind: 'model'; path: string; model: monaco.editor.ITextModel; edits: TextEdit[]; save?: { root: string; file: string } }
    /** No model has the file. The new text goes to the disk. */
    | { kind: 'disk'; path: string; root: string; file: string; text: string };

const NO_SERVER = 'No language server is available for this file.';

/** Removes the prefix that Electron adds to the errors of IPC calls. */
function errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Opens a file of a worktree in the app, at a position. */
export type FileOpener = (root: string, path: string, line: number, column: number) => void;

/**
 * Connects Monaco to the language servers in the main process.
 * Each model belongs to the worktree that contains its file. Requests go to the server of that worktree.
 */
export class LspBridge {
    private roots: string[] = [];
    /** Roots outside the worktrees, for example the copy of a pull request. Each root has its own opener. */
    private readonly extraRoots = new Map<string, FileOpener>();
    /** The tracking of each model that is in progress, by URI. */
    private readonly tracking = new Map<string, Promise<void>>();
    private readonly synced = new Map<string, SyncedDocument>();
    /** Diagnostics that arrived before the model of the file existed. */
    private readonly pendingDiagnostics = new Map<string, Diagnostic[]>();
    /** The last LSP diagnostics of each model, by URI. Code action requests send them back to the server. */
    private readonly diagnostics = new Map<string, Diagnostic[]>();
    private opener: FileOpener | undefined;
    private readonly api = window.shipwarden;
    /** The worktrees and languages for which a "missing server" check is in progress. */
    private readonly checking = new Set<string>();

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

        monaco.editor.registerCommand(APPLY_CODE_ACTION_COMMAND, (_accessor, serverKey: string, item: Command | CodeAction) => {
            void this.runCodeAction(serverKey, item);
        });
        this.registerProviders();
        this.registerOpener();
        this.api.lsp.onMessage(message => this.onServerMessage(message));
        this.api.lsp.onInstallState(state => missingServers.setInstallState(state.serverId, state));
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

    /**
     * Adds a root outside the worktrees. "Go to definition" into another file of this root calls `opener`, not the
     * opener of the app. Returns a function that removes the root.
     */
    addRoot(root: string, opener: FileOpener): () => void {
        this.extraRoots.set(root, opener);
        monaco.editor.getModels().forEach(model => this.track(model));
        return () => {
            if (this.extraRoots.get(root) === opener) this.extraRoots.delete(root);
        };
    }

    /**
     * Resolves when the language server has the model, or when the model gets no server.
     * A request before this time gets no result.
     */
    async whenTracked(model: monaco.editor.ITextModel): Promise<void> {
        const uri = model.uri.toString();
        if (this.synced.has(uri)) return;
        await (this.tracking.get(uri) ?? this.track(model));
    }

    private allRoots(): string[] {
        return [...this.roots, ...this.extraRoots.keys()];
    }

    /**
     * Installs a missing server into the folder of the app. Call it only after the user agrees.
     * After the install, the open files of all worktrees connect to the server.
     * The install state (progress and errors) goes to `missingServers`.
     */
    async install(serverId: string): Promise<void> {
        if (missingServers.isInstalling(serverId)) {
            return;
        }
        missingServers.setInstallState(serverId, { serverId, status: 'running', step: 'Starting' });
        try {
            await this.api.lsp.install(serverId);
        } catch (error) {
            const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
            missingServers.setInstallState(serverId, { serverId, status: 'error', error: message });
            return;
        }
        const entry = missingServers.anyEntryOf(serverId);
        const server = entry ? await this.api.lsp.ensure(entry.root, entry.languageId).catch(() => undefined) : undefined;
        if (entry && !server) {
            missingServers.setInstallState(serverId, {
                serverId,
                status: 'error',
                error: 'The install is complete, but the server did not start. Look at the log for the reason.'
            });
            return;
        }
        missingServers.setInstallState(serverId, undefined);
        missingServers.deleteServer(serverId);
        monaco.editor.getModels().forEach(model => this.track(model));
    }

    /** Removes the crash of the server in the worktree. Then the open files start the server again. */
    retry(root: string, serverId: string): void {
        serverCrashes.clear(root, serverId);
        monaco.editor.getModels().forEach(model => this.track(model));
    }

    /** Asks the main process if the worktree needs a server that is not installed. */
    private async checkMissing(root: string, languageId: string): Promise<void> {
        const key = `${root}\0${languageId}`;
        if (missingServers.has(root, languageId) || this.checking.has(key)) {
            return;
        }
        this.checking.add(key);
        try {
            const missing = await this.api.lsp.missing(root, languageId);
            if (missing) {
                missingServers.set(root, languageId, missing);
            }
        } catch (error) {
            console.warn('ShipWarden could not check the language server:', error);
        } finally {
            this.checking.delete(key);
        }
    }

    private track(model: monaco.editor.ITextModel): Promise<void> {
        const uri = model.uri.toString();
        const current = this.tracking.get(uri);
        if (current) return current;
        const promise = this.trackNow(model).finally(() => this.tracking.delete(uri));
        this.tracking.set(uri, promise);
        return promise;
    }

    private async trackNow(model: monaco.editor.ITextModel): Promise<void> {
        const uri = model.uri.toString();
        if (this.synced.has(uri) || model.uri.scheme !== 'file' || model.isDisposed()) {
            return;
        }
        const path = model.uri.path;
        const root = rootForPath(this.allRoots(), path);
        const languageId = lspLanguageId(path);
        // A server that crashed does not start again until the user clicks "Try again". This stops a crash loop.
        if (!root || !languageId || serverCrashes.has(root, languageId)) {
            return;
        }
        let server: LspServerInfo | undefined;
        let failed = false;
        try {
            server = await this.api.lsp.ensure(root, languageId);
        } catch (error) {
            failed = true;
            console.warn('ShipWarden could not start the language server:', error);
        }
        if (!server) {
            if (!failed) {
                void this.checkMissing(root, languageId);
            }
            return;
        }
        missingServers.delete(root, languageId);
        if (model.isDisposed() || this.synced.has(uri)) {
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
            this.setDiagnostics(model, pending);
            this.pendingDiagnostics.delete(uri);
        }
        this.scheduleDiagnostics(document);
    }

    private untrack(document: SyncedDocument): void {
        clearTimeout(document.flushTimer);
        clearTimeout(document.diagnosticsTimer);
        document.disposables.forEach(disposable => disposable.dispose());
        this.synced.delete(document.uri);
        this.diagnostics.delete(document.uri);
        this.api.lsp.notify(document.server.key, 'textDocument/didClose', { textDocument: { uri: document.uri } });
    }

    /** Shows the diagnostics as markers and keeps them for code action requests. */
    private setDiagnostics(model: monaco.editor.ITextModel, diagnostics: Diagnostic[]): void {
        this.diagnostics.set(model.uri.toString(), diagnostics);
        monaco.editor.setModelMarkers(model, MARKER_OWNER, toMarkers(diagnostics));
    }

    private onChange(document: SyncedDocument, event: monaco.editor.IModelContentChangedEvent): void {
        // TextDocumentSyncKind: 1 = Full, 2 = Incremental.
        const sync = document.server.capabilities.textDocumentSync;
        const kind = typeof sync === 'number' ? sync : (sync?.change ?? 2);
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
            const report = (await this.api.lsp.request(document.server.key, 'textDocument/diagnostic', {
                textDocument: { uri: document.uri }
            })) as DocumentDiagnosticReport;
            if (report.kind === 'full' && !document.model.isDisposed()) {
                this.setDiagnostics(document.model, report.items);
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
                this.setDiagnostics(model, params.diagnostics);
            } else {
                this.pendingDiagnostics.set(params.uri, params.diagnostics);
            }
        } else if (message.method === 'workspace/diagnostic/refresh') {
            this.documentsOf(message.key).forEach(document => this.scheduleDiagnostics(document));
        } else if (message.method === SERVER_CRASHED) {
            serverCrashes.set(message.params as LspServerCrash);
        } else if (message.method === 'shipwarden/serverExited') {
            // The server stopped. Forget its documents, so that the next model change can start a new server.
            for (const document of this.documentsOf(message.key)) {
                document.disposables.forEach(disposable => disposable.dispose());
                this.synced.delete(document.uri);
                this.setDiagnostics(document.model, []);
            }
        } else if (message.method === 'workspace/applyEdit' && message.id !== undefined) {
            const id = message.id;
            const params = message.params as ApplyWorkspaceEditParams;
            void this.applyWorkspaceEdit(params.edit)
                .catch((error): ApplyWorkspaceEditResult => ({ applied: false, failureReason: errorMessage(error) }))
                .then(result => this.api.lsp.respond(id, result));
        }
    }

    /** Returns the information of a running server, when a synced document uses the server. */
    private serverInfo(key: string): LspServerInfo | undefined {
        return [...this.synced.values()].find(document => document.server.key === key)?.server;
    }

    /**
     * Applies an LSP workspace edit.
     * A file in the document store gets the edit in its model. If the model had no unsaved changes, ShipWarden saves it.
     * Other files of a worktree get the edit on the disk.
     * ShipWarden checks all files before it changes one file.
     */
    async applyWorkspaceEdit(edit: WorkspaceEdit): Promise<ApplyWorkspaceEditResult> {
        const fail = (failureReason: string): ApplyWorkspaceEditResult => ({ applied: false, failureReason });
        const { files, resourceOperations } = collectFileEdits(edit);
        if (resourceOperations.length > 0) {
            return fail(`ShipWarden cannot do file operations (${[...new Set(resourceOperations)].join(', ')}).`);
        }

        const changes: FileChange[] = [];
        for (const fileEdits of files) {
            const uri = monaco.Uri.parse(fileEdits.uri);
            const path = uri.path;
            if (uri.scheme !== 'file') {
                return fail(`ShipWarden can change only local files. The edit has "${fileEdits.uri}".`);
            }
            const synced = this.synced.get(uri.toString());
            if (typeof fileEdits.version === 'number' && synced && (synced.version !== fileEdits.version || synced.pending.length > 0)) {
                return fail(`The file "${path}" changed after the server made the edit.`);
            }
            const root = rootForPath(this.allRoots(), path);
            if (!root) {
                return fail(`The file "${path}" is not in a worktree. ShipWarden does not change it.`);
            }
            const file = path.slice(root.length + 1);
            const model = documents.get(root, file);
            try {
                if (model) {
                    // This call only checks the edits. Monaco applies them below, so that undo works.
                    applyTextEdits(model.getValue(), fileEdits.edits);
                    const save = documents.isDirty(root, file) ? undefined : { root, file };
                    changes.push({ kind: 'model', path, model, edits: fileEdits.edits, save });
                } else {
                    const text = applyTextEdits(await this.api.files.read(root, file), fileEdits.edits);
                    changes.push({ kind: 'disk', path, root, file, text });
                }
            } catch (error) {
                return fail(`ShipWarden cannot change "${path}": ${errorMessage(error)}`);
            }
        }

        for (const change of changes) {
            try {
                if (change.kind === 'model') {
                    if (change.model.isDisposed()) {
                        throw new Error('The editor closed the file.');
                    }
                    change.model.pushStackElement();
                    change.model.pushEditOperations([], toMonacoEdits(change.edits), () => null);
                    change.model.pushStackElement();
                    if (change.save) {
                        await documents.save(change.save.root, change.save.file);
                    }
                } else {
                    await this.api.files.write(change.root, change.file, change.text);
                }
            } catch (error) {
                return fail(`ShipWarden could not change "${change.path}": ${errorMessage(error)}`);
            }
        }
        return { applied: true };
    }

    /** Sends an LSP command to the server. The server can send "workspace/applyEdit" before it answers. */
    private async executeCommand(serverKey: string, command: Command): Promise<void> {
        const provider = this.serverInfo(serverKey)?.capabilities.executeCommandProvider;
        if (!provider?.commands.includes(command.command)) {
            throw new Error(`The language server does not support the command "${command.command}".`);
        }
        await this.api.lsp.request(serverKey, 'workspace/executeCommand', { command: command.command, arguments: command.arguments });
    }

    /** Resolves a code action if necessary. Then applies its edit and runs its command. */
    private async runCodeAction(serverKey: string, item: Command | CodeAction): Promise<void> {
        try {
            if (isCommand(item)) {
                await this.executeCommand(serverKey, item);
                return;
            }
            const provider = this.serverInfo(serverKey)?.capabilities.codeActionProvider;
            const resolveProvider = typeof provider === 'object' && !!provider.resolveProvider;
            const action = needsResolve(item, resolveProvider) ? ((await this.api.lsp.request(serverKey, 'codeAction/resolve', item)) as CodeAction) : item;
            if (action.edit) {
                const result = await this.applyWorkspaceEdit(action.edit);
                if (!result.applied) {
                    throw new Error(result.failureReason);
                }
            }
            if (action.command) {
                await this.executeCommand(serverKey, action.command);
            }
        } catch (error) {
            console.warn(`ShipWarden could not apply the code action "${item.title}":`, errorMessage(error));
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
            return (await this.api.lsp.request(document.server.key, method, { textDocument: { uri: document.uri }, ...params })) as T;
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
        await Promise.all(
            unique.map(async uri => {
                if (monaco.editor.getModel(uri) || uri.scheme !== 'file') {
                    return;
                }
                const root = rootForPath(this.allRoots(), uri.path);
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
            })
        );
    }

    private registerProviders(): void {
        const selector = MONACO_LANGUAGES;

        monaco.languages.registerDefinitionProvider(selector, {
            provideDefinition: async (model, position) => {
                const document = this.ready(model);
                if (!document) {
                    return null;
                }
                const result = await this.request<Location | Location[] | LocationLink[]>(document, 'textDocument/definition', {
                    position: toLspPosition(position)
                });
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
                const result = await this.request<Location | Location[] | LocationLink[]>(document, 'textDocument/typeDefinition', {
                    position: toLspPosition(position)
                });
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
                const result = await this.request<Location | Location[] | LocationLink[]>(document, 'textDocument/implementation', {
                    position: toLspPosition(position)
                });
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
                const lspContext =
                    character && provider.triggerCharacters?.includes(character) ? { triggerKind: 2, triggerCharacter: character } : { triggerKind: 1 };
                if (character && lspContext.triggerKind === 1) {
                    return { suggestions: [] };
                }
                const result = await this.request<CompletionItem[] | CompletionList>(document, 'textDocument/completion', {
                    position: toLspPosition(position),
                    context: lspContext
                });
                const items = Array.isArray(result) ? result : (result?.items ?? []);
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
                    const resolved = (await this.api.lsp.request(server.key, 'completionItem/resolve', shipwardenItem.lspItem)) as CompletionItem;
                    const converted = toCompletionItem(resolved, item.range as monaco.IRange);
                    return { ...item, detail: converted.detail ?? item.detail, documentation: converted.documentation ?? item.documentation };
                } catch {
                    return item;
                }
            }
        });

        monaco.languages.registerRenameProvider(selector, {
            resolveRenameLocation: async (model, position) => {
                const reject = (rejectReason: string) => ({ range: monaco.Range.fromPositions(position), text: '', rejectReason });
                const document = this.ready(model);
                const provider = document?.server.capabilities.renameProvider;
                if (!document || !provider) {
                    return reject(document ? 'The language server cannot rename symbols.' : NO_SERVER);
                }
                if (typeof provider !== 'object' || !provider.prepareProvider) {
                    // Monaco uses the word at the position.
                    return undefined;
                }
                let result: PrepareRenameResult | null;
                try {
                    result = (await this.api.lsp.request(document.server.key, 'textDocument/prepareRename', {
                        textDocument: { uri: document.uri },
                        position: toLspPosition(position)
                    })) as PrepareRenameResult | null;
                } catch (error) {
                    return reject(errorMessage(error));
                }
                if (!result) {
                    return reject('You cannot rename this element.');
                }
                if ('defaultBehavior' in result) {
                    return undefined;
                }
                if ('placeholder' in result) {
                    return { range: toMonacoRange(result.range), text: result.placeholder };
                }
                const range = toMonacoRange(result);
                return { range, text: model.getValueInRange(range) };
            },
            provideRenameEdits: async (model, position, newName) => {
                const document = this.ready(model);
                if (!document?.server.capabilities.renameProvider) {
                    return { edits: [], rejectReason: document ? 'The language server cannot rename symbols.' : NO_SERVER };
                }
                let edit: WorkspaceEdit | null;
                try {
                    edit = (await this.api.lsp.request(document.server.key, 'textDocument/rename', {
                        textDocument: { uri: document.uri },
                        position: toLspPosition(position),
                        newName
                    })) as WorkspaceEdit | null;
                } catch (error) {
                    return { edits: [], rejectReason: errorMessage(error) };
                }
                if (!edit) {
                    return { edits: [], rejectReason: 'The language server found no symbol to rename.' };
                }
                // ShipWarden applies the edit itself, because Monaco can change only files that have a model.
                const result = await this.applyWorkspaceEdit(edit);
                return result.applied ? { edits: [] } : { edits: [], rejectReason: result.failureReason };
            }
        });

        monaco.languages.registerCodeActionProvider(selector, {
            provideCodeActions: async (model, range, context) => {
                const empty = { actions: [], dispose: () => undefined };
                const document = this.ready(model);
                if (!document?.server.capabilities.codeActionProvider) {
                    return empty;
                }
                const diagnostics = diagnosticsForMarkers(this.diagnostics.get(document.uri) ?? [], context.markers);
                // Monaco and LSP use the same trigger values: 1 = Invoke, 2 = Automatic.
                const result = await this.request<(Command | CodeAction)[] | null>(document, 'textDocument/codeAction', {
                    range: toLspRange(range),
                    context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger }
                });
                if (!result) {
                    return empty;
                }
                return { actions: result.map(item => toMonacoCodeAction(item, document.server.key, context.markers)), dispose: () => undefined };
            }
        });
    }

    /** Opens "go to definition" targets in another file as an app tab. */
    private registerOpener(): void {
        monaco.editor.registerEditorOpener({
            openCodeEditor: (_source, resource, selectionOrPosition) => {
                const root = rootForPath(this.allRoots(), resource.path);
                const opener = root && (this.extraRoots.get(root) ?? this.opener);
                if (!root || !opener) {
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
                opener(root, resource.path.slice(root.length + 1), line, column);
                return true;
            }
        });
    }
}

export const lspBridge = new LspBridge();
