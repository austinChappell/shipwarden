import { describe, expect, it } from 'vitest';
import {
    certificateEnv,
    goInstallEnv,
    lastLines,
    parseIntegrity,
    rustAnalyzerAssetName,
    rustAnalyzerTarget,
    selectReleaseAsset,
    ServerInstaller,
    withCertificateHint,
    type ReleaseAsset
} from './server-install';

describe('rustAnalyzerTarget', () => {
    it('selects the Rust target of the Mac', () => {
        expect(rustAnalyzerTarget('darwin', 'arm64')).toBe('aarch64-apple-darwin');
        expect(rustAnalyzerTarget('darwin', 'x64')).toBe('x86_64-apple-darwin');
    });

    it('selects the Rust target of Linux', () => {
        expect(rustAnalyzerTarget('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
        expect(rustAnalyzerTarget('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    });

    it('returns undefined for a platform or CPU without a release', () => {
        expect(rustAnalyzerTarget('win32', 'x64')).toBeUndefined();
        expect(rustAnalyzerTarget('darwin', 'ia32')).toBeUndefined();
    });

    it('gives the name of the gzip file in the release', () => {
        expect(rustAnalyzerAssetName('aarch64-apple-darwin')).toBe('rust-analyzer-aarch64-apple-darwin.gz');
    });
});

describe('selectReleaseAsset', () => {
    const hex = 'e43a65008f8f4291320f33c0545dd577ad7623a7407b584a27155833d3722dfb';
    const assets: ReleaseAsset[] = [
        { name: 'rust-analyzer-darwin-arm64.vsix', size: 1, browser_download_url: 'https://example.com/vsix', digest: `sha256:${hex}` },
        { name: 'rust-analyzer-aarch64-apple-darwin.gz', size: 14335571, browser_download_url: 'https://example.com/gz', digest: `sha256:${hex.toUpperCase()}` }
    ];

    it('returns the URL, the size and the SHA-256 of the file', () => {
        expect(selectReleaseAsset(assets, 'rust-analyzer-aarch64-apple-darwin.gz')).toEqual({
            url: 'https://example.com/gz',
            size: 14335571,
            sha256: hex
        });
    });

    it('throws an error when the release has no such file', () => {
        expect(() => selectReleaseAsset(assets, 'rust-analyzer-x86_64-apple-darwin.gz')).toThrow(/no file/);
    });

    it('throws an error when the file has no SHA-256', () => {
        const noDigest = [{ ...assets[1], digest: null }];
        expect(() => selectReleaseAsset(noDigest, 'rust-analyzer-aarch64-apple-darwin.gz')).toThrow(/SHA-256/);
    });
});

describe('parseIntegrity', () => {
    it('reads a sha512 value of npm', () => {
        expect(parseIntegrity('sha512-9uld8+5tZC2Gxf8nIynyunK0N4xn01W1ApzLMXDAcuA8uJq2QSfldYn9gSbxn9MWR8wmHDo7GaEHLhlnLFHaJA==')).toEqual({
            algorithm: 'sha512',
            base64: '9uld8+5tZC2Gxf8nIynyunK0N4xn01W1ApzLMXDAcuA8uJq2QSfldYn9gSbxn9MWR8wmHDo7GaEHLhlnLFHaJA=='
        });
    });

    it('returns undefined for sha1, for an empty value and for text that is not valid', () => {
        expect(parseIntegrity('sha1-abc=')).toBeUndefined();
        expect(parseIntegrity(undefined)).toBeUndefined();
        expect(parseIntegrity('sha512-not base64!')).toBeUndefined();
    });
});

describe('certificate environment', () => {
    it('is empty when Settings › Network has no extra certificates', () => {
        expect(certificateEnv(undefined, undefined)).toEqual({});
    });

    it('gives Node the extra bundle and OpenSSL the full bundle', () => {
        expect(certificateEnv('/data/trusted-ca.pem', '/data/language-servers/ca-bundle.pem')).toEqual({
            NODE_EXTRA_CA_CERTS: '/data/trusted-ca.pem',
            SSL_CERT_FILE: '/data/language-servers/ca-bundle.pem'
        });
    });

    it('sets GOBIN and the certificates for "go install", and keeps the other variables', () => {
        const env = goInstallEnv({ PATH: '/usr/bin', GOBIN: '/old' }, '/data/gopls/bin', { SSL_CERT_FILE: '/ca.pem' });
        expect(env).toEqual({ PATH: '/usr/bin', GOBIN: '/data/gopls/bin', SSL_CERT_FILE: '/ca.pem' });
    });
});

describe('command output', () => {
    it('keeps the last lines that are not empty', () => {
        expect(lastLines('a\n\nb\nc  \n\n', 2)).toBe('b\nc');
    });

    it('adds the certificate hint only for a certificate error', () => {
        expect(withCertificateHint('tls: failed to verify certificate: x509: certificate signed by unknown authority')).toContain('Settings › Network');
        expect(withCertificateHint('no such host')).toBe('no such host');
    });
});

describe('ServerInstaller.plan', () => {
    const installer = (platform: string, arch: string) =>
        new ServerInstaller({
            folder: '/data/language-servers',
            ready: Promise.resolve(),
            extraCertificateBundle: () => undefined,
            onState: () => undefined,
            platform,
            arch
        });

    it('downloads the rust-analyzer binary for the CPU of the Mac', async () => {
        const plan = await installer('darwin', 'arm64').plan('rust-analyzer');
        expect(plan.install?.source).toBe('https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-aarch64-apple-darwin.gz');
        expect(plan.install?.folder).toBe('/data/language-servers/rust-analyzer');
    });

    it('cannot install rust-analyzer on a platform without a release', async () => {
        const plan = await installer('win32', 'x64').plan('rust-analyzer');
        expect(plan.install).toBeUndefined();
        expect(plan.unavailable).toMatch(/no release/);
    });

    it('downloads basedpyright from the npm registry', async () => {
        const plan = await installer('darwin', 'arm64').plan('python');
        expect(plan.install?.source).toBe('https://registry.npmjs.org/basedpyright/latest');
        expect(plan.install?.folder).toBe('/data/language-servers/basedpyright');
    });

    it('cannot install an unknown server', async () => {
        expect((await installer('darwin', 'arm64').plan('typescript')).install).toBeUndefined();
    });
});
