import { describe, expect, it } from 'vitest';
import { networkErrorDetail, pemBlocks } from './network';

const CERT_A = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
const CERT_B = '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----';

describe('pemBlocks', () => {
    it('splits a bundle into certificates', () => {
        expect(pemBlocks(`subject=x\n${CERT_A}\n\n${CERT_B}\n`)).toEqual([CERT_A, CERT_B]);
        expect(pemBlocks('nothing here')).toEqual([]);
    });
});

describe('networkErrorDetail', () => {
    it('shows the cause and a hint for certificate errors', () => {
        const certError = Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
        expect(networkErrorDetail(certError)).toMatch(/^fetch failed \(SELF_SIGNED_CERT_IN_CHAIN\)\. .*Settings › Network/);
    });

    it('shows the cause without a hint for other errors', () => {
        const dnsError = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        expect(networkErrorDetail(dnsError)).toBe('fetch failed (ENOTFOUND)');
        expect(networkErrorDetail(new Error('offline'))).toBe('offline');
    });
});
