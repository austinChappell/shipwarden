import { promises as fs, constants } from 'fs';
import { delimiter, join } from 'path';
import { CLI_NAME, type CliInstallState } from '@shared/cli';

export interface CliInstallOptions {
    /** The launcher script in the app: ShipWarden.app/Contents/Resources/bin/shipwarden. */
    launcher: string;
    home: string;
    /** The PATH of the login shell. The page tells the user when the folder of the link is not in it. */
    path(): Promise<string>;
    /** The folders for the link, in order. The default is /usr/local/bin, then ~/.local/bin. */
    folders?: string[];
}

/** Returns the folders for the link: /usr/local/bin first, because it is in the PATH of most shells. */
export function linkFolders(home: string): string[] {
    return ['/usr/local/bin', join(home, '.local', 'bin')];
}

async function linkTarget(file: string): Promise<string | undefined> {
    try {
        return await fs.readlink(file);
    } catch {
        return undefined;
    }
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.lstat(file);
        return true;
    } catch {
        return false;
    }
}

async function writable(folder: string): Promise<boolean> {
    try {
        await fs.access(folder, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Adds and removes the `shipwarden` link (Settings › Agents). The link goes to the launcher script in the app, so an
 * update of the app also updates the command. It needs no administrator password: when /usr/local/bin is not writable,
 * the link goes to ~/.local/bin.
 */
export class CliInstaller {
    private readonly folders: string[];

    constructor(private readonly options: CliInstallOptions) {
        this.folders = options.folders ?? linkFolders(options.home);
    }

    async state(): Promise<CliInstallState> {
        const pathFolders = (await this.options.path().catch(() => '')).split(delimiter).filter(Boolean);
        for (const folder of this.folders) {
            const file = join(folder, CLI_NAME);
            if ((await linkTarget(file)) === this.options.launcher) {
                return { installed: file, launcher: this.options.launcher, inPath: pathFolders.includes(folder) };
            }
        }
        return { launcher: this.options.launcher, inPath: false };
    }

    /** Adds the link in the first folder that permits it. A link of an older app location gets the new target. */
    async install(): Promise<CliInstallState> {
        const problems: string[] = [];
        for (const [index, folder] of this.folders.entries()) {
            const last = index === this.folders.length - 1;
            // The last folder is in the home folder. ShipWarden makes it when it is missing.
            if (last) await fs.mkdir(folder, { recursive: true }).catch(() => undefined);
            if (!(await writable(folder))) {
                problems.push(`${folder} is not writable.`);
                continue;
            }
            const file = join(folder, CLI_NAME);
            if (await exists(file)) {
                const target = await linkTarget(file);
                // A file that is not a link is not from ShipWarden. ShipWarden does not replace it.
                if (target === undefined || !target.endsWith(join('bin', CLI_NAME))) {
                    problems.push(`${file} exists, and it is not a link of ShipWarden.`);
                    continue;
                }
                await fs.unlink(file);
            }
            await fs.symlink(this.options.launcher, file);
            return this.state();
        }
        throw new Error(`ShipWarden did not add the link. ${problems.join(' ')}`);
    }

    /** Removes the links to this launcher. Other files stay. */
    async remove(): Promise<CliInstallState> {
        for (const folder of this.folders) {
            const file = join(folder, CLI_NAME);
            if ((await linkTarget(file)) === this.options.launcher) await fs.unlink(file);
        }
        return this.state();
    }
}
