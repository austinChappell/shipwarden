import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import type { RepoRef } from '@shared/github';
import {
    normalizeTaskConfig,
    type ConnectionInfo,
    type PluginInfo,
    type TaskConfig,
    type ConnectionChange,
    type TaskConnection,
    type TaskLink,
    type TaskScope,
    type TaskSource
} from '@shared/tasks';
import { discoverPlugins, SUPPORTED_PROTOCOL_VERSION, type DiscoveredPlugin } from './plugin-registry';
import { JsonStore } from './json-store';

/** The settings store that the host needs. PluginSettings implements it. The key is the connection ID. */
export interface SettingsProvider {
    values(id: string): Promise<Record<string, string | boolean>>;
    save(id: string, definitions: NonNullable<DiscoveredPlugin['manifest']['settings']>, values: Record<string, string | boolean>): Promise<boolean>;
    remove(id: string): Promise<void>;
}

export interface TaskHostOptions {
    /** Extra environment variables for the plugin processes, for example NODE_EXTRA_CA_CERTS. */
    pluginEnv?(): Promise<Record<string, string>>;
    /** The folders that contain plugin folders. */
    pluginFolders: { path: string; builtIn: boolean }[];
    settings: SettingsProvider;
    /** Returns the GitHub repository of a worktree, or null. */
    repoFor(root: string): Promise<RepoRef | null>;
    /** Returns the repositories of all ShipWarden projects. */
    allRepos(): Promise<string[]>;
    /** The file that keeps the connections. */
    configFile: string;
    /** The file of protocol version 2 with the task source of each repository. ShipWarden reads it once, to make the first connections. */
    legacySourcesFile: string;
    /** The file that keeps the task of each worktree. */
    linksFile: string;
    /** The file that keeps the selected collection of each connection. */
    collectionsFile: string;
    /** The file that keeps the selected connection of the Tasks view. */
    selectedConnectionsFile: string;
    /** Called when a plugin reports changed tasks. */
    onChanged(connectionId: string): void;
}

interface RunningPlugin {
    key: string;
    connectionId: string;
    process: ChildProcess;
    connection: MessageConnection;
    source: TaskSource;
    /** The repositories that the process received at the start, one on each line. Undefined when the plugin does not use repositories. */
    repositories: string | undefined;
}

/**
 * The kinds of plugin process of a connection.
 * - "tasks": the process for all views and all projects. It uses the scope of the connection.
 * - "scopes": the process for the scope list in Settings. It sees all scopes and gets no repositories.
 */
type ProcessKind = 'tasks' | 'scopes';

const INITIALIZE_TIMEOUT_MS = 30_000;
/** The key of the selected connection in its file. Older versions kept one selected connection for each project. */
const SELECTED_CONNECTION_KEY = '*';

/**
 * Runs the task plugins. A connection is a plugin with its own settings and scope. ShipWarden runs one process for
 * each connection, and all projects use it. Thus a project switch sends no new requests to the tracker.
 * A plugin that uses repositories (for example GitHub uses them to select its default repository) gets the
 * repositories of all projects. When these repositories change, the process starts again at the next request.
 */
export class TaskHost {
    private discovered: DiscoveredPlugin[] | undefined;
    private readonly running = new Map<string, RunningPlugin>();
    private readonly starting = new Map<string, Promise<RunningPlugin>>();
    private readonly config: JsonStore<Partial<TaskConfig>>;
    private migrated: Promise<void> | undefined;
    private readonly links: JsonStore<Record<string, TaskLink>>;
    /** The selected collection of each connection, by connection ID. */
    private readonly collections: JsonStore<Record<string, string>>;
    /** The selected connection of the Tasks view, at SELECTED_CONNECTION_KEY. */
    private readonly selectedConnections: JsonStore<Record<string, string>>;

    constructor(private readonly options: TaskHostOptions) {
        this.config = new JsonStore(options.configFile, () => ({}));
        this.links = new JsonStore(options.linksFile, () => ({}));
        this.collections = new JsonStore(options.collectionsFile, () => ({}));
        this.selectedConnections = new JsonStore(options.selectedConnectionsFile, () => ({}));
    }

    /** The plugins that ShipWarden found: the kinds of task manager that the user can add. */
    async plugins(): Promise<PluginInfo[]> {
        return (await this.discover(true)).map(plugin => ({
            id: plugin.manifest.id,
            name: plugin.manifest.name,
            version: plugin.manifest.version,
            description: plugin.manifest.description,
            settings: plugin.manifest.settings ?? [],
            builtIn: plugin.builtIn,
            scopeLabel: plugin.manifest.scopeLabel
        }));
    }

