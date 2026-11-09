import { X509Certificate } from 'crypto';
import { isIP } from 'net';

/**
 * Checks a server certificate chain against extra CA certificates (Settings › Network).
 * Chromium does not know the PEM file of the setting. On a network that inspects TLS traffic, Chromium then refuses
 * the certificates of the proxy. The browser session uses this check only after Chromium refuses a chain.
 *
 * `chain` is the PEM of the server certificate first, then the PEM of each issuer that the server sent.
 * `extraCas` is the PEM of each extra CA certificate.
 * Returns true when:
 * - the server certificate is for `hostname`,
 * - each certificate is valid at `now`,
 * - each certificate has a signature of the next certificate, and
 * - a certificate of the chain is an extra CA, or has a signature of an extra CA.
 */
export function verifyWithExtraCas(hostname: string, chain: readonly string[], extraCas: readonly string[], now: Date = new Date()): boolean {
    if (chain.length === 0 || extraCas.length === 0) return false;
    let certs: X509Certificate[];
    let cas: X509Certificate[];
    try {
        certs = chain.map(pem => new X509Certificate(pem));
        cas = extraCas.map(pem => new X509Certificate(pem)).filter(ca => ca.ca);
    } catch {
        return false;
    }
    if (cas.length === 0) return false;

    const leaf = certs[0];
    const host = hostname.replace(/^\[|\]$/g, '');
    const hostMatches = isIP(host) ? leaf.checkIP(host) !== undefined : leaf.checkHost(host) !== undefined;
    if (!hostMatches) return false;

    const time = now.getTime();
    const validAt = (cert: X509Certificate) => new Date(cert.validFrom).getTime() <= time && time <= new Date(cert.validTo).getTime();
    const signedBy = (cert: X509Certificate, issuer: X509Certificate) => {
        try {
            return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
        } catch {
            return false;
        }
    };

    for (let index = 0; index < certs.length; index++) {
        const cert = certs[index];
        if (!validAt(cert)) return false;
        // A certificate above the server certificate must be a CA.
        if (index > 0 && !cert.ca) return false;
        if (cas.some(ca => ca.fingerprint256 === cert.fingerprint256)) return true;
        const trustedIssuer = cas.find(ca => signedBy(cert, ca));
        if (trustedIssuer) return validAt(trustedIssuer);
        const next = certs[index + 1];
        if (!next || !signedBy(cert, next)) return false;
    }
    return false;
}
