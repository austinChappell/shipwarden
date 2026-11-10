import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import * as tls from 'tls';
import { createGunzip } from 'zlib';
import type { LspInstallPlan, LspInstallState } from '@shared/lsp';
import { CERTIFICATE_HINT, networkErrorDetail } from '@shared/network';
import { managedPaths, which } from './servers';

const RUST_ANALYZER_RELEASE_API = 'https://api.github.com/repos/rust-lang/rust-analyzer/releases/latest';
const BASEDPYRIGHT_REGISTRY_URL = 'https://registry.npmjs.org/basedpyright/latest';
const GOPLS_PACKAGE = 'golang.org/x/tools/gopls@latest';
/** The subfolder of the managed folder for each server. It must agree with `managedPaths`. */
const SERVER_FOLDERS: Record<string, string> = { 'rust-analyzer': 'rust-analyzer', python: 'basedpyright', gopls: 'gopls' };
/** The time limit of "go install". The command compiles gopls, and that can take some minutes. */
const GO_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Returns the Rust target of the rust-analyzer release for the platform and CPU, or undefined.
 * The values of `platform` and `arch` are the values of `process.platform` and `process.arch`.
 */
export function rustAnalyzerTarget(platform: string, arch: string): string | undefined {
    const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
    if (!cpu) {
        return undefined;
    }
    if (platform === 'darwin') {
        return `${cpu}-apple-darwin`;
    }
    if (platform === 'linux') {
        return `${cpu}-unknown-linux-gnu`;
    }
    return undefined;
}

/** Returns the name of the gzip file of rust-analyzer in a GitHub release, for a Rust target. */
export function rustAnalyzerAssetName(target: string): string {
    return `rust-analyzer-${target}.gz`;
}

/** A file of a GitHub release, as the GitHub REST API sends it. */
export interface ReleaseAsset {
    name: string;
    size: number;
    browser_download_url: string;
    /** For example "sha256:<hex>". Old releases do not have it. */
    digest?: string | null;
}

/** A file to download, with the size and the SHA-256 that the file must have. */
export interface CheckedDownload {
    url: string;
    size: number;
    sha256: string;
}

/** Finds the file in the release. Throws an error when the file or its SHA-256 is missing. */
export function selectReleaseAsset(assets: readonly ReleaseAsset[], name: string): CheckedDownload {
    const asset = assets.find(item => item.name === name);
    if (!asset) {
        throw new Error(`The latest rust-analyzer release has no file "${name}".`);
    }
    const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '');
    if (!match) {
        throw new Error(`GitHub sent no SHA-256 for "${name}". ShipWarden did not install it.`);
    }
    return { url: asset.browser_download_url, size: asset.size, sha256: match[1].toLowerCase() };
}

/** An npm "integrity" value: the hash algorithm and the hash as base64. */
export interface Integrity {
    algorithm: 'sha512' | 'sha256';
    base64: string;
}

/** Reads an npm "integrity" value, for example "sha512-<base64>". Returns undefined for an unknown algorithm. */
export function parseIntegrity(value: string | undefined): Integrity | undefined {
    const match = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(value?.trim() ?? '');
    return match ? { algorithm: match[1] as Integrity['algorithm'], base64: match[2] } : undefined;
}

/**
 * Returns the environment variables that give a child process the trusted certificates of Settings › Network.
 * - NODE_EXTRA_CA_CERTS: Node programs. They add these certificates to their default certificates.
 * - SSL_CERT_FILE: programs that use OpenSSL, and Go on Linux. They use only this file, so it has all certificates.
 */
export function certificateEnv(extraBundle: string | undefined, fullBundle: string | undefined): Record<string, string> {
    const env: Record<string, string> = {};
    if (extraBundle) {
        env.NODE_EXTRA_CA_CERTS = extraBundle;
    }
    if (fullBundle) {
        env.SSL_CERT_FILE = fullBundle;
    }
    return env;
}

/** Returns the environment of "go install". GOBIN sets the folder of the gopls binary. */
export function goInstallEnv(base: NodeJS.ProcessEnv, goBin: string, certificates: Record<string, string>): NodeJS.ProcessEnv {
    return { ...base, ...certificates, GOBIN: goBin };
}

