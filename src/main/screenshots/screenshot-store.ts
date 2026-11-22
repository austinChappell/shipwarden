import { createHash } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { pageSlug, type ScreenshotPage, type ScreenshotSet, type ScreenshotShot, type ScreenshotSide } from '@shared/screenshots';

/** The name of the file with the data of a screenshot set. */
const MANIFEST = 'screenshots.json';

function hash(text: string): string {
    return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function slug(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'x'
    );
}

/** A safe folder name for a text: a short slug and a hash. Two texts with the same slug get different names. */
export function folderKey(text: string): string {
    return `${slug(text)}-${hash(text)}`;
}

/**
 * The folder of the screenshots of a branch: `<data>/screenshots/<repo key>/<branch key>`.
 * The repository key comes from the folder name and the full path of the main worktree.
 */
export function screenshotFolder(dataFolder: string, repo: string, branch: string): string {
    const name = repo.split('/').filter(Boolean).pop() ?? repo;
    return join(dataFolder, 'screenshots', `${slug(name)}-${hash(repo)}`, folderKey(branch));
}

/** The PNG file of one side of a page: `<side>-<page slug>-<hash of the path>.png`. */
export function screenshotFile(folder: string, side: ScreenshotSide, page: string): string {
    return join(folder, `${side}-${pageSlug(page)}-${hash(page)}.png`);
}

/** Keeps a page only when its value has the expected shape. */
function validShot(value: unknown): ScreenshotShot | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    if (typeof raw.branch !== 'string' || typeof raw.sha !== 'string' || typeof raw.capturedAt !== 'number') return undefined;
    return { branch: raw.branch, sha: raw.sha, capturedAt: raw.capturedAt, ...(typeof raw.error === 'string' ? { error: raw.error } : {}) };
}

/** Converts the stored data to a valid set. Returns null when the data is not valid. */
export function parseScreenshotSet(value: unknown): ScreenshotSet | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.viewportWidth !== 'number' || !Array.isArray(raw.pages)) return null;
    const pages: ScreenshotPage[] = [];
    for (const item of raw.pages) {
        const page = item as Record<string, unknown> | null;
        if (!page || typeof page.path !== 'string') continue;
        const branch = validShot(page.branch);
        const base = validShot(page.base);
        pages.push({ path: page.path, ...(branch ? { branch } : {}), ...(base ? { base } : {}) });
    }
    return { viewportWidth: raw.viewportWidth, pages };
}

/**
 * Merges a new capture of one side into a set. The pages of the settings decide the order. A page that is no longer in
 * the settings goes away. A new width removes the other side, because the images would not match.
 */
export function mergeCapture(
    current: ScreenshotSet | null,
    pages: string[],
    viewportWidth: number,
    side: ScreenshotSide,
    shots: Map<string, ScreenshotShot>
): ScreenshotSet {
    const other: ScreenshotSide = side === 'branch' ? 'base' : 'branch';
    const keepOther = current?.viewportWidth === viewportWidth;
    return {
        viewportWidth,
        pages: pages.map(path => {
            const old = current?.pages.find(page => page.path === path);
            const shot = shots.get(path);
            const otherShot = keepOther ? old?.[other] : undefined;
            return { path, ...(shot ? { [side]: shot } : {}), ...(otherShot ? { [other]: otherShot } : {}) };
        })
    };
}

/** Keeps the screenshot sets in the app data folder: one folder for each repository and branch. */
export class ScreenshotStore {
    constructor(private readonly dataFolder: string) {}

    folder(repo: string, branch: string): string {
        return screenshotFolder(this.dataFolder, repo, branch);
    }

    async read(repo: string, branch: string): Promise<ScreenshotSet | null> {
        try {
            return parseScreenshotSet(JSON.parse(await readFile(join(this.folder(repo, branch), MANIFEST), 'utf8')));
        } catch {
            return null;
        }
    }

    async write(repo: string, branch: string, set: ScreenshotSet): Promise<void> {
        const folder = this.folder(repo, branch);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, MANIFEST), `${JSON.stringify(set, null, 2)}\n`);
    }

    async writeImage(repo: string, branch: string, side: ScreenshotSide, page: string, png: Buffer): Promise<void> {
        const folder = this.folder(repo, branch);
        await mkdir(folder, { recursive: true });
        await writeFile(screenshotFile(folder, side, page), png);
    }

    /** Returns the PNG of one side of a page, or undefined when there is no image. */
    async readImage(repo: string, branch: string, side: ScreenshotSide, page: string): Promise<Buffer | undefined> {
        try {
            return await readFile(screenshotFile(this.folder(repo, branch), side, page));
        } catch {
            return undefined;
        }
    }

    /** Removes all screenshots of a branch. */
    async clear(repo: string, branch: string): Promise<void> {
        await rm(this.folder(repo, branch), { recursive: true, force: true });
    }
}
