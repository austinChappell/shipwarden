/*
 * The lock of the automation engine. Only one process runs the automations and the task queue at a time: the app while
 * it runs, else the background helper. The lock is a file in the app data folder.
 *
 * This file uses only Node built-ins and erasable TypeScript syntax, so the lock tests can run it in a child process.
 */
import { randomBytes } from 'crypto';
import { promises as fs, readFileSync, rmSync } from 'fs';
import { join } from 'path';

/** The process that can run the engine. The app goes first: the helper gives the lock to an app that asks for it. */
export type EngineOwner = 'app' | 'helper';

/** The content of the lock file. */
export interface LockRecord {
    owner: EngineOwner;
    pid: number;
    /** A new value for each acquire. A process that lost the lock sees a different token. */
    token: string;
    /** The time of the last heartbeat. */
    heartbeat: number;
}

/** The content of the handover file: a process with a higher priority asks for the lock. */
export interface HandoverRequest {
    owner: EngineOwner;
    pid: number;
    at: number;
}

/** A lock without a heartbeat for this time is stale, also when its process is alive (for example a hung process). */
export const LOCK_STALE_MS = 30_000;

/** The time between two heartbeats of the owner. It must be much shorter than `LOCK_STALE_MS`. */
export const LOCK_HEARTBEAT_MS = 5_000;

/** Returns the path of the lock file in the app data folder. */
export function engineLockPath(userData: string): string {
    return join(userData, 'automation-engine.lock');
}

/** The priority of each owner. A higher value can ask for the lock. */
const PRIORITY: Record<EngineOwner, number> = { app: 2, helper: 1 };

/** True when the process exists. A process of another user gives EPERM, and it exists too. */
export function processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function recordOf(value: unknown): LockRecord | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    if (raw.owner !== 'app' && raw.owner !== 'helper') return undefined;
    if (typeof raw.pid !== 'number' || typeof raw.token !== 'string' || typeof raw.heartbeat !== 'number') return undefined;
    return { owner: raw.owner, pid: raw.pid, token: raw.token, heartbeat: raw.heartbeat };
}

function requestOf(value: unknown): HandoverRequest | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    if (raw.owner !== 'app' && raw.owner !== 'helper') return undefined;
    if (typeof raw.pid !== 'number' || typeof raw.at !== 'number') return undefined;
    return { owner: raw.owner, pid: raw.pid, at: raw.at };
}

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

export interface EngineLockOptions {
    file: string;
    owner: EngineOwner;
    /** The process ID in the lock. The default is the ID of this process. */
    pid?: number;
    staleMs?: number;
    now?: () => number;
    isAlive?: (pid: number) => boolean;
}

/**
 * A lock file that one process holds at a time.
 * - `tryAcquire` makes the file with the "wx" flag, so only one process can make it.
 * - The owner writes a heartbeat at an interval. A lock whose process exited, or whose heartbeat is old, is stale.
 *   Another process can then take it. A crash of the owner thus frees the lock.
 * - A process with a higher priority writes a handover file. The owner sees it, stops its work, and releases the lock.
 */
export class EngineLock {
    readonly file: string;
    readonly owner: EngineOwner;
    readonly pid: number;
    private readonly staleMs: number;
    private readonly now: () => number;
    private readonly isAlive: (pid: number) => boolean;
    private token: string | undefined;

    constructor(options: EngineLockOptions) {
        this.file = options.file;
        this.owner = options.owner;
        this.pid = options.pid ?? process.pid;
        this.staleMs = options.staleMs ?? LOCK_STALE_MS;
        this.now = options.now ?? Date.now;
        this.isAlive = options.isAlive ?? processIsAlive;
    }

    /** The path of the handover file. */
    get handoverFile(): string {
        return `${this.file}.handover`;
    }

    /** True while this object holds the lock, as far as it knows. `heartbeat` checks the file. */
    held(): boolean {
        return this.token !== undefined;
    }

    /** Reads the lock file. Undefined when the file does not exist or is not valid. */
    async read(): Promise<LockRecord | undefined> {
        try {
            return recordOf(JSON.parse(await fs.readFile(this.file, 'utf8')));
        } catch {
            return undefined;
        }
    }

