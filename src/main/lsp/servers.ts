import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ServerCommand {
    command: string;
    args: string[];
}

/** A language server that ShipWarden can start. */
export interface ServerDefinition {
    id: string;
    /** The LSP language IDs that the server supports. */
    languages: string[];
    /** Returns the command that starts the server for the worktree, or undefined when the server is not installed. */
    resolve(root: string): Promise<ServerCommand | undefined>;
}

async function isExecutable(file: string): Promise<boolean> {
    try {
        await fs.access(file, fs.constants.X_OK);
        return (await fs.stat(file)).isFile();
    } catch {
        return false;
    }
}

/**
 * Finds a command in the PATH, like the `which` command.
 * A command with a slash is a path. It must be an executable file. A leading "~/" is the home folder.
 */
export async function which(command: string): Promise<string | undefined> {
    if (command.includes('/')) {
        const file = command.startsWith('~/') ? path.join(os.homedir(), command.slice(2)) : command;
        return path.isAbsolute(file) && await isExecutable(file) ? file : undefined;
    }
    for (const folder of (process.env.PATH ?? '').split(':').filter(Boolean)) {
        const candidate = path.join(folder, command);
        if (await isExecutable(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function nativeTypeScriptPackage(): string {
    return `@typescript/typescript-${process.platform}-${process.arch}`;
}

/**
 * Finds the native TypeScript 7 compiler. It has a built-in language server (`tsc --lsp --stdio`).
 * 1. The worktree's own TypeScript, if it is version 7 or later.
 * 2. The TypeScript that ShipWarden includes.
 */
async function resolveTypeScript(root: string): Promise<ServerCommand | undefined> {
    const args = ['--lsp', '--stdio'];
    const local = path.join(root, 'node_modules', nativeTypeScriptPackage(), 'lib', 'tsc');
    if (await isExecutable(local)) {
        return { command: local, args };
    }
    try {
        const packageJson = require.resolve(`${nativeTypeScriptPackage()}/package.json`);
        // In the packaged app, the binary is in app.asar.unpacked, because the system cannot run a file from an asar archive.
        const bundled = path.join(path.dirname(packageJson), 'lib', 'tsc').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
        if (await isExecutable(bundled)) {
            return { command: bundled, args };
        }
    } catch {
        // The native package for this platform is not installed.
    }
    return undefined;
}

/** Returns a resolver that uses the first command that is in the PATH. */
function fromPath(...candidates: ServerCommand[]): (root: string) => Promise<ServerCommand | undefined> {
    return async () => {
        for (const candidate of candidates) {
            const command = await which(candidate.command);
            if (command) {
                return { command, args: candidate.args };
            }
        }
        return undefined;
    };
}

export const SERVER_DEFINITIONS: readonly ServerDefinition[] = [
    {
        id: 'typescript',
        languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
        resolve: resolveTypeScript
    },
    {
        id: 'rust-analyzer',
        languages: ['rust'],
        resolve: fromPath({ command: 'rust-analyzer', args: [] })
    },
    {
        id: 'python',
        languages: ['python'],
        resolve: fromPath(
            { command: 'basedpyright-langserver', args: ['--stdio'] },
            { command: 'pyright-langserver', args: ['--stdio'] }
        )
    },
    {
        id: 'gopls',
        languages: ['go'],
        resolve: fromPath({ command: 'gopls', args: [] })
    }
];

export function serverForLanguage(languageId: string): ServerDefinition | undefined {
    return SERVER_DEFINITIONS.find(definition => definition.languages.includes(languageId));
}
