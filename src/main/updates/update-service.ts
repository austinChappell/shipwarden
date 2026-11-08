import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { constants, createWriteStream, promises as fs } from 'fs';
import { dirname, join } from 'path';
import { networkErrorDetail } from '@shared/network';
import { compareVersions, parseManifest, RELEASE_REPO, UPDATE_MANIFEST, type UpdateInfo, type UpdateState } from '@shared/updates';

const API = 'https://api.github.com';

/** GitHub has no release yet: the repository exists, but it has no published release. */
class NoReleaseError extends Error {}
/** The first check waits, so the start of the app stays fast. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export interface UpdateServiceOptions {
    /** The version of the running app. */
    version: string;
    /** The path of the running app bundle (ShipWarden.app). Undefined in development: the app cannot install there. */
    bundlePath: string | undefined;
    /** A GitHub token. Without it, the API works only for a public repository. */
    token(): Promise<string | undefined>;
    /** A folder for the download. */
    tempFolder: string;
    onState(state: UpdateState): void;
    /** Quits the app, after the helper that installs the update starts. */
    quit(): void;
}

interface ReleaseAsset {
    name: string;
    size: number;
    url: string;
    browser_download_url: string;
}

interface Release {
    tag_name: string;
    name: string | null;
    body: string | null;
    html_url: string;
    published_at: string;
    draft: boolean;
    prerelease: boolean;
    assets: ReleaseAsset[];
}

function run(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`${file} failed: ${(stderr || error.message).trim()}`));
            else resolve(stdout);
        });
    });
}

/**
 * Finds new releases of ShipWarden on GitHub and installs them.
 * - The check reads the latest release and its manifest (the version and the SHA-256 of the zip).
 * - The install downloads the zip, checks its size and SHA-256, unpacks it next to the running app and checks the
 *   bundle. Then a helper script waits until the app quits, replaces the app bundle and opens the new app.
 * The terminals and agents continue to run in the PTY host during the update.
 */
export class UpdateService {
    private state: UpdateState;
    private timer: NodeJS.Timeout | undefined;
    private checking: Promise<UpdateState> | undefined;

    constructor(private readonly options: UpdateServiceOptions) {
        this.state = { status: 'idle', current: options.version, canInstall: !!options.bundlePath };
    }

    getState(): UpdateState {
        return this.state;
    }

