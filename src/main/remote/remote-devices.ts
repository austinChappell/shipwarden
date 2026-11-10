import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { PAIRING_TTL_MS, type RemoteDevice } from '@shared/remote';
import { JsonStore } from '../tasks/json-store';

interface StoredDevice extends RemoteDevice {
    /** The SHA-256 hash of the token, as hex. The token itself is only on the phone. */
    tokenHash: string;
}

interface PendingPairing {
    codeHash: Buffer;
    expiresAt: number;
    failures: number;
}

/** A pairing code stops after this number of wrong codes, so nobody can guess it. */
const MAX_PAIRING_FAILURES = 5;
/** The last-seen time is written at most at this interval. */
const SEEN_WRITE_INTERVAL_MS = 60_000;
const MAX_NAME_LENGTH = 60;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

function sameHash(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Removes control characters and extra spaces from a device name. */
export function cleanDeviceName(name: unknown): string {
    const clean =
        typeof name === 'string'
            ? name
                  .replace(/[\u0000-\u001f\u007f]/g, '')
                  .replace(/\s+/g, ' ')
                  .trim()
            : '';
    return clean.slice(0, MAX_NAME_LENGTH) || 'Phone';
}

/**
 * Keeps the paired phones and the pairing code. Only one pairing code is valid at a time. A code works one time.
 * Each phone gets its own random token. The file keeps only the hash of the token.
 */
export class RemoteDevices {
    private readonly store: JsonStore<{ devices: StoredDevice[] }>;
    private pending: PendingPairing | undefined;

    constructor(
        file: string,
        private readonly now: () => number = Date.now
    ) {
        this.store = new JsonStore(file, () => ({ devices: [] }));
    }

    async list(): Promise<RemoteDevice[]> {
        return (await this.store.get()).devices.map(({ tokenHash: _hash, ...device }) => device);
    }

    /** Makes a new pairing code. The old code stops. */
    startPairing(): { code: string; expiresAt: number } {
        const code = randomBytes(16).toString('base64url');
        const expiresAt = this.now() + PAIRING_TTL_MS;
        this.pending = { codeHash: sha256(code), expiresAt, failures: 0 };
        return { code, expiresAt };
    }

    cancelPairing(): void {
        this.pending = undefined;
    }

    /** Adds a phone when the code is the current pairing code. Returns the device and its token, else undefined. */
    async pair(code: unknown, name: unknown): Promise<{ device: RemoteDevice; token: string } | undefined> {
        const pending = this.pending;
        if (!pending || typeof code !== 'string' || pending.expiresAt < this.now()) {
            return undefined;
        }
        if (!sameHash(sha256(code), pending.codeHash)) {
            pending.failures += 1;
            if (pending.failures >= MAX_PAIRING_FAILURES) this.pending = undefined;
            return undefined;
        }
        this.pending = undefined;
        const token = randomBytes(32).toString('base64url');
        const device: RemoteDevice = { id: randomUUID(), name: cleanDeviceName(name), pairedAt: this.now() };
        await this.store.update(value => ({ devices: [...value.devices, { ...device, tokenHash: sha256(token).toString('hex') }] }));
        return { device, token };
    }

    /** Returns the device of a token, else undefined. It also records the time. */
    async authenticate(token: string | undefined): Promise<RemoteDevice | undefined> {
        if (!token) return undefined;
        const hash = sha256(token);
        const stored = (await this.store.get()).devices.find(device => sameHash(Buffer.from(device.tokenHash, 'hex'), hash));
        if (!stored) return undefined;
        const now = this.now();
        if (!stored.lastSeenAt || now - stored.lastSeenAt > SEEN_WRITE_INTERVAL_MS) {
            await this.store.update(value => ({
                devices: value.devices.map(device => (device.id === stored.id ? { ...device, lastSeenAt: now } : device))
            }));
        }
        const { tokenHash: _hash, ...device } = stored;
        return device;
    }

    async remove(id: string): Promise<void> {
        await this.store.update(value => ({ devices: value.devices.filter(device => device.id !== id) }));
    }
}
