import { isAbsolute, join, resolve } from 'path';

/** The environment variable that selects a different app data folder, for a test of a first start. */
export const USER_DATA_VARIABLE = 'SHIPWARDEN_USER_DATA_DIR';

/**
 * Returns the app data folder of `SHIPWARDEN_USER_DATA_DIR`, as an absolute path. Returns undefined when the variable is
 * empty or not set. A leading "~" is the home folder. A relative path starts at `cwd`.
 */
export function userDataOverride(env: Record<string, string | undefined>, cwd: string, home: string): string | undefined {
    const value = env[USER_DATA_VARIABLE]?.trim();
    if (!value) return undefined;
    if (value === '~') return home;
    if (value.startsWith('~/')) return join(home, value.slice(2));
    return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}