    async taskConfig(): Promise<TaskConfig> {
        await this.migrate();
        return normalizeTaskConfig(await this.config.get());
    }

    /** All connections with the state of their settings. */
    async connections(): Promise<ConnectionInfo[]> {
        const config = await this.taskConfig();
        return Promise.all(config.connections.map(connection => this.info(connection)));
    }

    /** The connections that are on. Each project uses these. */
    async enabledConnections(): Promise<ConnectionInfo[]> {
        const config = await this.taskConfig();
        return Promise.all(config.connections.filter(connection => connection.enabled).map(connection => this.info(connection)));
    }

    /** Adds a connection of a plugin. It is on and includes all scopes. */
    async addConnection(pluginId: string, name: string): Promise<ConnectionInfo> {
        const plugin = await this.find(pluginId);
        const connection: TaskConnection = {
            id: `${pluginId}-${randomUUID().slice(0, 8)}`,
            pluginId,
            name: name.trim() || plugin.manifest.name,
            enabled: true
        };
        await this.updateConfig(config => ({ ...config, connections: [...config.connections, connection] }));
        return this.info(connection);
    }

    /** Changes the name, the scope or the on/off state of a connection. `scope` null means all scopes. */
    async updateConnection(id: string, change: ConnectionChange): Promise<void> {
        await this.updateConfig(config => ({
            ...config,
            connections: config.connections.map(connection => {
                if (connection.id !== id) return connection;
                const next: TaskConnection = {
                    ...connection,
                    ...(change.name !== undefined && change.name.trim() ? { name: change.name.trim() } : {}),
                    ...(change.scope !== undefined ? { scope: change.scope ?? undefined } : {}),
                    ...(change.enabled !== undefined ? { enabled: change.enabled } : {})
                };
                if (change.startStatus !== undefined) {
                    const status = change.startStatus?.trim();
                    if (status) next.startStatus = status;
                    else delete next.startStatus;
                }
                return next;
            })
        }));
        // The plugin does not use the start status, so a change of only the start status does not restart it.
        if (change.name !== undefined || change.scope !== undefined || change.enabled !== undefined) {
            await this.stopConnection(id);
        }
    }

    /** Saves the settings of a connection and stops its processes, so the next request starts them with the new values. */
    async saveConnectionSettings(id: string, values: Record<string, string | boolean>): Promise<void> {
        const connection = await this.connection(id);
        const plugin = await this.find(connection.pluginId);
        if (await this.options.settings.save(id, plugin.manifest.settings ?? [], values)) {
            await this.stopConnection(id);
        }
    }

    /** Removes a connection and its settings. */
    async removeConnection(id: string): Promise<void> {
        await this.updateConfig(config => ({ connections: config.connections.filter(connection => connection.id !== id) }));
        await this.stopConnection(id);
        await this.options.settings.remove(id);
    }

    /** The scopes that a connection can include, for example the ClickUp workspaces of its token. */
    async scopes(connectionId: string): Promise<TaskScope[]> {
        const plugin = await this.ensure(connectionId, 'scopes');
        if (!plugin.source.capabilities.scopes) {
            return [];
        }
        return plugin.connection.sendRequest<TaskScope[]>('scopes/list', {});
    }

    /** Starts the plugin of a connection, if necessary, and returns its description. */
    async source(connectionId: string): Promise<TaskSource> {
        return (await this.ensure(connectionId)).source;
    }

    /** Sends a protocol request, for example "tasks/list", to the plugin of a connection. */
    async request(connectionId: string, method: string, params: unknown): Promise<unknown> {
        const plugin = await this.ensure(connectionId);
        return plugin.connection.sendRequest(method, params);
    }

    async allLinks(): Promise<Record<string, TaskLink>> {
        return this.links.get();
    }

    async setLink(worktreePath: string, link: TaskLink | null): Promise<void> {
        await this.links.update(all => {
            const next = { ...all };
            if (link) {
                next[worktreePath] = link;
            } else {
                delete next[worktreePath];
            }
            return next;
        });
    }

    /** Returns the collection that the user selected last for a connection, in any project. */
    async selectedCollection(connectionId: string): Promise<string | undefined> {
        return (await this.collections.get())[connectionId];
    }

    /** Remembers the selected collection of a connection, so the next start and the next switch to it show it again. */
    async setSelectedCollection(connectionId: string, collectionId: string): Promise<void> {
        await this.collections.update(all => ({ ...all, [connectionId]: collectionId }));
    }

