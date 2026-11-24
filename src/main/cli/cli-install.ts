import { promises as fs, constants } from 'fs';
import { delimiter, dirname, join } from 'path';
import { CLI_NAME, isValidCliAlias, type CliInstallState } from '@shared/cli';

export interface CliInstallOptions {
    /** The launcher script in the app: ShipWarden.app/Contents/Resources/bin/shipwarden. */
    launcher: string;
    home: string;
    /** The PATH of the login shell. The page tells the user when the folder of the link is not in it. */
    path(): Promise<string>;
    /** The name of the alias link, for example "sw". Undefined when the alias is off. */
    alias(): Promise<string | undefined>;
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

/** True when the link target is a launcher of ShipWarden, also of an older app location. */
function isLauncher(target: string | undefined): target is string {
    return !!target?.endsWith(join('bin', CLI_NAME));
}

/** Returns the alias name when it is valid, or undefined. */
async function aliasName(options: CliInstallOptions): Promise<string | undefined> {
    const name = await options.alias().catch(() => undefined);
    return name && isValidCliAlias(name) ? name : undefined;
}

/**
 * Adds and removes the `shipwarden` link and the alias link, for example `sw` (Settings › Agents). The links go to the
 * launcher script in the app, so an update of the app also updates the command. They need no administrator password:
 * when /usr/local/bin is not writable, the links go to ~/.local/bin. The alias link is in the folder of the
 * `shipwarden` link.
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
                return { installed: file, ...(await this.aliasState(folder)), launcher: this.options.launcher, inPath: pathFolders.includes(folder) };
            }
        }
        return { launcher: this.options.launcher, inPath: false };
    }

    /** Tells if the alias link is in the folder, or if another file has its name. */
    private async aliasState(folder: string): Promise<Pick<CliInstallState, 'alias' | 'aliasConflict'>> {
        const name = await aliasName(this.options);
        if (!name) return {};
        const file = join(folder, name);
        const target = await linkTarget(file);
        if (target === this.options.launcher) return { alias: file };
        return (await exists(file)) ? { aliasConflict: file } : {};
    }

    /**
     * Adds the alias link in the folder. A link of an older app location gets the new target. Another file with the
     * name stays, and `state` tells about it.
     */
    private async linkAlias(folder: string): Promise<void> {
        const name = await aliasName(this.options);
        if (!name) return;
        const file = join(folder, name);
        const target = await linkTarget(file);
        if (target === this.options.launcher) return;
        if (await exists(file)) {
            if (!isLauncher(target)) return;
            await fs.unlink(file);
        }
        await fs.symlink(this.options.launcher, file);
    }

    /** Removes the links in the folder that go to this launcher, except the links with the names in `keep`. */
    private async removeLinks(folder: string, keep: string[] = []): Promise<void> {
        const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isSymbolicLink() || keep.includes(entry.name)) continue;
            const file = join(folder, entry.name);
            if ((await linkTarget(file)) === this.options.launcher) await fs.unlink(file).catch(() => undefined);
        }
    }

    /**
     * Makes the alias link agree with the settings, when the `shipwarden` link exists. It removes the link of an old
     * alias name. When the `shipwarden` link does not exist, it does nothing.
     */
    async sync(): Promise<CliInstallState> {
        const current = await this.state();
        if (!current.installed) return current;
        const folder = dirname(current.installed);
        const name = await aliasName(this.options);
        await this.removeLinks(folder, name ? [CLI_NAME, name] : [CLI_NAME]);
        await this.linkAlias(folder);
        return this.state();
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
                if (!isLauncher(target)) {
                    problems.push(`${file} exists, and it is not a link of ShipWarden.`);
                    continue;
                }
                await fs.unlink(file);
            }
            await fs.symlink(this.options.launcher, file);
            await this.linkAlias(folder);
            return this.state();
        }
        throw new Error(`ShipWarden did not add the link. ${problems.join(' ')}`);
    }

    /** Removes the links to this launcher, also the alias links. Other files stay. */
    async remove(): Promise<CliInstallState> {
        for (const folder of this.folders) await this.removeLinks(folder);
        return this.state();
    }
}
