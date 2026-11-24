import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineLock, EngineLockKeeper, type LockRecord } from './engine-lock';

/**
 * The child process of the tests. Node runs the TypeScript file of the lock without a build (type stripping).
 * Arguments: <lock file> <owner>. It prints "acquired" or "busy". With the lock, it keeps it until a handover or a kill.
 */
const CHILD = `
const { EngineLock, EngineLockKeeper } = await import(${JSON.stringify(pathToFileURL(resolve(__dirname, 'engine-lock.ts')).href)});
const [file, owner] = process.argv.slice(2);
const lock = new EngineLock({ file, owner });
const keeper = new EngineLockKeeper({
    lock,
    wanted: () => true,
    onAcquire: () => console.log('acquired'),
    onRelease: () => { console.log('released'); setTimeout(() => process.exit(0), 50); },
    intervalMs: 100
});
await keeper.check();
if (!keeper.owns) { console.log('busy'); process.exit(0); }
keeper.start();
setInterval(() => undefined, 1000);
`;

let folder: string;
let file: string;
let script: string;
const children: ChildProcess[] = [];

/** Starts a child process with the lock. Resolves with its first line: "acquired" or "busy". */
function startChild(owner: 'app' | 'helper'): { child: ChildProcess; first: Promise<string>; lines: string[] } {
    const child = spawn(process.execPath, ['--no-warnings', script, file, owner], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const lines: string[] = [];
    let stderr = '';
    child.stderr?.on('data', chunk => {
        stderr += String(chunk);
    });
    const first = new Promise<string>((done, fail) => {
        child.stdout?.on('data', chunk => {
            lines.push(...String(chunk).split('\n').filter(Boolean));
            if (lines.length > 0) done(lines[0]);
        });
        child.on('exit', () => (lines.length > 0 ? done(lines[0]) : fail(new Error(`The child exited without output. ${stderr}`))));
    });
    return { child, first, lines };
}

function exited(child: ChildProcess): Promise<void> {
    return new Promise(done => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once('exit', () => done());
    });
}

async function until(test: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await test())) {
        if (Date.now() > end) throw new Error('The condition did not come true in time.');
        await new Promise(done => setTimeout(done, 25));
    }
}

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'engine-lock-'));
    file = join(folder, 'automation-engine.lock');
    script = join(folder, 'child.mjs');
    writeFileSync(script, CHILD);
});

afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    rmSync(folder, { recursive: true, force: true });
});

