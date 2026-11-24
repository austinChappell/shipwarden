import { randomBytes } from 'crypto';
import { promises as fs, readFileSync, rmSync } from 'fs';
import { dirname } from 'path';
import { CLI_PROTOCOL, type CliConfig } from '@shared/cli';
import { CliServer, type CliHandler } from './cli-server';

export interface CliHostOptions {
    socketPath: string;
    /** The file that tells the CLI the socket path and the token. */
    configPath: string;
    version: string;
    pid: number;
    handler: CliHandler;
}

/**
 * Starts the CLI server with a new token, and writes the config file for the CLI (mode 0600). The token changes at
 * each start, so an old token does not work after a restart.
 */
export class CliHost {
    private server: CliServer | undefined;
    private config: CliConfig | undefined;

    constructor(private readonly options: CliHostOptions) {}

    async start(): Promise<void> {
        if (this.server) return;
        const token = randomBytes(32).toString('hex');
        const server = new CliServer({ socketPath: this.options.socketPath, token, handler: this.options.handler });
        await server.start();
        this.server = server;
        const config: CliConfig = { protocol: CLI_PROTOCOL, socket: this.options.socketPath, token, pid: this.options.pid, version: this.options.version };
        this.config = config;
        await fs.mkdir(dirname(this.options.configPath), { recursive: true });
        // Write a new file, so an old file with other permissions does not keep them.
        await fs.rm(this.options.configPath, { force: true });
        await fs.writeFile(this.options.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    }

    /**
     * Stops the server. The config file goes away only when it is still the file of this app. The work is synchronous,
     * so it finishes before the app quits.
     */
    stop(): void {
        this.server?.stop();
        this.server = undefined;
        const token = this.config?.token;
        this.config = undefined;
        if (!token) return;
        try {
            const current = JSON.parse(readFileSync(this.options.configPath, 'utf8')) as Partial<CliConfig>;
            if (current.token === token) rmSync(this.options.configPath, { force: true });
        } catch {
            // The file is missing or not valid. Another app can own it.
        }
    }
}
