import { execFile } from 'child_process';
import { X509Certificate } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/** The key and the certificate of the HTTPS server for the phone. */
export interface TlsIdentity {
    key: string;
    cert: string;
    /** The SHA-256 fingerprint of the certificate (DER), as lowercase hex without separators. */
    fingerprint: string;
}

/** Returns the SHA-256 fingerprint of a PEM certificate, as lowercase hex without separators. */
export function certificateFingerprint(certPem: string): string {
    return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/** macOS has LibreSSL in /usr/bin. Use it before an openssl in the PATH. */
function opensslPath(): string {
    return existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl';
}

/**
 * Reads the identity from the folder. When it does not exist, makes a new P-256 key and a self-signed certificate
 * with openssl. The phone pins the fingerprint, so the identity must stay the same. A new identity needs a new pairing.
 */
export async function ensureTlsIdentity(folder: string): Promise<TlsIdentity> {
    const keyFile = join(folder, 'remote-key.pem');
    const certFile = join(folder, 'remote-cert.pem');
    try {
        const [key, cert] = await Promise.all([fs.readFile(keyFile, 'utf8'), fs.readFile(certFile, 'utf8')]);
        return { key, cert, fingerprint: certificateFingerprint(cert) };
    } catch {
        // Make a new identity below.
    }
    await fs.mkdir(folder, { recursive: true });
    const openssl = opensslPath();
    await run(openssl, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyFile]);
    await fs.chmod(keyFile, 0o600);
    await run(openssl, ['req', '-new', '-x509', '-key', keyFile, '-out', certFile, '-days', '3650', '-subj', '/CN=ShipWarden', '-sha256']);
    const [key, cert] = await Promise.all([fs.readFile(keyFile, 'utf8'), fs.readFile(certFile, 'utf8')]);
    return { key, cert, fingerprint: certificateFingerprint(cert) };
}
