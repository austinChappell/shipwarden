import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverPlugins, validateManifest } from './plugin-registry';
import { TaskHost, type SettingsProvider } from './task-host';

const SDK = path.resolve(__dirname, '../../../plugins/sdk/index.js');

/** A small test plugin that uses the real SDK. It echoes its settings, its scope and the repositories of the project. */
function testPlugin(): string {
    return `
import { runPlugin } from ${JSON.stringify(SDK)};
let settings;
let scope;
let context;
runPlugin({
    async initialize(params) {
        settings = params.settings;
        scope = params.scope;
        context = params.context;
        if (!settings.token) throw new Error('The test plugin needs a token.');
        return { filters: [{ id: 'all', label: 'All', default: true }] };
    },
    async listScopes() {
        return [{ id: 'w1', name: 'Workspace 1' }, { id: 'w2', name: 'Workspace 2' }];
    },
    async listCollections() {
        return [{ id: 'inbox', name: 'Inbox in ' + (scope ? scope.join('+') : 'all') + ' for ' + context.repositories.map(repo => repo.root).join(','), default: true }];
    },
    async listTasks({ collection, filter }) {
        return { tasks: [{ id: '1', key: 'T-1', title: 'Task in ' + collection + ' with ' + settings.token + ' and ' + filter, status: { id: 'todo', name: 'To do', category: 'todo' } }] };
    },
    async getTask({ id }) {
        throw new Error('Task ' + id + ' is not here.');
    }
});
`;
}

class MemorySettings implements SettingsProvider {
    readonly data: Record<string, Record<string, string | boolean>> = {};
    async values(id: string) {
        return { ...(this.data[id] ?? {}) };
    }
    async save(id: string, _definitions: unknown, values: Record<string, string | boolean>) {
        this.data[id] = { ...(this.data[id] ?? {}), ...values };
        return true;
    }
    async remove(id: string) {
        delete this.data[id];
    }
}

describe('validateManifest', () => {
    it('accepts a valid manifest and explains a problem', () => {
        expect(validateManifest({ id: 'jira', name: 'Jira', command: 'node', protocolVersion: 3 })).toBeUndefined();
        expect(validateManifest({ id: 'Jira!', name: 'Jira', command: 'node', protocolVersion: 3 })).toContain('"id"');
        // Version 2 started a plugin for one repository and had no scopes, so its plugins do not work with this version.
        expect(validateManifest({ id: 'jira', name: 'Jira', command: 'node', protocolVersion: 2 })).toContain('protocolVersion');
    });
});

