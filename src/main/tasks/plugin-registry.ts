import { promises as fs } from 'fs';
import * as path from 'path';
import type { SettingDefinition } from '@shared/tasks';

export const MANIFEST_FILE = 'shipwarden-plugin.json';
/** The manifest name from the time when the app was Yardmaster. A plugin with only this file still loads. */
export const LEGACY_MANIFEST_FILE = 'yardmaster-plugin.json';
export const SUPPORTED_PROTOCOL_VERSION = 3;

export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    protocolVersion: number;
    description?: string;
    command: string;
    args?: string[];
    settings?: SettingDefinition[];
    /** The word for a scope in the UI, for example "workspace" (ClickUp) or "organization" (GitHub). */
    scopeLabel?: string;
    /**
     * False when the plugin does not use the repositories of the projects (for example ClickUp and Linear).
     * Then a change of the repositories does not start the plugin again, and the plugin keeps its cache. The default is true.
     */
    usesRepositories?: boolean;
}

export interface DiscoveredPlugin {
    manifest: PluginManifest;
    /** The plugin folder. The plugin process starts in this folder. */
    folder: string;
    builtIn: boolean;
}

/** Checks a manifest. Returns an error message, or undefined when the manifest is valid. */
export function validateManifest(value: unknown): string | undefined {
    const manifest = value as Partial<PluginManifest>;
    if (!manifest || typeof manifest !== 'object') return 'The manifest is not a JSON object.';
    if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) return 'The "id" must have only lowercase letters, digits and hyphens.';
    if (typeof manifest.name !== 'string' || !manifest.name) return 'The "name" is missing.';
    if (typeof manifest.command !== 'string' || !manifest.command) return 'The "command" is missing.';
    if (manifest.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) return `The "protocolVersion" must be ${SUPPORTED_PROTOCOL_VERSION}.`;
    if (manifest.args !== undefined && !Array.isArray(manifest.args)) return 'The "args" must be a list of strings.';
    if (manifest.usesRepositories !== undefined && typeof manifest.usesRepositories !== 'boolean') return 'The "usesRepositories" must be true or false.';
    return undefined;
}

/**
 * Finds the plugins in the folders. A plugin is a subfolder with a shipwarden-plugin.json file.
 * A plugin in a later folder replaces a built-in plugin with the same ID.
 */
export async function discoverPlugins(folders: { path: string; builtIn: boolean }[]): Promise<DiscoveredPlugin[]> {
    const plugins = new Map<string, DiscoveredPlugin>();
    for (const folder of folders) {
        let names: string[];
        try {
            names = await fs.readdir(folder.path);
        } catch {
            continue;
        }
        for (const name of names.sort()) {
            const pluginFolder = path.join(folder.path, name);
            let manifest: unknown;
            try {
                const text = await fs
                    .readFile(path.join(pluginFolder, MANIFEST_FILE), 'utf8')
                    .catch(() => fs.readFile(path.join(pluginFolder, LEGACY_MANIFEST_FILE), 'utf8'));
                manifest = JSON.parse(text);
            } catch {
                // The folder has no manifest, for example the SDK folder.
                continue;
            }
            const problem = validateManifest(manifest);
            if (problem) {
                console.warn(`[tasks] ShipWarden ignores the plugin in ${pluginFolder}: ${problem}`);
                continue;
            }
            const valid = manifest as PluginManifest;
            plugins.set(valid.id, { manifest: { ...valid, version: valid.version ?? '0.0.0' }, folder: pluginFolder, builtIn: folder.builtIn });
        }
    }
    return [...plugins.values()];
}
