/**
 * The entry point of the PTY host process.
 * It runs with Electron's Node runtime (ELECTRON_RUN_AS_NODE=1), detached from the app.
 * Arguments: <socket path> <build ID> [--detach].
 * On macOS, launchd starts it with --detach. That process starts the host as a detached process and exits.
 */
import { spawn } from 'child_process';
import { unlinkSync } from 'fs';
import { PTY_HOST_DETACH_ARG } from './protocol';
import { PtyHostServer } from './pty-host-server';

const args = process.argv.slice(2);
const [socketPath, buildId = 'unknown'] = args;

if (!socketPath) {
    console.error('[pty-host] The socket path is missing. Usage: pty-host <socket path> <build ID>');
    process.exit(2);
}

function log(message: string): void {
    console.log(`${new Date().toISOString()} [pty-host] ${message}`);
}

if (args.includes(PTY_HOST_DETACH_ARG)) {
    // The host gets the output files of this process (the log) and is not a process of the launchd job.
    const host = spawn(process.execPath, [process.argv[1], ...args.filter(arg => arg !== PTY_HOST_DETACH_ARG)], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env
    });
    host.once('spawn', () => {
        host.unref();
        process.exit(0);
    });
    host.once('error', error => {
        log(`The launcher cannot start the host: ${error.message}`);
        process.exit(1);
    });
} else {
    startHost();
}

function startHost(): void {
    const server = new PtyHostServer({
        socketPath,
        buildId,
        onIdle: reason => {
            log(`${reason} The host stops.`);
            exit(0);
        }
    });

    function exit(code: number): void {
        server.stop();
        try {
            unlinkSync(socketPath);
        } catch {
            // The socket file is already removed.
        }
        process.exit(code);
    }

    // When the user logs out, the system sends SIGTERM. Stop the sessions and remove the socket.
    process.on('SIGTERM', () => {
        log('The host got SIGTERM. The host stops.');
        exit(0);
    });
    process.on('SIGINT', () => {
        log('The host got SIGINT. The host stops.');
        exit(0);
    });
    // The host has no terminal. A write to a closed pipe must not stop it.
    process.on('SIGPIPE', () => undefined);
    process.on('uncaughtException', error => log(`Uncaught error: ${error.stack ?? error.message}`));

    server.start().then(
        () => log(`Listening on ${socketPath} (pid ${process.pid}, build ${buildId}).`),
        error => {
            log(`The host did not start: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    );
}
