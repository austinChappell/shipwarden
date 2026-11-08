import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PAIRING_TTL_MS } from '@shared/remote';
import { cleanDeviceName, RemoteDevices } from './remote-devices';

describe('RemoteDevices', () => {
    const folders: string[] = [];
    afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

    function make(now = () => 1000) {
        const folder = mkdtempSync(join(tmpdir(), 'shipwarden-devices-'));
        folders.push(folder);
        const file = join(folder, 'remote-devices.json');
        return { devices: new RemoteDevices(file, now), file };
    }

    it('pairs a phone one time with the code, and keeps only the hash of the token', async () => {
        const { devices, file } = make();
        const { code } = devices.startPairing();
        const result = await devices.pair(code, 'Austin’s iPhone');
        expect(result?.device.name).toBe('Austin’s iPhone');
        expect(await devices.pair(code, 'Second phone')).toBeUndefined();

        expect(readFileSync(file, 'utf8')).not.toContain(result!.token);
        expect((await devices.authenticate(result!.token))?.id).toBe(result!.device.id);
        expect(await devices.authenticate('wrong')).toBeUndefined();
        expect(await devices.authenticate(undefined)).toBeUndefined();
    });

    it('refuses an old code', async () => {
        let time = 1000;
        const { devices } = make(() => time);
        const { code } = devices.startPairing();
        time += PAIRING_TTL_MS + 1;
        expect(await devices.pair(code, 'Phone')).toBeUndefined();
    });

    it('stops the code after five wrong codes', async () => {
        const { devices } = make();
        const { code } = devices.startPairing();
        for (let i = 0; i < 5; i++) expect(await devices.pair(`wrong-${i}`, 'Phone')).toBeUndefined();
        expect(await devices.pair(code, 'Phone')).toBeUndefined();
    });

    it('stops the token of a removed phone', async () => {
        const { devices } = make();
        const result = await devices.pair(devices.startPairing().code, 'Phone');
        await devices.remove(result!.device.id);
        expect(await devices.authenticate(result!.token)).toBeUndefined();
        expect(await devices.list()).toEqual([]);
    });

    it('cleans device names', () => {
        expect(cleanDeviceName('  My\u0007  phone ')).toBe('My phone');
        expect(cleanDeviceName(42)).toBe('Phone');
        expect(cleanDeviceName('x'.repeat(100))).toHaveLength(60);
    });
});