/** Returns the last lines of a text that are not empty. */
export function lastLines(text: string, count: number): string {
    return text
        .split('\n')
        .map(line => line.trimEnd())
        .filter(Boolean)
        .slice(-count)
        .join('\n');
}

/** Adds the certificate hint to the output of a command when the output shows a certificate error. */
export function withCertificateHint(output: string): string {
    return /x509|certificate/i.test(output) ? `${output}\n${CERTIFICATE_HINT}` : output;
}

/** The dependencies of the installer. The tests can replace them. */
export interface InstallerOptions {
    /** The folder that receives the servers, for example "<userData>/language-servers". */
    folder: string;
    /** Resolves when the trusted certificates of Settings › Network apply to this process. */
    ready: Promise<void>;
    /** Returns the PEM bundle of the extra certificates of Settings › Network, or undefined when there are none. */
    extraCertificateBundle(): string | undefined;
    /** Sends the install state to the UI. */
    onState(state: LspInstallState): void;
    platform?: string;
    arch?: string;
}

/**
 * Installs language servers into a folder of the app. It never installs a server without a request from the user.
 * - rust-analyzer: the binary of the latest GitHub release. The installer checks its size and SHA-256.
 * - basedpyright: the npm package. The installer checks its integrity value. Electron runs it, so Node is not necessary.
 * - gopls: "go install" with GOBIN in the folder. Go must be in the PATH.
 * Downloads use the trusted certificates of this process. Child processes get them in environment variables.
 */
export class ServerInstaller {
    private readonly running = new Map<string, Promise<void>>();
    private readonly platform: string;
    private readonly arch: string;

    constructor(private readonly options: InstallerOptions) {
        this.platform = options.platform ?? process.platform;
        this.arch = options.arch ?? process.arch;
    }

    /** Returns what the install of the server does, or the reason that ShipWarden cannot install it. */
    async plan(serverId: string): Promise<{ install?: LspInstallPlan; unavailable?: string }> {
        const paths = managedPaths(this.options.folder);
        switch (serverId) {
            case 'rust-analyzer': {
                const target = rustAnalyzerTarget(this.platform, this.arch);
                if (!target) {
                    return { unavailable: `rust-analyzer has no release for ${this.platform} ${this.arch}.` };
                }
                return {
                    install: {
                        description: `ShipWarden downloads ${rustAnalyzerAssetName(target)} from the latest rust-analyzer release on GitHub.`,
                        source: `https://github.com/rust-lang/rust-analyzer/releases/latest/download/${rustAnalyzerAssetName(target)}`,
                        folder: path.dirname(paths.rustAnalyzer)
                    }
                };
            }
            case 'python':
                return {
                    install: {
                        description: 'ShipWarden downloads the latest basedpyright package from the npm registry.',
                        source: BASEDPYRIGHT_REGISTRY_URL,
                        folder: path.dirname(paths.basedpyrightPackage)
                    }
                };
            case 'gopls':
                if (!(await which('go'))) {
                    return { unavailable: 'Go is not in the PATH. Install Go from https://go.dev/dl, then restart ShipWarden.' };
                }
                return {
                    install: {
                        description: 'ShipWarden runs "go install". Go downloads the gopls source and compiles it.',
                        source: `go install ${GOPLS_PACKAGE}`,
                        folder: paths.goBin
                    }
                };
            default:
                return { unavailable: 'ShipWarden cannot install this language server.' };
        }
    }

    /** Installs the server. A second request for the same server gets the install that runs now. */
    install(serverId: string): Promise<void> {
        const current = this.running.get(serverId);
        if (current) {
            return current;
        }
        const promise = this.installNow(serverId).finally(() => this.running.delete(serverId));
        this.running.set(serverId, promise);
        return promise;
    }

