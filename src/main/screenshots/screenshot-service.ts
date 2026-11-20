import { execFile } from 'child_process';
import {
    pageUrl,
    parseWait,
    screenshotCommentMarkdown,
    uploadFileName,
    viewportWidthOf,
    type CommentImage,
    type ScreenshotProgress,
    type ScreenshotSettings,
    type ScreenshotShot,
    type ScreenshotSide,
    type ScreenshotState
} from '@shared/screenshots';
import type { CaptureOptions } from '../browser/browser-views';
import type { SourceHost } from '../source-host';
import { mergeCapture, type ScreenshotStore } from './screenshot-store';
import type { UploadFile } from './screenshot-upload';

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, timeout: 10000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
    });
}

/** The branch of a worktree, or "HEAD" for a detached HEAD. */
function branchOf(worktree: string): Promise<string> {
    return git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
}

export interface ScreenshotServiceOptions {
    store: ScreenshotStore;
    /** Returns the path when it is a worktree of a project. Else it throws an error. */
    checkWorktree(worktree: unknown): Promise<string>;
    /** Returns the repository (main worktree) of a worktree. */
    repoOf(worktree: string): Promise<string | undefined>;
    /** Returns the screenshot settings of a repository. */
    settingsOf(repo: string): Promise<ScreenshotSettings | undefined>;
    /** Captures one page. The browser pane does it in a hidden window. */
    capture(url: string, options: CaptureOptions): Promise<Buffer>;
    /** Returns the review provider of a worktree. */
    hostFor(worktree: string): Promise<SourceHost>;
    /** Tells the page the progress of a capture. */
    onProgress(progress: ScreenshotProgress): void;
}

/**
 * Captures and keeps the screenshots of visual changes. ShipWarden never starts or stops a dev server. It opens the
 * preview URL and records which worktree the user said serves it:
 * - "branch": the worktree itself, with its branch and HEAD commit.
 * - "base": the main worktree of the repository, with its branch and HEAD commit.
 * The images are kept for the branch of the worktree.
 */
export class ScreenshotService {
    /** The worktrees that have a capture now. A second capture of the same worktree fails. */
    private readonly running = new Set<string>();

    constructor(private readonly options: ScreenshotServiceOptions) {}

    async state(worktree: unknown): Promise<ScreenshotState> {
        const { root, repo, branch } = await this.resolve(worktree);
        const baseBranch = await branchOf(repo);
        return { repo, branch, baseBranch, isMain: root === repo, set: await this.options.store.read(repo, branch) };
    }

    /** Captures all pages of the settings for one side, and keeps the images. A page that fails gets its error. */
    async capture(worktree: unknown, side: ScreenshotSide): Promise<ScreenshotState> {
        const { root, repo, branch } = await this.resolve(worktree);
        const settings = await this.options.settingsOf(repo);
        if (!settings) throw new Error('Add a preview URL and pages in Settings › Repositories first.');
        if (this.running.has(root)) throw new Error('A capture is running for this worktree. Wait until it is done.');
        this.running.add(root);
        try {
            const source = side === 'branch' ? root : repo;
            const sourceBranch = await branchOf(source);
            const sha = await git(source, ['rev-parse', 'HEAD']);
            const width = viewportWidthOf(settings);
            const wait = parseWait(settings.wait);
            const shots = new Map<string, ScreenshotShot>();
            const total = settings.pages.length;
            this.options.onProgress({ worktree: root, side, done: 0, total });
            for (const [index, page] of settings.pages.entries()) {
                const shot: ScreenshotShot = { branch: sourceBranch, sha, capturedAt: Date.now() };
                try {
                    const png = await this.options.capture(pageUrl(settings.previewUrl, page), { width, wait });
                    await this.options.store.writeImage(repo, branch, side, page, png);
                } catch (error) {
                    shot.error = error instanceof Error ? error.message : String(error);
                }
                shots.set(page, shot);
                this.options.onProgress({ worktree: root, side, done: index + 1, total });
            }
            const set = mergeCapture(await this.options.store.read(repo, branch), settings.pages, width, side, shots);
            await this.options.store.write(repo, branch, set);
            return { repo, branch, baseBranch: await branchOf(repo), isMain: root === repo, set };
        } finally {
            this.running.delete(root);
        }
    }

    /** Returns one image as a data URL, or null when there is no image. */
    async image(worktree: unknown, side: ScreenshotSide, page: string): Promise<string | null> {
        const { repo, branch } = await this.resolve(worktree);
        const png = await this.options.store.readImage(repo, branch, side, page);
        return png ? `data:image/png;base64,${png.toString('base64')}` : null;
    }

    async clear(worktree: unknown): Promise<void> {
        const { repo, branch } = await this.resolve(worktree);
        await this.options.store.clear(repo, branch);
    }

    /** Uploads the images and adds a comment with them to the pull request. Returns the address of the comment when known. */
    async post(worktree: unknown, number: number): Promise<string | undefined> {
        const { root, repo, branch } = await this.resolve(worktree);
        const set = await this.options.store.read(repo, branch);
        if (!set) throw new Error('There are no screenshots to add. Capture them first.');
        const host = await this.options.hostFor(root);
        if (!host.postScreenshots) throw new Error('This review provider cannot add images to a comment.');
        const files: UploadFile[] = [];
        const refs: Omit<CommentImage, 'url'>[] = [];
        for (const [index, page] of set.pages.entries()) {
            for (const side of ['base', 'branch'] as const) {
                const shot = page[side];
                if (!shot || shot.error) continue;
                const data = await this.options.store.readImage(repo, branch, side, page.path);
                if (!data) continue;
                files.push({ name: uploadFileName(side, page.path, index), data });
                refs.push({ page: page.path, side });
            }
        }
        if (files.length === 0) throw new Error('There are no screenshots to add. Capture them first.');
        return host.postScreenshots(root, number, files, urls =>
            screenshotCommentMarkdown(
                set,
                refs.map((ref, index) => ({ ...ref, url: urls[index] }))
            )
        );
    }

    private async resolve(worktree: unknown): Promise<{ root: string; repo: string; branch: string }> {
        const root = await this.options.checkWorktree(worktree);
        const repo = (await this.options.repoOf(root)) ?? root;
        return { root, repo, branch: await branchOf(root) };
    }
}
