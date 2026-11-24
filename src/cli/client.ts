import { promises as fs } from 'fs';
import { connect } from 'net';
import { CLI_PROTOCOL, parseCliConfig, type CliArgs, type CliCommand, type CliConfig, type CliResponse } from '@shared/cli';

/** An error of the CLI itself, before or without an answer of the app. */
export class ClientError extends Error {
    constructor(
        message: string,
        readonly exitCode: number
    ) {
        super(message);
    }
}

const NOT_RUNNING = 'ShipWarden is not running. Open ShipWarden, then try again.';

/** Reads the config file that the app writes at its start. */
export async function readConfig(path: string): Promise<CliConfig> {
    let text: string;
    try {
        text = await fs.readFile(path, 'utf8');
    } catch {
        throw new ClientError(`${NOT_RUNNING} (The file ${path} does not exist.)`, 4);
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        value = undefined;
    }
    const config = parseCliConfig(value);
    if (!config) throw new ClientError(`The file ${path} is not valid. Start ShipWarden again.`, 4);
    return config;
}

/**
 * Sends one request to the app and returns its answer. The connection stays open until the answer arrives, so a long
 * command (for example "agent wait") can take minutes. A close of the CLI (Ctrl-C) stops the command in the app.
 */
export function sendRequest(config: Pick<CliConfig, 'socket' | 'token'>, command: CliCommand, args: CliArgs, cwd: string): Promise<CliResponse> {
    return new Promise((resolve, reject) => {
        const socket = connect(config.socket);
        let buffer = '';
        let settled = false;
        const settle = (outcome: CliResponse | Error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (outcome instanceof Error) reject(outcome);
            else resolve(outcome);
        };
        socket.setEncoding('utf8');
        socket.once('connect', () => {
            socket.write(`${JSON.stringify({ protocol: CLI_PROTOCOL, token: config.token, command, args, cwd })}\n`);
        });
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            const end = buffer.indexOf('\n');
            if (end < 0) return;
            try {
                settle(JSON.parse(buffer.slice(0, end)) as CliResponse);
            } catch {
                settle(new ClientError('The answer of ShipWarden is not valid JSON.', 1));
            }
        });
        socket.once('close', () => settle(new ClientError('ShipWarden closed the connection without an answer.', 1)));
        socket.once('error', (error: NodeJS.ErrnoException) => {
            const missing = error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
            settle(new ClientError(missing ? NOT_RUNNING : `The connection to ShipWarden failed: ${error.message}`, missing ? 4 : 1));
        });
    });
}