    /** True when the process of the record exited or its heartbeat is too old. */
    isStale(record: LockRecord): boolean {
        return !this.isAlive(record.pid) || this.now() - record.heartbeat > this.staleMs;
    }

    /** Tries to get the lock. Returns true when this object holds the lock after the call. */
    async tryAcquire(): Promise<boolean> {
        if (this.held()) return this.heartbeat();
        if (await this.create()) return true;
        const record = await this.read();
        if (record) {
            if (!this.isStale(record)) return false;
            if (!(await this.removeStale(record))) return false;
            return this.create();
        }
        // The file exists, but it is not valid. Another process can write it now. Take it only when it is old.
        if (!(await this.oldFile())) return false;
        await fs.rm(this.file, { force: true });
        return this.create();
    }

    /**
     * Writes a new heartbeat. Returns false, and forgets the lock, when the file does not have the token of this object
     * anymore. Another process then took the lock, for example after this process was stopped for a long time.
     */
    async heartbeat(): Promise<boolean> {
        const token = this.token;
        if (!token) return false;
        const record = await this.read();
        if (record?.token !== token) {
            this.token = undefined;
            return false;
        }
        await this.write({ ...record, heartbeat: this.now() });
        return true;
    }

    /** Releases the lock when this object holds it. */
    async release(): Promise<void> {
        const token = this.token;
        this.token = undefined;
        if (!token) return;
        const record = await this.read();
        if (record?.token === token) await fs.rm(this.file, { force: true });
    }

    /** Releases the lock without a wait, for the quit of the app. */
    releaseSync(): void {
        const token = this.token;
        this.token = undefined;
        if (!token) return;
        try {
            const record = recordOf(JSON.parse(readFileSync(this.file, 'utf8')));
            if (record?.token === token) rmSync(this.file, { force: true });
        } catch {
            // The file is missing or not valid. It is not the lock of this object.
        }
    }

