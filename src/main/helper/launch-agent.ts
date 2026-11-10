import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/** The values of the launch agent plist of the background helper. */
export interface HelperPlistOptions {
    label: string;
    /** The Electron binary. It runs the helper script as Node (ELECTRON_RUN_AS_NODE). */
    execPath: string;
    helperScript: string;
    /** The app data folder. The helper reads the settings and the paired phones there. */
    userData: string;
    /** The app version. The phone shows it. */
    version: string;
    logPath: string;
    /** The login shell. The helper reads the PATH of this shell. */
    shell?: string;
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const str = (value: string) => `<string>${escapeXml(value)}</string>`;

/**
 * Returns the launch agent plist of the background helper.
 * launchd starts the helper at login and starts it again when it stops.
 * AbandonProcessGroup keeps the PTY host alive when launchd stops the helper. The helper can start the PTY host.
 */
export function helperPlist(options: HelperPlistOptions): string {
    const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
    if (options.shell) env.SHELL = options.shell;
    const envLines = Object.entries(env)
        .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        ${str(value)}`)
        .join('\n');
    const args = [options.execPath, options.helperScript, options.userData, options.version].map(arg => `        ${str(arg)}`).join('\n');
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
${envLines}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>AbandonProcessGroup</key>
    <true/>
    <key>StandardOutPath</key>
    ${str(options.logPath)}
    <key>StandardErrorPath</key>
    ${str(options.logPath)}
</dict>
</plist>
`;
}

/** Returns the path of the plist file of a launch agent in the user's LaunchAgents folder. */
export function launchAgentPath(label: string, home = homedir()): string {
    return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export interface LaunchctlResult {
    code: number;
    output: string;
}

export type RunLaunchctl = (args: string[]) => Promise<LaunchctlResult>;

const runLaunchctl: RunLaunchctl = args =>
    new Promise(resolve => {
        execFile('/bin/launchctl', args, { timeout: 15_000 }, (error, stdout, stderr) => {
            // For a program that ran, `code` is its exit code. Else it is a string, for example "ENOENT".
            const exit = (error as { code?: unknown } | null)?.code;
            const code = !error ? 0 : typeof exit === 'number' ? exit : 1;
            resolve({ code, output: `${stdout}${stderr}`.trim() });
        });
    });

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Installs and removes a launch agent in the GUI domain of the user.
 * Only an action of the user calls `install` or `remove`.
 */
export class LaunchAgent {
    private readonly domain: string;
    private readonly launchctl: RunLaunchctl;
    readonly plistPath: string;

    constructor(
        private readonly label: string,
        options: { uid?: number; home?: string; launchctl?: RunLaunchctl } = {}
    ) {
        this.domain = `gui/${options.uid ?? process.getuid?.() ?? 501}`;
        this.plistPath = launchAgentPath(label, options.home);
        this.launchctl = options.launchctl ?? runLaunchctl;
    }

    /** True when launchd has the agent. */
    async isLoaded(): Promise<boolean> {
        return (await this.launchctl(['print', `${this.domain}/${this.label}`])).code === 0;
    }

    /**
     * Writes the plist and loads the agent. When the plist is the same and the agent is loaded, it does nothing.
     * A changed plist (for example a new app version) loads the agent again.
     */
    async install(content: string): Promise<void> {
        const current = await fs.readFile(this.plistPath, 'utf8').catch(() => undefined);
        const loaded = await this.isLoaded();
        if (current === content && loaded) return;
        await fs.mkdir(dirname(this.plistPath), { recursive: true });
        await fs.writeFile(this.plistPath, content, { mode: 0o644 });
        if (loaded) await this.launchctl(['bootout', `${this.domain}/${this.label}`]);
        // After a bootout, launchd needs a moment. A bootstrap before that fails with an I/O error.
        let last: LaunchctlResult = { code: 1, output: '' };
        for (let attempt = 0; attempt < 5; attempt++) {
            last = await this.launchctl(['bootstrap', this.domain, this.plistPath]);
            if (last.code === 0) return;
            await delay(300);
        }
        throw new Error(`launchctl cannot load the background helper: ${last.output || `exit code ${last.code}`}`);
    }

    /** Stops the agent and removes the plist. */
    async remove(): Promise<void> {
        if (await this.isLoaded()) {
            await this.launchctl(['bootout', `${this.domain}/${this.label}`]);
        }
        await fs.rm(this.plistPath, { force: true });
    }

    /** Stops the agent process. launchd starts it again at once. */
    async restart(): Promise<void> {
        await this.launchctl(['kickstart', '-k', `${this.domain}/${this.label}`]);
    }
}
