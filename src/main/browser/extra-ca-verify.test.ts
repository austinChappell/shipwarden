import { describe, expect, it } from 'vitest';
import { verifyWithExtraCas } from './extra-ca-verify';

// Test certificates, valid from 2026-11-09 to 2126. The chain is: root CA → intermediate CA → example.test.
// The server certificate is for example.test, *.example.test and 127.0.0.1. "other" is a CA that signed nothing.
const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBSDCB8KADAgECAgkAlrzT1QHUlzIwCgYIKoZIzj0EAwIwFzEVMBMGA1UEAwwM
VGVzdCByb290IENBMCAXDTI2MTEwOTA3MDcwM1oYDzIxMjYxMDE2MDcwNzAzWjAX
MRUwEwYDVQQDDAxUZXN0IHJvb3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AAQpOFwfsplWUvg+QCUKccUSAR7bTu0XbMoNlHPHwRB/boHT13d1DqBZF+1QsVIT
u103gsH1l1abNzkWNUrnCzlUoyMwITAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB
/wQEAwIBBjAKBggqhkjOPQQDAgNHADBEAiEAzcd4BoxALoHpEq6CcEQU+U1PI8OO
FmFHigVMxxHle+MCHxUIaGJVbUkmIGCW7S10H/Xbuu7Gb5Fz+6gx8LsD7Ks=
-----END CERTIFICATE-----
`;
const OTHER_PEM = `-----BEGIN CERTIFICATE-----
MIIBSzCB8qADAgECAgkAkkGY6kyhljUwCgYIKoZIzj0EAwIwGDEWMBQGA1UEAwwN
VGVzdCBvdGhlciBDQTAgFw0yNjExMDkwNzA3MDNaGA8yMTI2MTAxNjA3MDcwM1ow
GDEWMBQGA1UEAwwNVGVzdCBvdGhlciBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABC+eooeEjuN9tBLGU1zZ8+uO/ds+iBg/KncDBL8yRz23O36R7bFazXPz/pia
eEF5xMRvSYcmxwl9r8hZF6k1otejIzAhMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0P
AQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCICw7DrZyjPmztCYV638kyBDl43tM
Gm2oP5rsrynp3yH9AiEA4EprMuhmURbMclWgDRTi+QYXNadZzgGXcZ2s3iDbCkA=
-----END CERTIFICATE-----
`;
const INTER_PEM = `-----BEGIN CERTIFICATE-----
MIIBUTCB+KADAgECAgkAtU772VGcVp8wCgYIKoZIzj0EAwIwFzEVMBMGA1UEAwwM
VGVzdCByb290IENBMCAXDTI2MTEwOTA3MDcwM1oYDzIxMjYxMDE2MDcwNzAzWjAf
MR0wGwYDVQQDDBRUZXN0IGludGVybWVkaWF0ZSBDQTBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABHDMFo7hdHlzrig/Pful4wOa9HFxtb4v/v9ivQ/NutkcuMdnKpkV
6C1CgQUZ/wxGamznju4dzAk4vZrmKcELoa6jIzAhMA8GA1UdEwEB/wQFMAMBAf8w
DgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIQCvUDtwlVjCUyPOMO7U
8crQpDgVJselBU56/w1AenphzgIgU/3+5RBQs1fCHRUkW5opKbwc5GiyTAnXgqBL
ZwGnvxg=
-----END CERTIFICATE-----
`;
const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBbDCCARGgAwIBAgIJAKZtmsSRQNKvMAoGCCqGSM49BAMCMB8xHTAbBgNVBAMM
FFRlc3QgaW50ZXJtZWRpYXRlIENBMCAXDTI2MTEwOTA3MDcwM1oYDzIxMjYxMDE2
MDcwNzAzWjAXMRUwEwYDVQQDDAxleGFtcGxlLnRlc3QwWTATBgcqhkjOPQIBBggq
hkjOPQMBBwNCAARzOdHVeehoLh+aAG0FpeYaV9OFKgqSXcsUUpkVPPQcfbKdslxT
4Nr7/FfzhWce2oUvfM03miBa2sc1bo2laWq6ozwwOjAJBgNVHRMEAjAAMC0GA1Ud
EQQmMCSCDGV4YW1wbGUudGVzdIIOKi5leGFtcGxlLnRlc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSQAwRgIhAMxM4GxRf8N1dsf9N1dhQbsPwx6KZ+k2Eb/qdQTnLHG1AiEA
0GfLeLY86s0kD0Uy0bJIeNbF9f7C1UDmuvpo0u+bmPc=
-----END CERTIFICATE-----
`;

const NOW = new Date('2030-01-01T00:00:00Z');

describe('verifyWithExtraCas', () => {
    it('accepts a chain that an extra CA signed', () => {
        expect(verifyWithExtraCas('example.test', [LEAF_PEM, INTER_PEM], [ROOT_PEM], NOW)).toBe(true);
    });

    it('accepts a chain that includes the extra CA itself', () => {
        expect(verifyWithExtraCas('example.test', [LEAF_PEM, INTER_PEM, ROOT_PEM], [ROOT_PEM], NOW)).toBe(true);
    });

    it('accepts an extra intermediate CA', () => {
        expect(verifyWithExtraCas('www.example.test', [LEAF_PEM], [INTER_PEM], NOW)).toBe(true);
    });

    it('accepts an IP address in the certificate', () => {
        expect(verifyWithExtraCas('127.0.0.1', [LEAF_PEM, INTER_PEM], [ROOT_PEM], NOW)).toBe(true);
    });

    it('refuses a chain that no extra CA signed', () => {
        expect(verifyWithExtraCas('example.test', [LEAF_PEM, INTER_PEM], [OTHER_PEM], NOW)).toBe(false);
    });

    it('refuses a chain with a missing intermediate certificate', () => {
        expect(verifyWithExtraCas('example.test', [LEAF_PEM], [ROOT_PEM], NOW)).toBe(false);
    });

    it('refuses a different host name', () => {
        expect(verifyWithExtraCas('example.com', [LEAF_PEM, INTER_PEM], [ROOT_PEM], NOW)).toBe(false);
        expect(verifyWithExtraCas('10.0.0.1', [LEAF_PEM, INTER_PEM], [ROOT_PEM], NOW)).toBe(false);
    });

    it('refuses a certificate that is not valid yet or not valid now', () => {
        expect(verifyWithExtraCas('example.test', [LEAF_PEM, INTER_PEM], [ROOT_PEM], new Date('2020-01-01T00:00:00Z'))).toBe(false);
        expect(verifyWithExtraCas('example.test', [LEAF_PEM, INTER_PEM], [ROOT_PEM], new Date('2200-01-01T00:00:00Z'))).toBe(false);
    });

    it('refuses a server certificate that is used as a CA', () => {
        expect(verifyWithExtraCas('example.test', [LEAF_PEM], [LEAF_PEM], NOW)).toBe(false);
    });

    it('refuses an empty chain, no extra CAs and text that is not a certificate', () => {
        expect(verifyWithExtraCas('example.test', [], [ROOT_PEM], NOW)).toBe(false);
        expect(verifyWithExtraCas('example.test', [LEAF_PEM, INTER_PEM], [], NOW)).toBe(false);
        expect(verifyWithExtraCas('example.test', ['not a certificate'], [ROOT_PEM], NOW)).toBe(false);
    });
});
