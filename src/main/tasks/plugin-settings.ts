import { safeStorage } from 'electron';
import type { SettingDefinition } from '@shared/tasks';
import { JsonStore } from './json-store';

type StoredValue = string | boolean | { encrypted: string };

/**
 * Keeps the settings of the task plugins. Secret settings are encrypted with the macOS keychain
 * (Electron safeStorage) when it is available.
 */
export class PluginSettings {
    private readonly store: JsonStore<Record<string, Record<string, StoredValue>>>;

    constructor(file: string) {
        this.store = new JsonStore(file, () => ({}));
    }

    /**
     * Returns the values of a plugin, with secrets decrypted. Only the plugin process gets these values.
     * When the keychain key changed, the secret is encrypted again with the new key and saved.
     */
    async values(pluginId: string): Promise<Record<string, string | boolean>> {
        const stored = (await this.store.get())[pluginId] ?? {};
        const values: Record<string, string | boolean> = {};
        const reEncrypted: Record<string, StoredValue> = {};
        for (const [key, value] of Object.entries(stored)) {
            if (typeof value === 'object') {
                try {
                    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(value.encrypted, 'base64'));
                    values[key] = result;
                    if (shouldReEncrypt) {
                        reEncrypted[key] = { encrypted: (await safeStorage.encryptStringAsync(result)).toString('base64') };
                    }
                } catch {
                    // The keychain cannot decrypt the value. The user must enter it again.
                }
            } else {
                values[key] = value;
            }
        }
        if (Object.keys(reEncrypted).length > 0) {
            await this.store.update(all => ({ ...all, [pluginId]: { ...(all[pluginId] ?? {}), ...reEncrypted } }));
        }
        return values;
    }

    /**
     * Saves the values. A secret with an empty value keeps its old value, because the UI never receives secrets.
     * Returns true when a value changed.
     */
    async save(pluginId: string, definitions: SettingDefinition[], values: Record<string, string | boolean>): Promise<boolean> {
        // The encryption is asynchronous, so it happens before the update of the store.
        const encrypted: Record<string, StoredValue> = {};
        const canEncrypt = await safeStorage.isAsyncEncryptionAvailable();
        for (const definition of definitions) {
            const value = values[definition.key];
            if (definition.type === 'secret' && typeof value === 'string' && value !== '') {
                encrypted[definition.key] = canEncrypt ? { encrypted: (await safeStorage.encryptStringAsync(value)).toString('base64') } : value;
            }
        }
        let changed = false;
        await this.store.update(all => {
            const current = { ...(all[pluginId] ?? {}) };
            for (const definition of definitions) {
                if (!(definition.key in values)) {
                    continue;
                }
                const value = values[definition.key];
                if (definition.type === 'secret') {
                    if (typeof value !== 'string' || value === '') {
                        continue;
                    }
                    current[definition.key] = encrypted[definition.key];
                } else if (value === '' || value === undefined) {
                    delete current[definition.key];
                } else {
                    current[definition.key] = value;
                }
                changed = true;
            }
            return { ...all, [pluginId]: current };
        });
        return changed;
    }

    /** Removes all settings of a connection, for example when the user removes the connection. */
    async remove(id: string): Promise<void> {
        await this.store.update(all => {
            const next = { ...all };
            delete next[id];
            return next;
        });
    }

    /** Removes one setting, for example a secret that the user wants to forget. */
    async clear(pluginId: string, key: string): Promise<void> {
        await this.store.update(all => {
            const current = { ...(all[pluginId] ?? {}) };
            delete current[key];
            return { ...all, [pluginId]: current };
        });
    }
}
