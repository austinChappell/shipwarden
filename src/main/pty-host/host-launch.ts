import { createHash } from 'crypto';
import { LaunchAgent, type RunLaunchctl, str } from '../helper/launch-agent';
import { PTY_HOST_DETACH_ARG } from './protocol';

/**
 * Why launchd starts the PTY host on macOS:
 *
 * "Force Quit" (Apple menu, ⌥⌘Esc or the Dock) does not only stop the app. macOS also sends SIGTERM to the processes
 * that the app started, also to a detached process in its own session. The PTY host stopped, and the agents in its
 * terminals got SIGTERM and stopped too.
 *
 * A process that launchd starts is not a process of the app. So launchd starts a short launcher, and the launcher
 * starts the host as a detached process and exits. The host and its sessions then get no signal from a force quit.
 * The host is not the main process of the job. So the host continues to run when the app unloads the job
 * (AbandonProcessGroup).
 */

/** Returns the launchd label of the job that starts the PTY host on a socket. Each socket has its own label. */
export function ptyHostLabel(socketPath: string): string {
    return `dev.shipwarden.pty-host.${createHash('sha256').update(socketPath).digest('hex').slice(0, 12)}`;
}

export interface PtyHostPlistOptions {
    label: string;
    /** The Electron binary. It runs the host script as Node (ELECTRON_RUN_AS_NODE). */
    execPath: string;
    hostScript: string;
    socketPath: string;
    buildId: string;
    /** The file that gets the output of the launcher and of the host. */
    logPath: string;
}

/**
 * Returns the plist of the job that starts the PTY host. launchd runs it one time, when the app loads it.
 * The job has no KeepAlive: the launcher exits after it starts the host.
 */
export function ptyHostPlist(options: PtyHostPlistOptions): string {
    const args = [options.execPath, options.hostScript, options.socketPath, options.buildId, PTY_HOST_DETACH_ARG].map(arg => `        ${str(arg)}`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    ${str(options.label)}
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>ELECTRON_RUN_AS_NODE</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>AbandonProcessGroup</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    ${str(options.logPath)}
    <key>StandardErrorPath</key>
    ${str(options.logPath)}
</dict>
</plist>
`;
}

export interface LaunchPtyHostOptions extends PtyHostPlistOptions {
    plistPath: string;
    uid?: number;
    launchctl?: RunLaunchctl;
}

/**
 * Loads the job that starts the PTY host. A job of an earlier start can still be loaded, so it always loads the job again.
 * Returns a function that unloads the job and removes the plist. Call it after the host listens on its socket.
 * Throws an error when launchctl cannot load the job.
 */
export async function launchPtyHost(options: LaunchPtyHostOptions): Promise<() => Promise<void>> {
    const job = new LaunchAgent(options.label, {
        uid: options.uid,
        plistPath: options.plistPath,
        name: 'the terminal host',
        launchctl: options.launchctl
    });
    await job.install(ptyHostPlist(options), { reload: true });
    return () => job.remove();
}
