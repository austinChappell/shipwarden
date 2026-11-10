import type { PairingOffer, RemoteSettings, RemoteStatus } from '@shared/remote';
import type { HelperConnection } from './helper-link';
import { HELPER_PROTOCOL } from './protocol';

/** The phone server in the app process. `RemoteServer` has this shape. */
export interface LocalRemote {
    apply(settings: RemoteSettings): Promise<void>;
    status(): Promise<RemoteStatus>;
    startPairing(): PairingOffer;
    cancelPairing(): void;
    removeDevice(id: string): Promise<void>;
    agentsChanged(): void;
    terminalData(id: string, data: string, seq: number): void;
    terminalResized(id: string, cols: number, rows: number): void;
    terminalExited(id: string): void;
    stop(): Promise<void>;
}

export interface HelperAgent {
    /** Writes the launch agent plist and loads it. */
    install(): Promise<void>;
    /** Stops the launch agent and removes the plist. */
    remove(): Promise<void>;
    /** Stops the helper process. launchd starts it again. */
    restart(): Promise<void>;
}

export interface RemoteControlOptions {
    /** Makes a new phone server in the app. Each one reads the paired phones from the file again. */
    createLocal(): LocalRemote;
    /** Connects to the helper socket. Returns undefined when no helper listens. */
    connectHelper(): Promise<HelperConnection | undefined>;
    agent: HelperAgent;
    /** The build ID of the helper script of this app. */
    helperBuildId: string;
    onStatusChanged(): void;
    /** The time between two connection attempts while the helper does not answer. */
    retryMs?: number;
    /** The time that the app waits for a helper that launchd starts now. */
    startWaitMs?: number;
}

export type RemoteOwner = 'app' | 'helper';

/**
 * Selects the process that runs the phone server.
 * The helper runs it only when the setting is on and the app has a connection to the helper.
 * Else the app runs it, so the phone works while the app is open.
 */
