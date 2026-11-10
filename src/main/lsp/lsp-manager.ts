import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import type { ClientCapabilities, InitializeResult } from 'vscode-languageserver-protocol';
import type { LspMissingServer, LspServerInfo, LspServerMessage } from '@shared/lsp';
import type { ServerInstaller } from './server-install';
import { serverForLanguage } from './servers';

interface RunningServer {
    info: LspServerInfo;
    process: ChildProcess;
    connection: MessageConnection;
}

/** The notifications that the UI handles. Other notifications only go to the log. */
const FORWARDED_NOTIFICATIONS = new Set(['textDocument/publishDiagnostics']);

const CLIENT_CAPABILITIES: ClientCapabilities = {
    general: { positionEncodings: ['utf-16'] },
    workspace: {
        workspaceFolders: true,
        configuration: true,
        diagnostics: { refreshSupport: true }
    },
    textDocument: {
        synchronization: { didSave: true, dynamicRegistration: false },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: { linkSupport: true },
        typeDefinition: { linkSupport: true },
        implementation: { linkSupport: true },
        references: {},
        documentHighlight: {},
        completion: {
            completionItem: {
                snippetSupport: true,
                insertReplaceSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                resolveSupport: { properties: ['documentation', 'detail'] }
            },
            contextSupport: true
        },
        publishDiagnostics: { relatedInformation: true },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false }
    }
};

/**
 * Starts one language server for each worktree and language, and passes messages between the servers and the UI.
 */
export class LspManager {
    private readonly servers = new Map<string, RunningServer>();
    private readonly starting = new Map<string, Promise<RunningServer | undefined>>();

    /**
     * @param send Sends a server message to the UI.
     * @param ready Resolves when the environment is ready, for example when the login shell PATH is known.
     * @param installer Installs missing servers into the folder of the app.
     */
    constructor(
        private readonly send: (message: LspServerMessage) => void,
        private readonly ready: Promise<void>,
        private readonly installer: ServerInstaller
    ) {}

    /** Starts the server for the language in the worktree, if necessary. Returns undefined when no server is available. */
    async ensure(root: string, languageId: string): Promise<LspServerInfo | undefined> {
        const definition = serverForLanguage(languageId);
        if (!definition) {
            return undefined;
        }
        const key = `${definition.id}:${root}`;
        const running = this.servers.get(key);
        if (running) {
            return running.info;
        }
        let promise = this.starting.get(key);
        if (!promise) {
            promise = this.start(key, definition.id, root, languageId).finally(() => this.starting.delete(key));
            this.starting.set(key, promise);
        }
        return (await promise)?.info;
    }

    /**
     * Returns the server that the language needs in the worktree, when the server is not installed.
     * Returns undefined when the server is available, or when no server supports the language.
     */
    async missing(root: string, languageId: string): Promise<LspMissingServer | undefined> {
        const definition = serverForLanguage(languageId);
        if (!definition || !definition.installable) {
            return undefined;
        }
        await this.ready;
        if (await definition.resolve(root)) {
            return undefined;
        }
        return { serverId: definition.id, name: definition.name, ...await this.installer.plan(definition.id) };
    }

    request(key: string, method: string, params: unknown): Promise<unknown> {
        return this.get(key).connection.sendRequest(method, params);
    }

    notify(key: string, method: string, params: unknown): void {
        const server = this.servers.get(key);
        if (server) {
            server.connection.sendNotification(method, params).catch(() => undefined);
        }
    }

    /** Stops the servers of a worktree, for example when the user removes the worktree. */
    async stopRoot(root: string): Promise<void> {
        await Promise.all([...this.servers.values()].filter(server => server.info.root === root).map(server => this.stop(server)));
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.servers.values()].map(server => this.stop(server)));
    }

    private async start(key: string, serverId: string, root: string, languageId: string): Promise<RunningServer | undefined> {
        await this.ready;
        const command = await serverForLanguage(languageId)!.resolve(root);
        if (!command) {
            return undefined;
        }
        const child = spawn(command.command, command.args, { cwd: root, env: { ...process.env, ...command.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stderr?.on('data', data => console.warn(`[lsp ${serverId}] ${String(data).trimEnd()}`));
        const connection = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));

        const rootUri = pathToFileURL(root).href;
        const folders = [{ uri: rootUri, name: path.basename(root) }];
        connection.onRequest((method, params) => this.handleServerRequest(key, method, params, folders));
        connection.onNotification((method, params) => {
            if (FORWARDED_NOTIFICATIONS.has(method)) {
                this.send({ key, method, params });
            } else if (method === 'window/logMessage' || method === 'window/showMessage') {
                console.log(`[lsp ${serverId}] ${(params as { message?: string })?.message ?? ''}`);
            }
        });
        connection.listen();

        const server: RunningServer = {
            info: { key, serverId, root, capabilities: {} },
            process: child,
            connection
        };
        child.on('exit', code => {
            if (this.servers.get(key) === server) {
                this.servers.delete(key);
                this.send({ key, method: 'shipwarden/serverExited', params: { code } });
            }
            connection.dispose();
        });

        try {
            const result = await connection.sendRequest<InitializeResult>('initialize', {
                processId: process.pid,
                clientInfo: { name: 'ShipWarden' },
                rootUri,
                rootPath: root,
                workspaceFolders: folders,
                capabilities: CLIENT_CAPABILITIES,
                initializationOptions: command.initializationOptions
            });
            connection.sendNotification('initialized', {});
            server.info.capabilities = result.capabilities;
        } catch (error) {
            console.warn(`[lsp ${serverId}] The server did not start: ${error instanceof Error ? error.message : String(error)}`);
            child.kill();
            return undefined;
        }
        this.servers.set(key, server);
        return server;
    }

    /** Answers the requests that a server sends to the client. */
    private handleServerRequest(key: string, method: string, params: unknown, folders: { uri: string; name: string }[]): unknown {
        switch (method) {
            case 'workspace/configuration':
                // ShipWarden has no server settings yet. Each server then uses its defaults.
                return ((params as { items?: unknown[] })?.items ?? []).map(() => null);
            case 'workspace/workspaceFolders':
                return folders;
            case 'workspace/diagnostic/refresh':
                this.send({ key, method, params });
                return null;
            default:
                // client/registerCapability, window/workDoneProgress/create and similar requests need no action.
                return null;
        }
    }

    private async stop(server: RunningServer): Promise<void> {
        this.servers.delete(server.info.key);
        try {
            await Promise.race([server.connection.sendRequest('shutdown'), new Promise(resolve => setTimeout(resolve, 1000))]);
            server.connection.sendNotification('exit').catch(() => undefined);
        } catch {
            // The server is not responding. Stop the process.
        }
        setTimeout(() => server.process.kill(), 500);
    }

    private get(key: string): RunningServer {
        const server = this.servers.get(key);
        if (!server) {
            throw new Error(`The language server "${key}" is not running.`);
        }
        return server;
    }
}
