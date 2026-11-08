/** The GitHub repository that publishes the releases of ShipWarden. */
export const RELEASE_REPO = { owner: 'austinChappell', name: 'shipwarden' } as const;

/** The release asset that describes the update: the version and the checksum of the zip. */
export const UPDATE_MANIFEST = 'shipwarden-update.json';

export interface UpdateManifest {
    version: string;
    zip: { name: string; sha256: string; size: number };
}

/** A release that is newer than the running app. */
export interface UpdateInfo {
    version: string;
    /** The release notes (Markdown). */
    notes: string;
    /** The release page on GitHub. */
    url: string;
    publishedAt: string;
    zip: { name: string; sha256: string; size: number; apiUrl: string; downloadUrl: string };
}

export type UpdateStatus = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'error';

export interface UpdateState {
    status: UpdateStatus;
    /** The version of the running app. */
    current: string;
    /** False in development: the app can check, but it cannot install. */
    canInstall: boolean;
    update?: UpdateInfo;
    /** The download progress, from 0 to 1. */
    progress?: number;
    error?: string;
    /** The time of the last check, in milliseconds. */
    checkedAt?: number;
}

/** Parses "1.2.3" or "v1.2.3". A pre-release part ("-beta.1") counts as lower than the release. */
export function parseVersion(value: string): { parts: [number, number, number]; pre: string } | undefined {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
    if (!match) return undefined;
    return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? '' };
}

/** Compares two versions: a negative number when `a` is older, 0 when equal, positive when `a` is newer. Invalid versions are the oldest. */
export function compareVersions(a: string, b: string): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return left ? 1 : right ? -1 : 0;
    for (let index = 0; index < 3; index += 1) {
        const diff = left.parts[index] - right.parts[index];
        if (diff !== 0) return diff;
    }
    if (left.pre === right.pre) return 0;
    if (!left.pre) return 1;
    if (!right.pre) return -1;
    return left.pre < right.pre ? -1 : 1;
}

/** Checks the manifest of a release. Returns undefined when it is not valid. */
export function parseManifest(value: unknown): UpdateManifest | undefined {
    const raw = value as Partial<UpdateManifest> | undefined;
    const zip = raw?.zip as Partial<UpdateManifest['zip']> | undefined;
    if (!raw || typeof raw.version !== 'string' || !parseVersion(raw.version)) return undefined;
    if (!zip || typeof zip.name !== 'string' || !/^[0-9a-f]{64}$/.test(String(zip.sha256)) || typeof zip.size !== 'number' || zip.size <= 0) return undefined;
    if (zip.name.includes('/') || !zip.name.endsWith('.zip')) return undefined;
    return { version: raw.version, zip: { name: zip.name, sha256: String(zip.sha256), size: zip.size } };
}

export interface ReleaseCommit {
    hash: string;
    subject: string;
}

/**
 * Makes the release notes from the commits since the last release: one line for each commit, newest first.
 * Release commits and merge commits are left out.
 */
export function releaseNotes(version: string, commits: ReleaseCommit[], previousTag?: string): string {
    const changes = commits
        .filter(commit => !/^Release v?\d/.test(commit.subject) && !/^Merge (branch|pull request)/.test(commit.subject))
        .map(commit => `- ${commit.subject} (${commit.hash.slice(0, 7)})`);
    const lines = [`## ShipWarden ${version}`, ''];
    lines.push(...(changes.length ? changes : ['- No changes in the code.']));
    if (previousTag) {
        lines.push('', `Changes since ${previousTag}.`);
    }
    return `${lines.join('\n')}\n`;
}