    /** Returns the connection that the Tasks view showed last. A file of an older version gives the connection of one of its projects. */
    async selectedConnection(): Promise<string | undefined> {
        const all = await this.selectedConnections.get();
        return all[SELECTED_CONNECTION_KEY] ?? Object.values(all)[0];
    }

    async setSelectedConnection(connectionId: string): Promise<void> {
        await this.selectedConnections.update(() => ({ [SELECTED_CONNECTION_KEY]: connectionId }));
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.running.values()].map(item => this.stop(item)));
    }

    /**
     * Makes the first connections from the settings of protocol version 2, one time:
     * a "ClickUp" connection when ClickUp has settings, and a "GitHub" connection. The connection IDs are the plugin IDs,
     * so the saved settings, the selected collections and the task links of version 2 stay valid.
     */
    private migrate(): Promise<void> {
        this.migrated ??= (async () => {
            const stored = await this.config.get();
            if (Array.isArray(stored.connections)) {
                return;
            }
            let legacySources: Record<string, string | null> = {};
            try {
                legacySources = JSON.parse(await fs.readFile(this.options.legacySourcesFile, 'utf8'));
            } catch {
                // There was no version 2 configuration.
            }
            const clickup = await this.options.settings.values('clickup');
            const plugins = (await this.discover()).map(plugin => plugin.manifest.id);
            const connections: TaskConnection[] = [];
            if (plugins.includes('clickup') && (clickup.apiToken || Object.values(legacySources).includes('clickup'))) {
                const teamId = typeof clickup.teamId === 'string' && clickup.teamId.trim() ? [clickup.teamId.trim()] : undefined;
                connections.push({ id: 'clickup', pluginId: 'clickup', name: 'ClickUp', scope: teamId, enabled: true });
            }
            if (plugins.includes('github-issues')) {
                connections.push({ id: 'github-issues', pluginId: 'github-issues', name: 'GitHub', enabled: true });
            }
            await this.config.update(() => ({ connections }));
        })();
        return this.migrated;
    }

    private async updateConfig(change: (config: TaskConfig) => TaskConfig): Promise<void> {
        await this.migrate();
        await this.config.update(stored => change(normalizeTaskConfig(stored)));
    }

    private async connection(id: string): Promise<TaskConnection> {
        const connection = (await this.taskConfig()).connections.find(item => item.id === id);
        if (!connection) {
            throw new Error('This task manager does not exist. It was possibly removed in the settings.');
        }
        return connection;
    }

    private async info(connection: TaskConnection): Promise<ConnectionInfo> {
        const plugin = (await this.discover()).find(item => item.manifest.id === connection.pluginId);
        const definitions = plugin?.manifest.settings ?? [];
        const values = await this.options.settings.values(connection.id);
        const withValue = definitions
            .filter(definition => values[definition.key] !== undefined && values[definition.key] !== '')
            .map(definition => definition.key);
        const publicSettings: Record<string, string | boolean> = {};
        for (const definition of definitions) {
            if (definition.type !== 'secret' && values[definition.key] !== undefined) {
                publicSettings[definition.key] = values[definition.key];
            }
        }
        return {
            ...connection,
            pluginName: plugin?.manifest.name ?? `${connection.pluginId} (not installed)`,
            scopeLabel: plugin?.manifest.scopeLabel,
            settings: definitions,
            configured: !!plugin && definitions.filter(definition => definition.required).every(definition => withValue.includes(definition.key)),
            settingsWithValue: withValue,
            publicSettings
        };
    }

    private async discover(force = false): Promise<DiscoveredPlugin[]> {
        if (!this.discovered || force) {
            this.discovered = await discoverPlugins(this.options.pluginFolders);
        }
        return this.discovered;
    }

    private async find(pluginId: string): Promise<DiscoveredPlugin> {
        const plugin =
            (await this.discover()).find(item => item.manifest.id === pluginId) ?? (await this.discover(true)).find(item => item.manifest.id === pluginId);
        if (!plugin) {
            throw new Error(`The task plugin "${pluginId}" is not installed.`);
        }
        return plugin;
    }

    /**
     * Returns the running process of a connection. A process that received other repositories than the projects
     * have now stops, and a new process starts.
     */
    private async ensure(connectionId: string, kind: ProcessKind = 'tasks'): Promise<RunningPlugin> {
        const key = `${connectionId}\0${kind}`;
        const repositories = kind === 'tasks' ? await this.repositoriesFor(connectionId) : undefined;
        const running = this.running.get(key);
        if (running && running.repositories === repositories?.join('\n')) {
            return running;
        }
        if (running) {
            void this.stop(running);
        }
        let promise = this.starting.get(key);
        if (!promise) {
            promise = this.start(connectionId, key, repositories).finally(() => this.starting.delete(key));
            this.starting.set(key, promise);
        }
        return promise;
    }

    /** Returns the repositories of all projects, without duplicates. Undefined when the plugin of the connection does not use repositories. */
    private async repositoriesFor(connectionId: string): Promise<string[] | undefined> {
        const connection = (await this.taskConfig()).connections.find(item => item.id === connectionId);
        const plugin = connection && (await this.discover()).find(item => item.manifest.id === connection.pluginId);
        if (plugin?.manifest.usesRepositories === false) {
            return undefined;
        }
        return [...new Set(await this.options.allRepos())];
    }

    /** Starts a process. `repositories` undefined means that the plugin gets no repositories. A "scopes" process sees all scopes. */
    private async start(connectionId: string, key: string, repositories: string[] | undefined): Promise<RunningPlugin> {
        const config = await this.taskConfig();
        const base = config.connections.find(item => item.id === connectionId);
        if (!base) {
            throw new Error('This task manager does not exist. It was possibly removed in the settings.');
        }
        // The "tasks" process uses the connection's scope. The "scopes" process (the scope list in Settings) sees all scopes.
        const connection = key.endsWith('\0scopes') ? { ...base, scope: undefined } : base;
        const plugin = await this.find(connection.pluginId);
        const { manifest } = plugin;
        // "node" means ShipWarden's own Node runtime, so the user does not need Node.
        const useOwnNode = manifest.command === 'node';
        const extraEnv = (await this.options.pluginEnv?.()) ?? {};
        const child = spawn(useOwnNode ? process.execPath : manifest.command, manifest.args ?? [], {
            cwd: plugin.folder,
            env: { ...process.env, ...extraEnv, ...(useOwnNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        child.stderr?.on('data', data => console.log(`[plugin ${connection.name}] ${String(data).trimEnd()}`));
        const messages = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
        messages.onNotification('tasks/changed', () => this.options.onChanged(connectionId));
        messages.listen();

        const exited = new Promise<never>((_resolve, reject) => {
            child.once('error', error => reject(new Error(`The plugin "${manifest.name}" did not start: ${error.message}`)));
            child.once('exit', code => reject(new Error(`The plugin "${manifest.name}" stopped with exit code ${code}.`)));
        });
        exited.catch(() => undefined);

        try {
            const contextRepositories = await Promise.all(
                (repositories ?? []).map(async root => {
                    const github = await this.options.repoFor(root);
                    return { root, ...(github ? { github } : {}) };
                })
            );
            const initialize = messages.sendRequest<{
                name?: string;
                capabilities?: TaskSource['capabilities'];
                fields?: TaskSource['fields'];
                actions?: TaskSource['actions'];
                filters?: TaskSource['filters'];
            }>('initialize', {
                protocolVersion: SUPPORTED_PROTOCOL_VERSION,
                settings: await this.options.settings.values(connectionId),
                ...(connection.scope ? { scope: connection.scope } : {}),
                context: { repositories: contextRepositories }
            });
            const timeout = new Promise<never>((_resolve, reject) =>
                setTimeout(
                    () => reject(new Error(`The plugin "${manifest.name}" did not answer in ${INITIALIZE_TIMEOUT_MS / 1000} seconds.`)),
                    INITIALIZE_TIMEOUT_MS
                )
            );
            const result = await Promise.race([initialize, exited, timeout]);
            const running: RunningPlugin = {
                key,
                connectionId,
                process: child,
                connection: messages,
                repositories: repositories?.join('\n'),
                source: {
                    connectionId,
                    pluginId: connection.pluginId,
                    name: connection.name,
                    capabilities: result.capabilities ?? {},
                    fields: result.fields ?? [],
                    actions: result.actions ?? [],
                    filters: result.filters ?? []
                }
            };
            this.running.set(key, running);
            child.once('exit', () => {
                if (this.running.get(key) === running) {
                    this.running.delete(key);
                }
                messages.dispose();
            });
            return running;
        } catch (error) {
            child.kill();
            messages.dispose();
            throw error;
        }
    }

    private async stopConnection(connectionId: string): Promise<void> {
        await Promise.all([...this.running.values()].filter(item => item.connectionId === connectionId).map(item => this.stop(item)));
    }

    private async stop(plugin: RunningPlugin): Promise<void> {
        this.running.delete(plugin.key);
        try {
            await Promise.race([plugin.connection.sendRequest('shutdown'), new Promise(resolve => setTimeout(resolve, 1000))]);
        } catch {
            // The plugin is not responding. Stop the process.
        }
        setTimeout(() => plugin.process.kill(), 300);
    }
}