    /** Asks the owner for the lock. Only an owner with a lower priority gives it. */
    async requestHandover(): Promise<void> {
        const request: HandoverRequest = { owner: this.owner, pid: this.pid, at: this.now() };
        await fs.writeFile(this.handoverFile, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    }

    /** Removes the handover file when this object wrote it. */
    async clearHandover(): Promise<void> {
        const request = await this.readHandover();
        if (request?.pid === this.pid && request.owner === this.owner) await fs.rm(this.handoverFile, { force: true });
    }

    /** True when a live process with a higher priority asks for the lock. */
    async handoverWanted(): Promise<boolean> {
        const request = await this.readHandover();
        if (!request || request.pid === this.pid) return false;
        if (PRIORITY[request.owner] <= PRIORITY[this.owner]) return false;
        return this.isAlive(request.pid);
    }

    private async readHandover(): Promise<HandoverRequest | undefined> {
        try {
            return requestOf(JSON.parse(await fs.readFile(this.handoverFile, 'utf8')));
        } catch {
            return undefined;
        }
    }

    /** Makes the lock file. Returns false when it exists. */
    private async create(): Promise<boolean> {
        const token = randomBytes(12).toString('hex');
        const record: LockRecord = { owner: this.owner, pid: this.pid, token, heartbeat: this.now() };
        try {
            await fs.writeFile(this.file, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (errorCode(error) === 'EEXIST') return false;
            throw error;
        }
        this.token = token;
        return true;
    }

    /** Writes the record to a temporary file, then renames it. A reader never sees half a file. */
    private async write(record: LockRecord): Promise<void> {
        const temp = `${this.file}.${this.pid}.${randomBytes(4).toString('hex')}.tmp`;
        await fs.writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        await fs.rename(temp, this.file);
    }

    /**
     * Removes a stale lock. Two processes can see the same stale lock. The rename moves the file one time only. When the
     * moved file is not the stale lock (another process took the lock in the meantime), the file goes back.
     */
    private async removeStale(stale: LockRecord): Promise<boolean> {
        const moved = `${this.file}.${this.pid}.${randomBytes(4).toString('hex')}.stale`;
        try {
            await fs.rename(this.file, moved);
        } catch (error) {
            // Another process removed it first. The create decides.
            return errorCode(error) === 'ENOENT';
        }
        try {
            let record: LockRecord | undefined;
            try {
                record = recordOf(JSON.parse(await fs.readFile(moved, 'utf8')));
            } catch {
                record = undefined;
            }
            if (record?.token === stale.token) return true;
            // It is the lock of another process. Put it back. A new lock that exists already stays.
            await fs.link(moved, this.file).catch(() => undefined);
            return false;
        } finally {
            await fs.rm(moved, { force: true });
        }
    }

    private async oldFile(): Promise<boolean> {
        try {
            const info = await fs.stat(this.file);
            return this.now() - info.mtimeMs > this.staleMs;
        } catch (error) {
            // The file went away. The next try can create it.
            return errorCode(error) === 'ENOENT';
        }
    }
}

export interface EngineLockKeeperOptions {
    lock: EngineLock;
    /** True when this process wants to run the engine now. */
    wanted(): boolean | Promise<boolean>;
    /** Starts the engine. The keeper calls it after it gets the lock. */
    onAcquire(): void | Promise<void>;
    /** Stops the engine. The keeper calls it before it releases the lock, and after it lost the lock. */
    onRelease(): void | Promise<void>;
    /** Called after `owns` changed: after the start of the engine, and after its stop. */
    onOwnedChanged?(owned: boolean): void;
    intervalMs?: number;
    log?: (message: string) => void;
}

/**
 * Keeps the lock for a process: it gets the lock when the process wants it, writes the heartbeats, and gives the lock
 * to a process with a higher priority. A check runs at each interval. Two checks never run at the same time.
 */
export class EngineLockKeeper {
    private readonly options: EngineLockKeeperOptions;
    private timer: ReturnType<typeof setInterval> | undefined;
    private checking: Promise<void> | undefined;
    private running = false;

    constructor(options: EngineLockKeeperOptions) {
        this.options = options;
    }

    /** True while this process runs the engine. */
    get owns(): boolean {
        return this.running;
    }

    start(): void {
        if (this.timer) return;
        void this.check();
        this.timer = setInterval(() => void this.check(), this.options.intervalMs ?? LOCK_HEARTBEAT_MS);
    }

    /** Stops the checks, stops the engine, and releases the lock. */
    async stop(): Promise<void> {
        clearInterval(this.timer);
        this.timer = undefined;
        await this.checking;
        await this.stopEngine();
        await this.options.lock.release();
    }

    /** Stops the checks and releases the lock without a wait, for the quit of the app. The engine stops with the app. */
    stopSync(): void {
        clearInterval(this.timer);
        this.timer = undefined;
        this.running = false;
        this.options.lock.releaseSync();
    }

    /** Runs one check now. A check that runs already finishes first. */
    check(): Promise<void> {
        this.checking ??= this.checkOnce().finally(() => {
            this.checking = undefined;
        });
        return this.checking;
    }

    private async checkOnce(): Promise<void> {
        const { lock } = this.options;
        try {
            const wanted = await this.options.wanted();
            if (lock.held()) {
                if (!wanted || (await lock.handoverWanted())) {
                    await this.stopEngine();
                    await lock.release();
                    this.options.log?.('Released the automation lock.');
                    return;
                }
                if (!(await lock.heartbeat())) {
                    this.options.log?.('Another process took the automation lock.');
                    await this.stopEngine();
                }
                return;
            }
            if (!wanted) return;
            if (await lock.tryAcquire()) {
                await lock.clearHandover();
                this.options.log?.('Got the automation lock.');
                try {
                    await this.options.onAcquire();
                } catch (error) {
                    // An engine that did not start must not keep the lock. The next check tries again.
                    await lock.release();
                    throw error;
                }
                // `owns` is true only after the start, so a reader of `owns` sees the data that the start loaded.
                this.running = true;
                this.options.onOwnedChanged?.(true);
                return;
            }
            if (lock.owner === 'app') await lock.requestHandover();
        } catch (error) {
            this.options.log?.(`The automation lock check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async stopEngine(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        try {
            await this.options.onRelease();
        } finally {
            this.options.onOwnedChanged?.(false);
        }
    }
}
