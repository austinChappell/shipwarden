import { cpSync, existsSync, lstatSync, renameSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

/** The names of the data folder of the app before it was ShipWarden. The name was lowercase in some builds. */
export const LEGACY_NAMES = ['Yardmaster', 'yardmaster'];

/** Returns the data folder of the old app name, if it exists. */
export function legacyDataFolder(appData: string): string | undefined {
    return LEGACY_NAMES.map(name => join(appData, name)).find(folder => existsSync(folder));
}

/** A file in the new data folder that tells that the copy is done, so it does not occur again. */
const MARKER = '.copied-from-yardmaster';

/** Folders of Chromium caches. The app makes them again, so the copy leaves them out. */
const CACHE_FOLDERS = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage', 'Shared Dictionary']);

/** Files that only a running app uses: locks and sockets. */
function skip(source: string): boolean {
    const name = basename(source);
    if (CACHE_FOLDERS.has(name) || name.startsWith('Singleton') || name.endsWith('.sock') || name === 'pty-host.log') return true;
    try {
        const stat = lstatSync(source);
        return stat.isSocket() || stat.isFIFO();
    } catch {
        return true;
    }
}

export interface MigrationResult {
    /** The folders that the migration copied, as "from → to". */
    copied: string[];
    errors: string[];
}

/**
 * Copies the data of Yardmaster to the folders of ShipWarden one time, when the new folders do not exist yet:
 * - The app data folder (settings, projects, task managers, the local storage of the page).
 * - The notes and the user plugins in the home folder (~/.yardmaster → ~/.shipwarden).
 *
 * It copies and does not move, so the old folders stay as a backup. It does not copy the worktrees folder, because git
 * keeps the paths of the worktrees. The worktrees stay where they are.
 */
export function migrateLegacyData(options: { appData: string; userData: string; home: string }): MigrationResult {
    const result: MigrationResult = { copied: [], errors: [] };
    const copy = (from: string, to: string) => {
        try {
            cpSync(from, to, { recursive: true, errorOnExist: false, force: false, filter: source => !skip(source) });
            result.copied.push(`${from} → ${to}`);
        } catch (error) {
            result.errors.push(`${from}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const legacyData = legacyDataFolder(options.appData);
    if (
        legacyData &&
        legacyData.toLowerCase() !== options.userData.toLowerCase() &&
        !existsSync(join(options.userData, MARKER)) &&
        !existsSync(join(options.userData, 'settings.json'))
    ) {
        copy(legacyData, options.userData);
        try {
            writeFileSync(join(options.userData, MARKER), `${new Date().toISOString()}\n`);
        } catch {
            // Without the marker, the settings file still stops a second copy.
        }
    }

    const legacyHome = join(options.home, '.yardmaster');
    const home = join(options.home, '.shipwarden');
    for (const folder of ['notes', 'plugins']) {
        const from = join(legacyHome, folder);
        const to = join(home, folder);
        if (!existsSync(from) || existsSync(to)) continue;
        copy(from, to);
        if (folder === 'notes' && existsSync(join(to, '.yardmaster-notes.json')) && !existsSync(join(to, '.shipwarden-notes.json'))) {
            try {
                renameSync(join(to, '.yardmaster-notes.json'), join(to, '.shipwarden-notes.json'));
            } catch (error) {
                result.errors.push(`notes index: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    return result;
}
