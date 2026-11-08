import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ServerCommand {
    command: string;
    args: string[];
    /** Extra environment variables for the server process. */
    env?: Record<string, string>;
    /** The `initializationOptions` value of the `initialize` request. */
    initializationOptions?: unknown;
}

/** A command that installs a language server. ShipWarden uses it only when `tool` is in the PATH. */
export interface InstallOption {
    tool: string;
    command: string;
}

/** A language server that ShipWarden can start. */
export interface ServerDefinition {
    id: string;
    /** The name that the UI shows. */
    name: string;
    /** The LSP language IDs that the server supports. */
    languages: string[];
    /** Returns the command that starts the server for the worktree, or undefined when the server is not installed. */
    resolve(root: string): Promise<ServerCommand | undefined>;
    /** The commands that install the server, in order of preference. Empty when ShipWarden includes the server. */
    install: InstallOption[];
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
 * Returns the path of a file in the packaged app that the system must read from outside the asar archive.
 * The system cannot run a file from an asar archive.
 */
function unpacked(file: string): string {
    return file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/** Returns the folder and each of its parent folders, nearest first. */
function selfAndParents(folder: string): string[] {
    const folders: string[] = [];
    let current = path.resolve(folder);
    for (;;) {
        folders.push(current);
        const parent = path.dirname(current);
        if (parent === current) {
            return folders;
        }
        current = parent;
    }
}

/** Finds the first file that exists in `node_modules` of the folder or of a parent folder. */
async function findInNodeModules(root: string, relative: string, test: (file: string) => Promise<boolean>): Promise<string | undefined> {
    for (const folder of selfAndParents(root)) {
        const file = path.join(folder, 'node_modules', relative);
        if (await test(file)) {
            return file;
        }
    }
    return undefined;
}

async function isFile(file: string): Promise<boolean> {
    try {
        return (await fs.stat(file)).isFile();
    } catch {
        return false;
    }
}

/** Returns the major version of a package.json file, or undefined when the file has no valid version. */
async function majorVersion(packageJson: string): Promise<number | undefined> {
    try {
        const { version } = JSON.parse(await fs.readFile(packageJson, 'utf8')) as { version?: unknown };
        const major = typeof version === 'string' ? Number.parseInt(version, 10) : Number.NaN;
        return Number.isNaN(major) ? undefined : major;
    } catch {
        return undefined;
    }
}

/**
 * Finds the TypeScript of the worktree that is older than version 7, and that has `lib/tsserver.js`.
 * Returns the path of `tsserver.js`, or undefined.
 */
export async function findLegacyTsserver(root: string): Promise<string | undefined> {
    const packageJson = await findInNodeModules(root, path.join('typescript', 'package.json'), isFile);
    if (!packageJson) {
        return undefined;
    }
    const major = await majorVersion(packageJson);
    if (major === undefined || major >= 7) {
        return undefined;
    }
    const tsserver = path.join(path.dirname(packageJson), 'lib', 'tsserver.js');
    return await isFile(tsserver) ? tsserver : undefined;
}

/**
 * Returns the command that starts `typescript-language-server` with the TypeScript of the worktree.
 * Electron runs the server as a Node program (ELECTRON_RUN_AS_NODE=1).
 */
function legacyTypeScriptCommand(tsserver: string): ServerCommand | undefined {
    try {
        const packageJson = require.resolve('typescript-language-server/package.json');
        return {
            command: process.execPath,
            args: [unpacked(path.join(path.dirname(packageJson), 'lib', 'cli.mjs')), '--stdio'],
            env: { ELECTRON_RUN_AS_NODE: '1' },
            initializationOptions: {
                hostInfo: 'ShipWarden',
                tsserver: { path: tsserver }
            }
        };
    } catch {
        // The typescript-language-server package is not installed.
        return undefined;
    }
}

/**
 * Finds the TypeScript language server for the worktree.
 * 1. The worktree's own native TypeScript 7. It has a built-in language server (`tsc --lsp --stdio`).
 * 2. The worktree's own TypeScript, if it is older than version 7. TypeScript 7 rejects some old
 *    tsconfig options, for example `baseUrl` and `moduleResolution: node`. Then imports do not resolve.
 *    So ShipWarden starts `typescript-language-server` with the worktree's `tsserver.js`.
 * 3. The native TypeScript 7 that ShipWarden includes.
 * Steps 1 and 2 also look in the parent folders, because a monorepo can keep its packages there.
 */
async function resolveTypeScript(root: string): Promise<ServerCommand | undefined> {
    const args = ['--lsp', '--stdio'];
    const local = await findInNodeModules(root, path.join(nativeTypeScriptPackage(), 'lib', 'tsc'), isExecutable);
    if (local) {
        return { command: local, args };
    }
    const tsserver = await findLegacyTsserver(root);
    if (tsserver) {
        const legacy = legacyTypeScriptCommand(tsserver);
        if (legacy) {
            return legacy;
        }
    }
    try {
        const packageJson = require.resolve(`${nativeTypeScriptPackage()}/package.json`);
        const bundled = unpacked(path.join(path.dirname(packageJson), 'lib', 'tsc'));
        if (await isExecutable(bundled)) {
            return { command: bundled, args };
        }
    } catch {
        // The native package for this platform is not installed.
    }
    return undefined;
}

/** A command that can start a server. */
interface Candidate extends ServerCommand {
    /**
     * Arguments for a test run. The candidate is valid only when the test run exits with code 0.
     * Use it when the file can exist without the server, for example the rustup proxy of rust-analyzer.
     */
    check?: string[];
}

/** Returns true when the command exits with code 0 in 5 seconds. */
function runsWithoutError(command: string, args: string[]): Promise<boolean> {
    return new Promise(resolve => {
        execFile(command, args, { timeout: 5000 }, error => resolve(!error));
    });
}

/** Returns a resolver that uses the first command that is in the PATH and that passes its check. */
function fromPath(...candidates: Candidate[]): (root: string) => Promise<ServerCommand | undefined> {
    return async () => {
        for (const candidate of candidates) {
            const command = await which(candidate.command);
            if (command && (!candidate.check || await runsWithoutError(command, candidate.check))) {
                return { command, args: candidate.args };
            }
        }
        return undefined;
    };
}

export const SERVER_DEFINITIONS: readonly ServerDefinition[] = [
    {
        id: 'typescript',
        name: 'TypeScript',
        languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
        resolve: resolveTypeScript,
        install: []
    },
    {
        id: 'rust-analyzer',
        name: 'rust-analyzer',
        languages: ['rust'],
        // rustup and cargo install to ~/.cargo/bin. That folder is not always in the PATH of the app.
        // rustup adds a rust-analyzer proxy also when the component is not installed. The check finds that case.
        resolve: fromPath(
            { command: 'rust-analyzer', args: [], check: ['--version'] },
            { command: '~/.cargo/bin/rust-analyzer', args: [], check: ['--version'] }
        ),
        install: [
            { tool: 'rustup', command: 'rustup component add rust-analyzer' },
            { tool: 'brew', command: 'brew install rust-analyzer' }
        ]
    },
    {
        id: 'python',
        name: 'basedpyright',
        languages: ['python'],
        resolve: fromPath(
            { command: 'basedpyright-langserver', args: ['--stdio'] },
            { command: 'pyright-langserver', args: ['--stdio'] }
        ),
        install: [
            { tool: 'npm', command: 'npm install --global basedpyright' },
            { tool: 'pipx', command: 'pipx install basedpyright' },
            { tool: 'brew', command: 'brew install basedpyright' }
        ]
    },
    {
        id: 'gopls',
        name: 'gopls',
        languages: ['go'],
        // "go install" writes to ~/go/bin. That folder is not always in the PATH of the app.
        resolve: fromPath({ command: 'gopls', args: [] }, { command: '~/go/bin/gopls', args: [] }),
        install: [
            { tool: 'go', command: 'go install golang.org/x/tools/gopls@latest' },
            { tool: 'brew', command: 'brew install gopls' }
        ]
    }
];

/** Returns the first install command whose tool is in the PATH, or undefined when no tool is available. */
export async function installCommand(definition: ServerDefinition): Promise<string | undefined> {
    for (const option of definition.install) {
        if (await which(option.tool)) {
            return option.command;
        }
    }
    return undefined;
}

export function serverForLanguage(languageId: string): ServerDefinition | undefined {
    return SERVER_DEFINITIONS.find(definition => definition.languages.includes(languageId));
}