describe('EngineLock in one process', () => {
    it('gives the lock to one object and refuses a second one', async () => {
        const first = new EngineLock({ file, owner: 'app' });
        const second = new EngineLock({ file, owner: 'helper', pid: process.pid });
        expect(await first.tryAcquire()).toBe(true);
        expect(await second.tryAcquire()).toBe(false);
        await first.release();
        expect(await second.tryAcquire()).toBe(true);
    });

    it('takes a lock whose heartbeat is too old, also when its process is alive', async () => {
        let now = 1_000_000;
        const old: LockRecord = { owner: 'app', pid: process.pid, token: 'old', heartbeat: now };
        writeFileSync(file, JSON.stringify(old));
        const lock = new EngineLock({ file, owner: 'helper', now: () => now, staleMs: 30_000 });
        expect(await lock.tryAcquire()).toBe(false);
        now += 31_000;
        expect(await lock.tryAcquire()).toBe(true);
        expect((JSON.parse(readFileSync(file, 'utf8')) as LockRecord).owner).toBe('helper');
    });

    it('takes a lock whose process exited', async () => {
        writeFileSync(file, JSON.stringify({ owner: 'app', pid: 999_999, token: 'dead', heartbeat: Date.now() }));
        const lock = new EngineLock({ file, owner: 'helper', isAlive: pid => pid === process.pid });
        expect(await lock.tryAcquire()).toBe(true);
    });

    it('lets only one of two processes take the same stale lock', async () => {
        writeFileSync(file, JSON.stringify({ owner: 'app', pid: 999_999, token: 'dead', heartbeat: 0 }));
        const isAlive = (pid: number) => pid !== 999_999;
        const a = new EngineLock({ file, owner: 'helper', pid: 101, isAlive });
        const b = new EngineLock({ file, owner: 'helper', pid: 102, isAlive });
        const results = await Promise.all([a.tryAcquire(), b.tryAcquire()]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const record = JSON.parse(readFileSync(file, 'utf8')) as LockRecord;
        expect(record.pid).toBe(results[0] ? 101 : 102);
    });

    it('forgets the lock at the heartbeat when another process took it', async () => {
        const lock = new EngineLock({ file, owner: 'helper' });
        expect(await lock.tryAcquire()).toBe(true);
        writeFileSync(file, JSON.stringify({ owner: 'app', pid: process.pid, token: 'other', heartbeat: Date.now() }));
        expect(await lock.heartbeat()).toBe(false);
        expect(lock.held()).toBe(false);
        // The release does not remove the lock of the other process.
        await lock.release();
        expect((JSON.parse(readFileSync(file, 'utf8')) as LockRecord).token).toBe('other');
    });

    it('takes a damaged lock file only when it is old', async () => {
        writeFileSync(file, '{"owner":');
        let now = Date.now();
        const lock = new EngineLock({ file, owner: 'helper', now: () => now });
        expect(await lock.tryAcquire()).toBe(false);
        now += 60_000;
        expect(await lock.tryAcquire()).toBe(true);
    });

    it('accepts a handover request only from a live process with a higher priority', async () => {
        const helper = new EngineLock({ file, owner: 'helper', pid: 201, isAlive: () => true });
        const app = new EngineLock({ file, owner: 'app', pid: 202, isAlive: () => true });
        const otherHelper = new EngineLock({ file, owner: 'helper', pid: 203, isAlive: () => true });
        await otherHelper.requestHandover();
        expect(await helper.handoverWanted()).toBe(false);
        await app.requestHandover();
        expect(await helper.handoverWanted()).toBe(true);
        expect(await app.handoverWanted()).toBe(false);
        const deadApp = new EngineLock({ file, owner: 'helper', pid: 201, isAlive: () => false });
        expect(await deadApp.handoverWanted()).toBe(false);
        await app.clearHandover();
        expect(await helper.handoverWanted()).toBe(false);
    });
});

describe('EngineLockKeeper', () => {
    it('releases the lock when the engine does not start, and when the process does not want it anymore', async () => {
        let fail = true;
        let wanted = true;
        let stopped = 0;
        const keeper = new EngineLockKeeper({
            lock: new EngineLock({ file, owner: 'helper' }),
            wanted: () => wanted,
            onAcquire: () => {
                if (fail) throw new Error('The engine did not start.');
            },
            onRelease: () => {
                stopped += 1;
            }
        });
        await keeper.check();
        expect(keeper.owns).toBe(false);
        expect(await new EngineLock({ file, owner: 'helper', pid: 1 }).read()).toBeUndefined();
        fail = false;
        await keeper.check();
        expect(keeper.owns).toBe(true);
        wanted = false;
        await keeper.check();
        expect(keeper.owns).toBe(false);
        expect(stopped).toBe(1);
        expect(await new EngineLock({ file, owner: 'helper', pid: 1 }).read()).toBeUndefined();
    });
});

describe('EngineLock with two processes', () => {
    it('lets only one of two processes that start at the same time hold the lock', async () => {
        const a = startChild('helper');
        const b = startChild('helper');
        const results = await Promise.all([a.first, b.first]);
        expect(results.sort()).toEqual(['acquired', 'busy']);
    });

    it('frees the lock when the owner crashes', async () => {
        const holder = startChild('helper');
        expect(await holder.first).toBe('acquired');
        const lock = new EngineLock({ file, owner: 'helper' });
        expect(await lock.tryAcquire()).toBe(false);
        holder.child.kill('SIGKILL');
        await exited(holder.child);
        // The lock file stays after a crash, but its process is gone.
        expect(await lock.tryAcquire()).toBe(true);
    });

    it('gives the lock of the helper to the app at a handover', async () => {
        const helper = startChild('helper');
        expect(await helper.first).toBe('acquired');
        let started = 0;
        const keeper = new EngineLockKeeper({
            lock: new EngineLock({ file, owner: 'app' }),
            wanted: () => true,
            onAcquire: () => {
                started += 1;
            },
            onRelease: () => undefined
        });
        await keeper.check();
        expect(keeper.owns).toBe(false);
        await until(() => helper.lines.includes('released'));
        await until(async () => {
            await keeper.check();
            return keeper.owns;
        });
        expect(started).toBe(1);
        await keeper.stop();
        await exited(helper.child);
    });

    it('does not give the lock of the app to the helper', async () => {
        const app = startChild('app');
        expect(await app.first).toBe('acquired');
        const keeper = new EngineLockKeeper({
            lock: new EngineLock({ file, owner: 'helper' }),
            wanted: () => true,
            onAcquire: () => undefined,
            onRelease: () => undefined
        });
        await keeper.check();
        await new Promise(done => setTimeout(done, 300));
        await keeper.check();
        expect(keeper.owns).toBe(false);
        expect(app.lines).not.toContain('released');
    });
});
