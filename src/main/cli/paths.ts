import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { CLI_CONFIG_ENV, CLI_CONFIG_NAME, CLI_PROTOCOL } from '@shared/cli';

/**
 * Returns the path of the CLI config file. The env variable wins. A separate app data folder (a test of a first start)
 * keeps its file in that folder. Else the file is in ~/.shipwarden, so the CLI finds it without the app data folder.
 */
export function cliConfigPath(home: string, env: Record<string, string | undefined>, separateDataFolder?: string): string {
    const fromEnv = env[CLI_CONFIG_ENV]?.trim();
    if (fromEnv) return fromEnv;
    return separateDataFolder ? join(separateDataFolder, CLI_CONFIG_NAME) : join(home, '.shipwarden', CLI_CONFIG_NAME);
}

/** macOS accepts a socket path of at most 104 bytes. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Returns the socket path of the CLI server for an app data folder.
 * When the path is too long, the socket is in the temporary folder, with a hash of the app data folder.
 */
export function cliSocketPath(folder: string): string {
    const name = `cli-v${CLI_PROTOCOL}.sock`;
    const path = join(folder, name);
    if (Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES) return path;
    return join(tmpdir(), `sw-${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`, name);
}
