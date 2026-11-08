/**
 * The entry point of the PTY host process.
 * The app starts it with Electron's Node runtime (ELECTRON_RUN_AS_NODE=1), detached from the app.
 * Arguments: <socket path> <build ID>.
 */
import { unlinkSync } from 'fs';
import { PtyHostServer } from './pty-host-server';

const [socketPath, buildId = 'unknown'] = process.argv.slice(2);

if (!socketPath) {
    console.error('[pty-host] The socket path is missing. Usage: pty-host <socket path> <build ID>');
    process.exit(2);
}

function log(message: string): void {
    console.log(`${new Date().toISOString()} [pty-host] ${message}`);
}

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
process.on('SIGTERM', () => exit(0));
process.on('SIGINT', () => exit(0));
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