    private async installNow(serverId: string): Promise<void> {
        const plan = await this.plan(serverId);
        if (!plan.install) {
            const error = plan.unavailable ?? 'ShipWarden cannot install this language server.';
            this.options.onState({ serverId, status: 'error', error });
            throw new Error(error);
        }
        const report = (step: string, progress?: number) => this.options.onState({ serverId, status: 'running', step, progress });
        await fs.mkdir(this.options.folder, { recursive: true });
        const staging = path.join(this.options.folder, `.staging-${serverId}-${randomBytes(4).toString('hex')}`);
        await fs.mkdir(staging);
        try {
            report('Waiting for the network settings');
            await this.options.ready;
            switch (serverId) {
                case 'rust-analyzer':
                    await this.installRustAnalyzer(staging, report);
                    break;
                case 'python':
                    await this.installBasedpyright(staging, report);
                    break;
                case 'gopls':
                    await this.installGopls(staging, report);
                    break;
            }
            await this.replace(staging, path.join(this.options.folder, SERVER_FOLDERS[serverId]));
            this.options.onState({ serverId, status: 'done' });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.onState({ serverId, status: 'error', error: message });
            throw error;
        } finally {
            await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /** Moves the staging folder to the target folder. An old install in the target folder goes away. */
    private async replace(staging: string, target: string): Promise<void> {
        await fs.rm(target, { recursive: true, force: true });
        await fs.rename(staging, target);
    }

    private async installRustAnalyzer(staging: string, report: (step: string, progress?: number) => void): Promise<void> {
        const target = rustAnalyzerTarget(this.platform, this.arch)!;
        report('Reading the latest rust-analyzer release');
        const release = (await (await request(RUST_ANALYZER_RELEASE_API, 'application/vnd.github+json')).json()) as { assets?: ReleaseAsset[] };
        const asset = selectReleaseAsset(release.assets ?? [], rustAnalyzerAssetName(target));
        const gzip = path.join(staging, 'rust-analyzer.gz');
        const digest = await download(asset.url, gzip, 'sha256', asset.size, progress => report('Downloading rust-analyzer', progress));
        if (digest.toString('hex') !== asset.sha256) {
            throw new Error('The SHA-256 of the rust-analyzer download is not correct. ShipWarden did not install it.');
        }
        report('Unpacking rust-analyzer');
        const binary = path.join(staging, 'rust-analyzer');
        await pipeline(createReadStream(gzip), createGunzip(), createWriteStream(binary, { mode: 0o755 }));
        await fs.chmod(binary, 0o755);
        await fs.rm(gzip);
    }

    private async installBasedpyright(staging: string, report: (step: string, progress?: number) => void): Promise<void> {
        report('Reading the latest basedpyright version');
        const metadata = (await (await request(BASEDPYRIGHT_REGISTRY_URL, 'application/json')).json()) as {
            version?: string;
            dist?: { tarball?: string; integrity?: string };
        };
        const tarball = metadata.dist?.tarball;
        const integrity = parseIntegrity(metadata.dist?.integrity);
        if (!tarball || !integrity) {
            throw new Error('The npm registry sent no download URL or integrity value for basedpyright.');
        }
        const archive = path.join(staging, 'basedpyright.tgz');
        const digest = await download(tarball, archive, integrity.algorithm, undefined, progress =>
            report(`Downloading basedpyright ${metadata.version ?? ''}`.trim(), progress)
        );
        if (digest.toString('base64') !== integrity.base64) {
            throw new Error('The integrity value of the basedpyright download is not correct. ShipWarden did not install it.');
        }
        report('Unpacking basedpyright');
        // The npm package has all its files in the "package" folder.
        await run('tar', ['-xzf', archive, '-C', staging], { cwd: staging, env: process.env, timeout: 5 * 60 * 1000 });
        await fs.rm(archive);
        const script = path.join(staging, 'package', 'langserver.index.js');
        if (
            !(await fs.stat(script).then(
                stat => stat.isFile(),
                () => false
            ))
        ) {
            throw new Error('The basedpyright package has no langserver.index.js file.');
        }
    }

    private async installGopls(staging: string, report: (step: string, progress?: number) => void): Promise<void> {
        const go = await which('go');
        if (!go) {
            throw new Error('Go is not in the PATH. Install Go from https://go.dev/dl, then restart ShipWarden.');
        }
        report('Running go install. Go compiles gopls, and that can take some minutes');
        const env = goInstallEnv(process.env, path.join(staging, 'bin'), await this.childCertificateEnv());
        try {
            await run(go, ['install', GOPLS_PACKAGE], { cwd: staging, env, timeout: GO_INSTALL_TIMEOUT_MS });
        } catch (error) {
            throw new Error(`"go install" failed.\n${withCertificateHint(error instanceof Error ? error.message : String(error))}`);
        }
        if (
            !(await fs.stat(path.join(staging, 'bin', 'gopls')).then(
                stat => stat.isFile(),
                () => false
            ))
        ) {
            throw new Error('"go install" made no gopls file.');
        }
    }

    /** Writes a bundle with all trusted certificates for SSL_CERT_FILE, and returns the environment for a child process. */
    private async childCertificateEnv(): Promise<Record<string, string>> {
        const extra = this.options.extraCertificateBundle();
        if (!extra) {
            return {};
        }
        // The default certificates of this process include the extra certificates after Settings › Network applies.
        const fullBundle = path.join(this.options.folder, 'ca-bundle.pem');
        await fs.writeFile(fullBundle, `${tls.getCACertificates('default').join('\n')}\n`, { mode: 0o600 });
        return certificateEnv(extra, fullBundle);
    }
}

/** Sends a GET request. Throws an error with a clear text when the request fails. */
async function request(url: string, accept: string): Promise<Response> {
    const host = new URL(url).host;
    let response: Response;
    try {
        response = await fetch(url, { headers: { Accept: accept, 'User-Agent': 'ShipWarden' }, redirect: 'follow' });
    } catch (error) {
        throw new Error(`ShipWarden cannot connect to ${host}: ${networkErrorDetail(error)}`);
    }
    if (!response.ok) {
        throw new Error(`${host} returned ${response.status} for ${url}.`);
    }
    return response;
}

/**
 * Downloads the URL to the file and returns the hash of the file.
 * `size` is the expected size. Without it, the progress uses the Content-Length header.
 */
async function download(url: string, file: string, algorithm: string, size: number | undefined, onProgress: (progress?: number) => void): Promise<Buffer> {
    const response = await request(url, 'application/octet-stream');
    if (!response.body) {
        throw new Error(`${new URL(url).host} sent no file.`);
    }
    const total = size ?? (Number(response.headers.get('content-length')) || undefined);
    const hash = createHash(algorithm);
    const output = createWriteStream(file);
    let received = 0;
    let reported = -1;
    try {
        const reader = response.body.getReader();
        for (;;) {
            let chunk: Awaited<ReturnType<typeof reader.read>>;
            try {
                chunk = await reader.read();
            } catch (error) {
                throw new Error(`The download from ${new URL(url).host} stopped: ${networkErrorDetail(error)}`);
            }
            if (chunk.done) {
                break;
            }
            received += chunk.value.byteLength;
            if (size !== undefined && received > size) {
                await reader.cancel().catch(() => undefined);
                throw new Error('The download is larger than the release says.');
            }
            hash.update(chunk.value);
            if (!output.write(chunk.value)) {
                await new Promise<void>(resolve => output.once('drain', () => resolve()));
            }
            const progress = total ? Math.min(received / total, 1) : undefined;
            if (progress === undefined ? reported === -1 : progress - reported >= 0.02) {
                reported = progress ?? 0;
                onProgress(progress);
            }
        }
    } finally {
        await new Promise<void>(resolve => output.end(() => resolve()));
    }
    if (size !== undefined && received !== size) {
        throw new Error(`The download is incomplete: ${received} of ${size} bytes.`);
    }
    return hash.digest();
}

/** Runs a command. Rejects with the last lines of its output when it fails. */
function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (!error) {
                resolve();
                return;
            }
            const output = lastLines(`${stdout}\n${stderr}`, 15);
            const reason = error.killed ? 'The command took too long and ShipWarden stopped it.' : error.message.split('\n')[0];
            reject(new Error(output ? `${reason}\n${output}` : reason));
        });
    });
}
