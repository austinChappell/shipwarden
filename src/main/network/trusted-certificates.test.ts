import { describe, expect, it } from 'vitest';
import { TrustedCertificates, type TrustDeps } from './trusted-certificates';

const CERT_A = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
const CERT_B = '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----';
const SYSTEM = '-----BEGIN CERTIFICATE-----\nSYS\n-----END CERTIFICATE-----';

function fake(files: Record<string, string>) {
    const calls: string[][] = [];
    const written: Record<string, string | null> = {};
    const deps: TrustDeps = {
        readFile: async file => {
            if (!(file in files)) throw new Error('ENOENT: no such file');
            return files[file];
        },
        writeFile: async (file, text) => {
            written[file] = text;
        },
        removeFile: async file => {
            written[file] = null;
        },
        defaultCertificates: () => ['DEFAULT'],
        systemCertificates: () => [SYSTEM],
        setDefaultCertificates: certs => void calls.push(certs)
    };
    return { deps, calls, written };
}

describe('TrustedCertificates', () => {
    it('adds the file and keychain certificates to the defaults and writes a bundle for plugins', async () => {
        const { deps, calls, written } = fake({ '/ca.pem': `subject=x\n${CERT_A}\n${CERT_B}` });
        const trust = new TrustedCertificates('/data/bundle.pem', deps);
        const status = await trust.apply({ caCertsFile: '/ca.pem', useSystemCertificates: true });
        expect(calls.at(-1)).toEqual(['DEFAULT', CERT_A, CERT_B, SYSTEM]);
        expect(status).toEqual({ file: { path: '/ca.pem', source: 'setting', count: 2 }, system: { count: 1 }, bundlePath: '/data/bundle.pem' });
        expect(written['/data/bundle.pem']).toBe(`${CERT_A}\n${CERT_B}\n${SYSTEM}\n`);
    });

    it('uses NODE_EXTRA_CA_CERTS of the shell when the setting is empty', async () => {
        const { deps } = fake({ '/shell.pem': CERT_A });
        const status = await new TrustedCertificates('/b.pem', deps).apply({ useSystemCertificates: false }, '/shell.pem');
        expect(status.file).toEqual({ path: '/shell.pem', source: 'shell', count: 1 });
    });

    it('goes back to the defaults and removes the bundle when nothing is extra', async () => {
        const { deps, calls, written } = fake({ '/ca.pem': CERT_A });
        const trust = new TrustedCertificates('/b.pem', deps);
        await trust.apply({ caCertsFile: '/ca.pem', useSystemCertificates: false });
        const status = await trust.apply({ useSystemCertificates: false });
        expect(calls.at(-1)).toEqual(['DEFAULT']);
        expect(written['/b.pem']).toBeNull();
        expect(status).toEqual({});
    });

    it('reports a missing file or a file without certificates', async () => {
        const { deps, calls } = fake({ '/empty.pem': 'not a certificate' });
        const trust = new TrustedCertificates('/b.pem', deps);
        expect((await trust.apply({ caCertsFile: '/missing.pem', useSystemCertificates: false })).file?.error).toMatch(/cannot read the file: ENOENT/);
        expect((await trust.apply({ caCertsFile: '/empty.pem', useSystemCertificates: false })).file?.error).toMatch(/no PEM certificates/);
        expect(calls.at(-1)).toEqual(['DEFAULT']);
    });

    it('keeps the extra certificates without the defaults for the in-app browser', async () => {
        const { deps } = fake({ '/ca.pem': `${CERT_A}\n${CERT_A}\n${CERT_B}` });
        const trust = new TrustedCertificates('/b.pem', deps);
        expect(trust.extraCertificates()).toEqual([]);
        await trust.apply({ caCertsFile: '/ca.pem', useSystemCertificates: true });
        expect(trust.extraCertificates()).toEqual([CERT_A, CERT_B, SYSTEM]);
        await trust.apply({ useSystemCertificates: false });
        expect(trust.extraCertificates()).toEqual([]);
    });
});