describe('TaskHost', () => {
    let dir: string;
    let host: TaskHost;
    let settings: MemorySettings;

    const makeHost = () =>
        new TaskHost({
            pluginFolders: [{ path: path.join(dir, 'plugins'), builtIn: true }],
            settings,
            repoFor: async () => null,
            projectRepos: async projectId => (projectId === 'work' ? ['/repos/api', '/repos/web'] : ['/repos/side']),
            configFile: path.join(dir, 'task-managers.json'),
            legacySourcesFile: path.join(dir, 'task-sources.json'),
            linksFile: path.join(dir, 'links.json'),
            collectionsFile: path.join(dir, 'collections.json'),
            selectedConnectionsFile: path.join(dir, 'selected.json'),
            onChanged: () => undefined
        });

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-plugins-'));
        const pluginDir = path.join(dir, 'plugins', 'test-tracker');
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(path.join(pluginDir, 'index.mjs'), testPlugin());
        await fs.writeFile(
            path.join(pluginDir, 'shipwarden-plugin.json'),
            JSON.stringify({
                id: 'test-tracker',
                name: 'Test tracker',
                version: '1.0.0',
                protocolVersion: 3,
                command: 'node',
                args: ['index.mjs'],
                scopeLabel: 'workspace',
                settings: [{ key: 'token', label: 'Token', type: 'secret', required: true }]
            })
        );
        await fs.mkdir(path.join(dir, 'plugins', 'no-manifest'));
        settings = new MemorySettings();
        host = makeHost();
    });

    afterEach(async () => {
        await host.stopAll();
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('finds the plugins and reports missing required settings of a connection', async () => {
        expect((await discoverPlugins([{ path: path.join(dir, 'plugins'), builtIn: true }])).map(plugin => plugin.manifest.id)).toEqual(['test-tracker']);
        expect((await host.plugins()).map(plugin => [plugin.id, plugin.scopeLabel])).toEqual([['test-tracker', 'workspace']]);
        expect(await host.connections()).toEqual([]);
        const added = await host.addConnection('test-tracker', 'Work tracker');
        expect(added).toMatchObject({ pluginId: 'test-tracker', name: 'Work tracker', enabled: true, configured: false, settingsWithValue: [] });
    });

    it('shows the error of a plugin that cannot start', async () => {
        const connection = await host.addConnection('test-tracker', 'Tracker');
        await expect(host.source(connection.id, 'work')).rejects.toThrow('The test plugin needs a token.');
    });

    it('starts a connection for a project with its settings, scope and repositories', async () => {
        const connection = await host.addConnection('test-tracker', 'Tracker');
        await host.saveConnectionSettings(connection.id, { token: 'abc' });
        expect((await host.connections())[0].configured).toBe(true);

        const source = await host.source(connection.id, 'work');
        expect(source).toMatchObject({
            connectionId: connection.id,
            pluginId: 'test-tracker',
            name: 'Tracker',
            filters: [{ id: 'all', label: 'All', default: true }]
        });
        expect(source.capabilities).toMatchObject({ scopes: true, update: false });
        expect(await host.scopes(connection.id)).toEqual([
            { id: 'w1', name: 'Workspace 1' },
            { id: 'w2', name: 'Workspace 2' }
        ]);

        const collections = (await host.request(connection.id, 'work', 'collections/list', {})) as { name: string }[];
        expect(collections[0].name).toBe('Inbox in all for /repos/api,/repos/web');
        const result = (await host.request(connection.id, 'work', 'tasks/list', { collection: 'inbox', filter: 'all' })) as { tasks: { title: string }[] };
        expect(result.tasks[0].title).toBe('Task in inbox with abc and all');
        await expect(host.request(connection.id, 'work', 'tasks/get', { id: '9' })).rejects.toThrow('Task 9 is not here.');

        // A new global scope restarts the plugin with the scope.
        await host.updateConnection(connection.id, { scope: ['w2'] });
        expect(((await host.request(connection.id, 'work', 'collections/list', {})) as { name: string }[])[0].name).toBe(
            'Inbox in w2 for /repos/api,/repos/web'
        );
    });

    it('lists only the connections that are on, and removes a connection with its settings', async () => {
        const a = await host.addConnection('test-tracker', 'A');
        const b = await host.addConnection('test-tracker', 'B');
        await host.saveConnectionSettings(b.id, { token: 'b' });
        await host.updateConnection(b.id, { enabled: false });
        expect((await host.enabledConnections()).map(connection => connection.name)).toEqual(['A']);

        // Each project gets its own process with its own repositories, and the connection's scope.
        await host.updateConnection(b.id, { enabled: true, scope: ['w1'] });
        expect(((await host.request(b.id, 'side', 'collections/list', {})) as { name: string }[])[0].name).toBe('Inbox in w1 for /repos/side');

        await host.removeConnection(b.id);
        expect(settings.data[b.id]).toBeUndefined();
        expect((await host.enabledConnections()).map(connection => connection.id)).toEqual([a.id]);
    });

    it('makes the first connections from the settings of protocol version 2', async () => {
        // The test folder has only the test plugin, so add ClickUp and GitHub manifests for the migration.
        for (const id of ['clickup', 'github-issues']) {
            const folder = path.join(dir, 'plugins', id);
            await fs.mkdir(folder, { recursive: true });
            await fs.writeFile(
                path.join(folder, 'shipwarden-plugin.json'),
                JSON.stringify({ id, name: id, version: '1.0.0', protocolVersion: 3, command: 'node' })
            );
        }
        settings.data.clickup = { apiToken: 'pk_1', teamId: '9013' };
        await fs.writeFile(path.join(dir, 'task-sources.json'), JSON.stringify({ '/repos/side': 'clickup' }));
        host = makeHost();
        expect((await host.connections()).map(connection => [connection.id, connection.pluginId, connection.name, connection.scope])).toEqual([
            ['clickup', 'clickup', 'ClickUp', ['9013']],
            ['github-issues', 'github-issues', 'GitHub', undefined]
        ]);
    });

    it('remembers the selected collection of each connection and the selected connection of each project', async () => {
        expect(await host.selectedCollection('clickup')).toBeUndefined();
        await host.setSelectedCollection('clickup', '901');
        await host.setSelectedCollection('github-issues', 'o/r');
        await host.setSelectedCollection('clickup', '902');
        expect(await host.selectedCollection('clickup')).toBe('902');
        expect(await host.selectedCollection('github-issues')).toBe('o/r');
        await host.setSelectedConnection('work', 'clickup');
        expect(await host.selectedConnection('work')).toBe('clickup');
        expect(await host.selectedConnection('side')).toBeUndefined();
    });

    it('keeps the task link of a worktree', async () => {
        await host.setLink('/wt/a', { connectionId: 'c1', pluginId: 'test-tracker', taskId: '1', key: 'T-1', title: 'Task' });
        expect(await host.allLinks()).toEqual({ '/wt/a': { connectionId: 'c1', pluginId: 'test-tracker', taskId: '1', key: 'T-1', title: 'Task' } });
        await host.setLink('/wt/a', null);
        expect(await host.allLinks()).toEqual({});
    });
});