    /** Checks now, and then every 4 hours. */
    start(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            void this.check().catch(() => undefined);
            this.timer = setInterval(() => void this.check().catch(() => undefined), CHECK_EVERY_MS);
        }, FIRST_CHECK_MS);
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private set(change: Partial<UpdateState>): void {
        this.state = { ...this.state, ...change };
        this.options.onState(this.state);
    }

    private async request(url: string, accept = 'application/vnd.github+json'): Promise<Response> {
        const token = await this.options.token();
        let response: Response;
        try {
            response = await fetch(url, {
                headers: {
                    'Accept': accept,
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'ShipWarden',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                redirect: 'follow'
            });
        } catch (error) {
            throw new Error(`ShipWarden cannot connect to GitHub: ${networkErrorDetail(error)}`);
        }
        if (!response.ok) {
            if (response.status === 404) {
                if (token) throw new NoReleaseError('GitHub has no release of ShipWarden yet.');
                throw new Error('GitHub has no release of ShipWarden, or the repository is private. Sign in with "gh auth login".');
            }
            throw new Error(`GitHub returned ${response.status} for ${url.replace(API, '')}.`);
        }
        return response;
    }

    /** Reads the latest release. The state is "available" when it is newer than the running app. */
    check(): Promise<UpdateState> {
        if (this.state.status === 'downloading' || this.state.status === 'installing') return Promise.resolve(this.state);
        this.checking ??= this.runCheck().finally(() => {
            this.checking = undefined;
        });
        return this.checking;
    }

    private async runCheck(): Promise<UpdateState> {
        this.set({ status: 'checking', error: undefined });
        try {
            const release = await (await this.request(`${API}/repos/${RELEASE_REPO.owner}/${RELEASE_REPO.name}/releases/latest`)).json() as Release;
            const version = release.tag_name.replace(/^v/, '');
            if (release.draft || release.prerelease || compareVersions(version, this.options.version) <= 0) {
                this.set({ status: 'none', update: undefined, checkedAt: Date.now() });
                return this.state;
            }
            const manifestAsset = release.assets.find(asset => asset.name === UPDATE_MANIFEST);
            if (!manifestAsset) throw new Error(`The release ${release.tag_name} has no ${UPDATE_MANIFEST}.`);
            const manifest = parseManifest(await (await this.request(manifestAsset.url, 'application/octet-stream')).json());
            if (!manifest || manifest.version !== version) throw new Error(`The ${UPDATE_MANIFEST} of the release ${release.tag_name} is not valid.`);
            const zip = release.assets.find(asset => asset.name === manifest.zip.name);
            if (!zip) throw new Error(`The release ${release.tag_name} has no ${manifest.zip.name}.`);
            const update: UpdateInfo = {
                version,
                notes: release.body ?? '',
                url: release.html_url,
                publishedAt: release.published_at,
                zip: { ...manifest.zip, apiUrl: zip.url, downloadUrl: zip.browser_download_url }
            };
            this.set({ status: 'available', update, checkedAt: Date.now() });
        } catch (error) {
            if (error instanceof NoReleaseError) {
                this.set({ status: 'none', update: undefined, checkedAt: Date.now() });
            } else {
                this.set({ status: 'error', error: error instanceof Error ? error.message : String(error), checkedAt: Date.now() });
            }
        }
        return this.state;
    }

    /** Downloads the update, checks it, and restarts the app into the new version. */
    async install(): Promise<void> {
        const update = this.state.update;
        const bundle = this.options.bundlePath;
        if (!update || this.state.status !== 'available') throw new Error('No update is ready to install. Check for updates first.');
        if (!bundle) throw new Error('ShipWarden runs from the source code. Only the installed app can install an update.');
        const parent = dirname(bundle);
        const staging = join(parent, '.ShipWarden-update');
        try {
            await fs.access(parent, constants.W_OK);
        } catch {
            throw new Error(`ShipWarden cannot write to ${parent}. Move ShipWarden.app to a folder that you can change, for example /Applications.`);
        }

        try {
            this.set({ status: 'downloading', progress: 0, error: undefined });
            await fs.mkdir(this.options.tempFolder, { recursive: true });
            const zipPath = join(this.options.tempFolder, update.zip.name);
            await this.download(update, zipPath);

            this.set({ status: 'installing', progress: 1 });
            await fs.rm(staging, { recursive: true, force: true });
            await fs.mkdir(staging, { recursive: true });
            await run('/usr/bin/ditto', ['-x', '-k', zipPath, staging]);
            const app = join(staging, 'ShipWarden.app');
            await fs.access(join(app, 'Contents', 'Info.plist'));
            const plistVersion = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents', 'Info.plist')])).trim();
            if (plistVersion !== update.version) {
                throw new Error(`The downloaded app has version ${plistVersion}, not ${update.version}.`);
            }
            await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
            await fs.rm(zipPath, { force: true });

            this.startInstaller(bundle, app, staging);
            this.options.quit();
        } catch (error) {
            await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
            this.set({ status: 'error', progress: undefined, error: error instanceof Error ? error.message : String(error) });
            throw error;
        }
    }

    private async download(update: UpdateInfo, path: string): Promise<void> {
        const token = await this.options.token();
        // With a token, the asset API also works for a private repository. Without it, the public download URL works.
        const response = token
            ? await this.request(update.zip.apiUrl, 'application/octet-stream')
            : await this.request(update.zip.downloadUrl, 'application/octet-stream');
        if (!response.body) throw new Error('GitHub sent no file.');
        const hash = createHash('sha256');
        const file = createWriteStream(path);
        let received = 0;
        let reported = 0;
        try {
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                received += value.byteLength;
                if (received > update.zip.size) throw new Error('The download is larger than the release says.');
                hash.update(value);
                if (!file.write(value)) await new Promise<void>(resolve => file.once('drain', () => resolve()));
                const progress = received / update.zip.size;
                if (progress - reported >= 0.02) {
                    reported = progress;
                    this.set({ progress });
                }
            }
        } finally {
            await new Promise<void>(resolve => file.end(() => resolve()));
        }
        if (received !== update.zip.size) throw new Error(`The download is incomplete: ${received} of ${update.zip.size} bytes.`);
        if (hash.digest('hex') !== update.zip.sha256) throw new Error('The checksum of the download is not correct. ShipWarden did not install it.');
    }

    /**
     * Starts a detached script that waits until this process ends, replaces the app bundle and opens the new app.
     * When the replacement fails, the script puts the old app back.
     */
    private startInstaller(bundle: string, newApp: string, staging: string): void {
        const script = INSTALLER_SCRIPT;
        const child = spawn('/bin/sh', ['-c', script], {
            detached: true,
            stdio: 'ignore',
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PID: String(process.pid), APP: bundle, NEW: newApp, STAGING: staging }
        });
        child.unref();
    }
}

/**
 * The helper that replaces the app. Environment: PID (the app process), APP (the installed bundle), NEW (the new
 * bundle), STAGING (the folder of the new bundle). It waits until the app ends, moves the old bundle away, moves the
 * new bundle in, and opens it. When the second move fails, it puts the old bundle back.
 */
export const INSTALLER_SCRIPT = [
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
    'BACKUP="$APP.old"',
    'rm -rf "$BACKUP"',
    'if mv "$APP" "$BACKUP"; then',
    '  if mv "$NEW" "$APP"; then rm -rf "$BACKUP"; else mv "$BACKUP" "$APP"; fi',
    'fi',
    'rm -rf "$STAGING"',
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
    'open "$APP"'
].join('\n');

/**
 * Returns the app bundle path of a packaged ShipWarden, from the path of its executable. In development, the
 * executable is in Electron.app of node_modules. The updater must never replace that, so the result is undefined.
 */
export function bundlePathOf(execPath: string, isPackaged: boolean): string | undefined {
    if (!isPackaged) return undefined;
    const match = /^(.*\/ShipWarden\.app)\/Contents\/MacOS\/ShipWarden$/.exec(execPath);
    return match?.[1];
}