export function remoteOwner(keepRunning: boolean, helperConnected: boolean): RemoteOwner {
    return keepRunning && helperConnected ? 'helper' : 'app';
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Sends the phone requests of the app to the process that runs the phone server: the background helper, or the app.
 * Only one process listens on the port. Before the helper gets the settings, the server of the app stops.
 */
export class RemoteControl {
    private settings: RemoteSettings | undefined;
    private local: LocalRemote | undefined;
    private helper: HelperConnection | undefined;
    private helperError: string | undefined;
    private retryTimer: ReturnType<typeof setInterval> | undefined;
    private connecting: Promise<boolean> | undefined;
    private restartedHelper = false;
    private queue: Promise<void> = Promise.resolve();
    private stopped = false;

    constructor(private readonly options: RemoteControlOptions) {}

    /** The process that runs the phone server now. */
    get owner(): RemoteOwner {
        return remoteOwner(this.settings?.keepRunning ?? false, !!this.helper);
    }

    /** Applies the settings. A change of `keepRunning` installs or removes the launch agent. */
    apply(settings: RemoteSettings): Promise<void> {
        return this.serial(async () => {
            const before = this.settings;
            this.settings = settings;
            if (!before || before.keepRunning !== settings.keepRunning) {
                if (settings.keepRunning) {
                    await this.startHelper();
                } else {
                    await this.stopHelper();
                }
            }
            await this.route();
        });
    }

    async status(): Promise<RemoteStatus> {
        if (this.helper && this.owner === 'helper') {
            return { ...await this.helper.status(), owner: 'helper' };
        }
        const status = this.local ? await this.local.status() : undefined;
        const helperError = this.settings?.keepRunning
            ? this.helperError ?? 'The background helper does not answer. ShipWarden runs the phone connection until the helper answers.'
            : undefined;
        return {
            enabled: this.settings?.enabled ?? false,
            running: false,
            port: this.settings?.port ?? 0,
            hosts: [],
            devices: [],
            connected: [],
            ...status,
            owner: 'app',
            ...(helperError ? { helperError } : {})
        };
    }

    async startPairing(): Promise<PairingOffer> {
        if (this.helper && this.owner === 'helper') return this.helper.startPairing();
        if (!this.local) throw new Error('Turn on phone connections first.');
        return this.local.startPairing();
    }

    async cancelPairing(): Promise<void> {
        if (this.helper && this.owner === 'helper') return this.helper.cancelPairing();
        this.local?.cancelPairing();
    }

    async removeDevice(id: string): Promise<void> {
        if (this.helper && this.owner === 'helper') return this.helper.removeDevice(id);
        if (!this.local) throw new Error('Turn on phone connections first.');
        return this.local.removeDevice(id);
    }

    // The helper gets the terminal events from the PTY host itself. Only the server of the app needs them here.
    agentsChanged(): void {
        this.local?.agentsChanged();
    }

    terminalData(id: string, data: string, seq: number): void {
        this.local?.terminalData(id, data, seq);
    }

    terminalExited(id: string): void {
        this.local?.terminalExited(id);
    }

    /** The PTY host of an older build has no terminal size. The page sends it, and both servers get it. */
    terminalResized(id: string, cols: number, rows: number): void {
        this.local?.terminalResized(id, cols, rows);
        this.helper?.terminalResized(id, cols, rows);
    }

    /** Stops the server of the app and closes the helper connection. The helper continues to run. */
    async stop(): Promise<void> {
        this.stopped = true;
        clearInterval(this.retryTimer);
        this.retryTimer = undefined;
        this.helper?.close();
        this.helper = undefined;
        await this.local?.stop();
        this.local = undefined;
    }

    private serial(work: () => Promise<void>): Promise<void> {
        const next = this.queue.then(work);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async startHelper(): Promise<void> {
        this.helperError = undefined;
        try {
            await this.options.agent.install();
        } catch (error) {
            this.helperError = message(error);
            return;
        }
        // launchd starts the helper now. Wait a moment for its socket.
        const deadline = Date.now() + (this.options.startWaitMs ?? 5000);
        while (!this.helper && !(await this.connect()) && Date.now() < deadline) {
            await delay(250);
        }
        this.watchHelper();
    }

    private async stopHelper(): Promise<void> {
        clearInterval(this.retryTimer);
        this.retryTimer = undefined;
        this.helper?.close();
        this.helper = undefined;
        this.helperError = undefined;
        try {
            await this.options.agent.remove();
        } catch (error) {
            console.warn(`[helper] The launch agent was not removed: ${message(error)}`);
        }
    }

    /** While the setting is on and the helper does not answer, tries to connect at an interval. */
    private watchHelper(): void {
        if (this.stopped || this.helper || this.retryTimer || !this.settings?.keepRunning) return;
        this.retryTimer = setInterval(() => {
            void this.connect().then(connected => {
                if (!connected) return;
                clearInterval(this.retryTimer);
                this.retryTimer = undefined;
                return this.serial(() => this.route());
            }).catch(error => console.warn(`[helper] ${message(error)}`));
        }, this.options.retryMs ?? 3000);
    }

    /** Connects to the helper one time. Returns true when the app has a connection to a helper of this build. */
    private connect(): Promise<boolean> {
        if (this.helper) return Promise.resolve(true);
        this.connecting ??= this.tryConnect().finally(() => {
            this.connecting = undefined;
        });
        return this.connecting;
    }

    private async tryConnect(): Promise<boolean> {
        const link = await this.options.connectHelper().catch(() => undefined);
        if (!link) return false;
        const hello = await link.hello().catch(() => undefined);
        if (!hello || hello.protocol !== HELPER_PROTOCOL) {
            link.close();
            this.helperError = 'The background helper runs a version of ShipWarden that this app cannot use.';
            await this.restartOnce();
            return false;
        }
        if (hello.buildId !== this.options.helperBuildId && !this.restartedHelper) {
            // The helper runs an older build, for example after an update. launchd starts the new build.
            link.close();
            await this.restartOnce();
            return false;
        }
        if (this.stopped || !this.settings?.keepRunning) {
            link.close();
            return false;
        }
        this.helper = link;
        this.helperError = undefined;
        link.onClose(() => {
            if (this.helper !== link) return;
            this.helper = undefined;
            // The helper stopped. The app runs the server until the helper answers again.
            void this.serial(() => this.route()).catch(error => console.warn(`[helper] ${message(error)}`));
            this.watchHelper();
        });
        return true;
    }

    private async restartOnce(): Promise<void> {
        if (this.restartedHelper) return;
        this.restartedHelper = true;
        await this.options.agent.restart().catch(error => console.warn(`[helper] The helper did not restart: ${message(error)}`));
    }

    /** Gives the server to the owner. The server of the app stops before the helper gets the settings. */
    private async route(): Promise<void> {
        const settings = this.settings;
        if (!settings || this.stopped) return;
        if (this.helper && this.owner === 'helper') {
            const local = this.local;
            this.local = undefined;
            await local?.stop();
            try {
                await this.helper.apply(settings);
            } catch (error) {
                // Close the connection. Its close handler gives the server back to the app.
                console.warn(`[helper] The helper did not take the settings: ${message(error)}`);
                this.helper?.close();
            }
        } else {
            this.local ??= this.options.createLocal();
            await this.local.apply(settings);
        }
        this.options.onStatusChanged();
    }
}
