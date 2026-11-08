import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TerminalSettings } from '@shared/terminal';
import { DEFAULT_TERMINAL_SETTINGS, settingsFromGhosttyConfig } from './ghostty-config';

const GHOSTTY_APP_BINARY = '/Applications/Ghostty.app/Contents/MacOS/ghostty';

/** Returns the Ghostty config files, in the order that Ghostty reads them. */
function configFiles(): string[] {
    const home = os.homedir();
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    const appSupport = path.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty');
    return [
        path.join(xdg, 'ghostty', 'config'),
        path.join(xdg, 'ghostty', 'config.ghostty'),
        path.join(appSupport, 'config'),
        path.join(appSupport, 'config.ghostty')
    ];
}

function run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

/**
 * Loads the terminal settings from the user's Ghostty config.
 * 1. If Ghostty is installed, run `ghostty +show-config`. Ghostty then resolves themes and included files.
 * 2. If that fails, read the config files directly.
 * 3. If there is no config, use the defaults.
 */
export async function loadGhosttySettings(): Promise<TerminalSettings> {
    for (const binary of [GHOSTTY_APP_BINARY, 'ghostty']) {
        try {
            const output = await run(binary, ['+show-config']);
            if (output.trim()) {
                return settingsFromGhosttyConfig(output, `${binary} +show-config`);
            }
        } catch {
            // Ghostty is not at this location. Try the next location.
        }
    }

    const texts: string[] = [];
    const sources: string[] = [];
    for (const file of configFiles()) {
        try {
            texts.push(await fs.readFile(file, 'utf8'));
            sources.push(file);
        } catch {
            // The file does not exist.
        }
    }
    if (texts.length > 0) {
        return settingsFromGhosttyConfig(texts.join('\n'), sources.join(', '));
    }
    return DEFAULT_TERMINAL_SETTINGS;
}
