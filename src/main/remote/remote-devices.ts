import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { PAIRING_TTL_MS, type RemoteDevice, type RemoteDevicePermissions, type RemotePushRegistration } from '@shared/remote';
import { JsonStore } from '../tasks/json-store';

interface StoredDevice extends RemoteDevice {
    /** The SHA-256 hash of the token, as hex. The token itself is only on the phone. */
    tokenHash: string;
    /** The ticket and the push key of the push relay. The phone sent them. */
    push?: RemotePushRegistration;
}

/** A paired phone that can get push notifications. */
export interface PushTarget {
    deviceId: string;
    push: RemotePushRegistration;
}

/** The device without its secrets, for the settings page and the request handlers. */
function publicDevice({ tokenHash: _hash, push, ...device }: StoredDevice): RemoteDevice {
    return push ? { ...device, notifications: true } : device;
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
        return (await this.store.get()).devices.map(publicDevice);
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
        return publicDevice(stored);
    }

    /** Changes the permissions of a phone. Returns false when the phone is not paired. */
    async setPermissions(id: string, permissions: RemoteDevicePermissions): Promise<boolean> {
        let found = false;
        await this.store.update(value => ({
            devices: value.devices.map(device => {
                if (device.id !== id) return device;
                found = true;
                const { canStartAgents: _old, ...rest } = device;
                return permissions.canStartAgents ? { ...rest, canStartAgents: true } : rest;
            })
        }));
        return found;
    }

    /**
     * Saves the push registration of a phone, or removes it (undefined). Writes the file only for a change.
     * Returns false when the phone is not paired.
     */
    async setPush(id: string, push: RemotePushRegistration | undefined): Promise<boolean> {
        const stored = (await this.store.get()).devices.find(device => device.id === id);
        if (!stored) return false;
        const same = push ? stored.push?.relayUrl === push.relayUrl && stored.push.ticket === push.ticket && stored.push.key === push.key : !stored.push;
        if (same) return true;
        await this.store.update(value => ({
            devices: value.devices.map(device => {
                if (device.id !== id) return device;
                const { push: _old, ...rest } = device;
                return push ? { ...rest, push } : rest;
            })
        }));
        return true;
    }

    /** Removes a push registration that the relay does not accept anymore. A newer ticket of the phone stays. */
    async clearPush(id: string, ticket: string): Promise<void> {
        const stored = (await this.store.get()).devices.find(device => device.id === id);
        if (stored?.push?.ticket === ticket) await this.setPush(id, undefined);
    }

    /** The phones with a ticket of the relay at this address. */
    async pushTargets(relayUrl: string): Promise<PushTarget[]> {
        return (await this.store.get()).devices.flatMap(device => (device.push?.relayUrl === relayUrl ? [{ deviceId: device.id, push: device.push }] : []));
    }

    async remove(id: string): Promise<void> {
        await this.store.update(value => ({ devices: value.devices.filter(device => device.id !== id) }));
    }
}
