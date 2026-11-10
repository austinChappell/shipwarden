import { promises as fs } from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import type { NetworkSettings } from '@shared/settings';
import { pemBlocks } from '@shared/network';

/** The state of the trusted certificates, for Settings › Network. */
export interface TrustStatus {
    /** The extra CA file and where its path comes from: the setting, or NODE_EXTRA_CA_CERTS of the login shell. */
    file?: { path: string; source: 'setting' | 'shell'; count?: number; error?: string };
    /** The certificates of the macOS keychain, when the setting is on. */
    system?: { count?: number; error?: string };
    /** The PEM bundle with all extra certificates that the task plugins get as NODE_EXTRA_CA_CERTS. */
    bundlePath?: string;
}

/** Replaceable dependencies. The tests replace them. */
export interface TrustDeps {
    readFile(file: string): Promise<string>;
    writeFile(file: string, text: string): Promise<void>;
    removeFile(file: string): Promise<void>;
    defaultCertificates(): string[];
    systemCertificates(): string[];
    setDefaultCertificates(certs: string[]): void;
}

const nodeDeps: TrustDeps = {
    readFile: file => fs.readFile(file, 'utf8'),
    writeFile: async (file, text) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text, { mode: 0o600 });
    },
    removeFile: file => fs.rm(file, { force: true }),
    defaultCertificates: () => [...tls.getCACertificates('default')],
    systemCertificates: () => [...tls.getCACertificates('system')],
    setDefaultCertificates: certs => tls.setDefaultCACertificates(certs)
};

/**
 * Trusts extra CA certificates in the main process, for a network that inspects TLS traffic (for example a company VPN).
 * The certificates come from a PEM file and, when the setting is on, from the macOS keychain. They add to the default ones.
 * The task plugins are other processes. They get the same certificates as a bundle file in NODE_EXTRA_CA_CERTS.
 */
export class TrustedCertificates {
    private current: TrustStatus = {};
    /** The default certificates when the app started. A new apply starts from them, so removed certificates go away. */
    private defaults: string[] | undefined;
    /** The extra certificates of the last apply, without the defaults. */
    private extra: string[] = [];

    constructor(
        private readonly bundleFile: string,
        private readonly deps: TrustDeps = nodeDeps
    ) {}

    status(): TrustStatus {
        return this.current;
    }

    /** The PEM of the extra certificates (the file and the keychain) of the last apply. The in-app browser uses them. */
    extraCertificates(): readonly string[] {
        return this.extra;
    }

    /**
     * Applies the settings. `shellFile` is NODE_EXTRA_CA_CERTS of the login shell, for an empty file setting.
     * An error in the file or the keychain goes into the status. The other certificates still apply.
     */
    async apply(settings: NetworkSettings, shellFile?: string): Promise<TrustStatus> {
        this.defaults ??= this.deps.defaultCertificates();
        const status: TrustStatus = {};
        const extra: string[] = [];

        const filePath = settings.caCertsFile?.trim() || shellFile?.trim();
        if (filePath) {
            const source = settings.caCertsFile?.trim() ? ('setting' as const) : ('shell' as const);
            try {
                const certs = pemBlocks(await this.deps.readFile(filePath));
                status.file =
                    certs.length > 0
                        ? { path: filePath, source, count: certs.length }
                        : { path: filePath, source, error: 'The file contains no PEM certificates ("-----BEGIN CERTIFICATE-----").' };
                extra.push(...certs);
            } catch (error) {
                status.file = { path: filePath, source, error: `ShipWarden cannot read the file: ${error instanceof Error ? error.message : String(error)}` };
            }
        }

        if (settings.useSystemCertificates) {
            try {
                const certs = this.deps.systemCertificates();
                status.system = { count: certs.length };
                extra.push(...certs);
            } catch (error) {
                status.system = { error: error instanceof Error ? error.message : String(error) };
            }
        }

        this.deps.setDefaultCertificates([...new Set([...this.defaults, ...extra])]);
        if (extra.length > 0) {
            await this.deps.writeFile(this.bundleFile, `${[...new Set(extra)].join('\n')}\n`);
            status.bundlePath = this.bundleFile;
        } else {
            await this.deps.removeFile(this.bundleFile);
        }
        this.current = status;
        this.extra = [...new Set(extra)];
        return status;
    }
}
