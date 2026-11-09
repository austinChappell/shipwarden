import { readFileSync, writeFileSync } from 'fs';
import { geminiHookSettings } from '@shared/agents';

/** Returns the path of the system defaults file that Gemini CLI reads when GEMINI_CLI_SYSTEM_DEFAULTS_PATH is not set. */
export function defaultGeminiSystemDefaultsPath(platform: NodeJS.Platform = process.platform): string {
    switch (platform) {
        case 'darwin':
            return '/Library/Application Support/GeminiCli/system-defaults.json';
        case 'win32':
            return 'C:\\ProgramData\\gemini-cli\\system-defaults.json';
        default:
            return '/etc/gemini-cli/system-defaults.json';
    }
}

/**
 * Reads the system defaults file that Gemini CLI uses without ShipWarden.
 * Returns an empty object when the file does not exist or does not contain a JSON object.
 */
function readBase(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * Writes ShipWarden's Gemini CLI settings file to `target`.
 * ShipWarden's file replaces the system defaults file of Gemini CLI. Thus the file also gets the values of the
 * system defaults file that Gemini CLI uses without ShipWarden.
 * `env` is the environment of the app. A GEMINI_CLI_SYSTEM_DEFAULTS_PATH value in it is the file that Gemini CLI uses.
 */
export function writeGeminiHookSettings(target: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
    const own = env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
    const basePath = own && own !== target ? own : defaultGeminiSystemDefaultsPath(platform);
    writeFileSync(target, JSON.stringify(geminiHookSettings(readBase(basePath)), null, 2));
}
