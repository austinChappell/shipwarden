import type { SettingDefinition } from '@shared/tasks';
import { PluginSettings } from '../tasks/plugin-settings';

const ID = 'azure-devops';
const DEFINITIONS: SettingDefinition[] = [{ key: 'pat', label: 'Personal access token', type: 'secret' }];

/**
 * Keeps the Azure DevOps personal access token. The token is encrypted with the macOS keychain (Electron safeStorage),
 * the same as the secrets of the task plugins. The page never gets the token.
 */
export class AzureCredentials {
    private readonly store: PluginSettings;

    constructor(file: string) {
        this.store = new PluginSettings(file);
    }

    async token(): Promise<string | undefined> {
        const value = (await this.store.values(ID)).pat;
        return typeof value === 'string' && value ? value : undefined;
    }

    async save(token: string): Promise<void> {
        await this.store.save(ID, DEFINITIONS, { pat: token.trim() });
    }

    async clear(): Promise<void> {
        await this.store.clear(ID, 'pat');
    }
}
