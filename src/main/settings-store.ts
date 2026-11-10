import { normalizeSettings, type AppSettings } from '@shared/settings';
import { JsonStore } from './tasks/json-store';

/** Keeps the app settings in a JSON file. */
export class SettingsStore {
    private readonly store: JsonStore<Partial<AppSettings>>;

    constructor(file: string) {
        this.store = new JsonStore<Partial<AppSettings>>(file, () => ({}));
    }

    async get(): Promise<AppSettings> {
        return normalizeSettings(await this.store.get());
    }

    /** Changes some settings. Returns all settings after the change. */
    async update(change: Partial<AppSettings>): Promise<AppSettings> {
        const next = normalizeSettings({ ...(await this.get()), ...change });
        await this.store.update(() => next);
        return next;
    }
}
