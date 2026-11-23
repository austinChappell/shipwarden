import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { hookAgentOf } from '@shared/agents';
import { commandProgram } from '@shared/settings';
import { which } from '../lsp/servers';

/** Returns the major version in the output of `opencode --version`, for example 2 for "opencode v2.2.6". */
export function majorVersionOf(output: string): number | undefined {
    const match = /(\d+)\.\d+/.exec(output);
    return match ? Number(match[1]) : undefined;
}

/**
 * Finds out if an opencode agent needs --standalone.
 * opencode 2 connects to a shared background service by default. The service does not read the environment of the
 * agent tab, so it ignores ShipWarden's plugin and MCP server (OPENCODE_CONFIG_CONTENT). With --standalone, opencode
 * starts its own server in the agent process, and the server reads the environment.
 * opencode 1 has no background service and no --standalone option.
 */
export class OpencodeVersions {
    /** The result for each program file. A new file (for example after an upgrade) has a different time. */
    private readonly cache = new Map<string, { mtimeMs: number; standalone: Promise<boolean> }>();

    constructor(
        private readonly shellReady: Promise<unknown>,
        private readonly version: (file: string) => Promise<string | undefined> = readVersion
    ) {}

    /** Returns true when the command starts opencode 2 or later. Returns false for other programs and on errors. */
    async needsStandalone(command: string | undefined): Promise<boolean> {
        if (!command || hookAgentOf(command) !== 'opencode') return false;
        await this.shellReady;
        const file = await which(commandProgram(command));
        if (!file) return false;
        const mtimeMs = await fs.stat(file).then(
            stat => stat.mtimeMs,
            () => 0
        );
        const cached = this.cache.get(file);
        if (cached && cached.mtimeMs === mtimeMs) return cached.standalone;
        const standalone = this.version(file).then(output => (majorVersionOf(output ?? '') ?? 0) >= 2);
        this.cache.set(file, { mtimeMs, standalone });
        return standalone;
    }
}

/** Runs `<file> --version`. Returns undefined when the program fails or takes more than 5 seconds. */
function readVersion(file: string): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile(file, ['--version'], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
    });
}
