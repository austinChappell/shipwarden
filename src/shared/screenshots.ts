/**
 * Screenshots of visual changes: the settings of a repository, the stored screenshot sets, and the PR comment.
 * The user runs the dev server. ShipWarden captures one side at a time: the branch, then the base.
 */

/** The screenshot settings of one repository (Settings › Repositories). */
export interface ScreenshotSettings {
    /** The address of the dev server, for example "http://localhost:3000". */
    previewUrl: string;
    /** The paths of the pages to capture, for example "/" and "/settings". */
    pages: string[];
    /** A wait before each capture: a number of milliseconds, or a CSS selector that must show. Empty means no wait. */
    wait?: string;
    /** The width of the page in CSS pixels. Without it, DEFAULT_VIEWPORT_WIDTH. */
    viewportWidth?: number;
}

export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const MIN_VIEWPORT_WIDTH = 320;
export const MAX_VIEWPORT_WIDTH = 3840;
/** The largest number of pages in the settings. */
export const MAX_PAGES = 20;
/** The longest wait in milliseconds. */
export const MAX_WAIT_MS = 60_000;
/** The longest time to wait for a CSS selector. */
export const SELECTOR_TIMEOUT_MS = 15_000;

/** The side of a screenshot: the branch of the worktree or the base (the main worktree). */
export type ScreenshotSide = 'branch' | 'base';

/** One captured image. */
export interface ScreenshotShot {
    /** The branch that the source worktree had at the capture. */
    branch: string;
    /** The commit (HEAD) of the source worktree at the capture. */
    sha: string;
    /** The time of the capture (ms). */
    capturedAt: number;
    /** The error of a capture that failed. A shot with an error has no image. */
    error?: string;
}

/** The two sides of one page. */
export interface ScreenshotPage {
    path: string;
    branch?: ScreenshotShot;
    base?: ScreenshotShot;
}

/** The screenshots of one branch of a repository. */
export interface ScreenshotSet {
    /** The page width of the captures in CSS pixels. */
    viewportWidth: number;
    pages: ScreenshotPage[];
}

/** What the Screenshots tab needs about a worktree. */
export interface ScreenshotState {
    /** The repository (main worktree) of the worktree. */
    repo: string;
    /** The branch of the worktree. */
    branch: string;
    /** The branch of the main worktree. The dev server runs there for the base capture. */
    baseBranch: string;
    /** True when the worktree is the main worktree. Then the base and the branch are the same folder. */
    isMain: boolean;
    set: ScreenshotSet | null;
}

/** The progress of a capture, for the events to the page. */
export interface ScreenshotProgress {
    worktree: string;
    side: ScreenshotSide;
    done: number;
    total: number;
}

/** A wait before a capture. */
export type ScreenshotWait = { kind: 'none' } | { kind: 'delay'; ms: number } | { kind: 'selector'; selector: string };

/** Reads the wait text: digits are milliseconds, other text is a CSS selector. */
export function parseWait(text: string | undefined): ScreenshotWait {
    const value = (text ?? '').trim();
    if (!value) return { kind: 'none' };
    if (/^\d+$/.test(value)) return { kind: 'delay', ms: Math.min(Number(value), MAX_WAIT_MS) };
    return { kind: 'selector', selector: value };
}

/** Splits the text of the pages field: one path on each line. Empty lines go away. The order stays. */
export function parsePages(text: string): string[] {
    const pages = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    return [...new Set(pages)];
}

/** True for an http or https address with a host. */
function isHttpUrl(text: string): boolean {
    try {
        const url = new URL(text);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.host;
    } catch {
        return false;
    }
}

/** The form values of the settings, as the user types them. */
export interface ScreenshotSettingsInput {
    previewUrl: string;
    /** One path on each line. */
    pages: string;
    wait: string;
    /** Empty means the default width. */
    viewportWidth: string;
}

/**
 * Checks the form values. Returns the errors, or the settings when there is no error.
 * An empty preview URL with no pages means "no screenshot settings" (`settings` is undefined, no errors).
 */
export function validateScreenshotSettings(input: ScreenshotSettingsInput): { settings?: ScreenshotSettings; errors: string[] } {
    const previewUrl = input.previewUrl.trim();
    const pages = parsePages(input.pages);
    const wait = input.wait.trim();
    const widthText = input.viewportWidth.trim();
    if (!previewUrl && pages.length === 0 && !wait && !widthText) return { errors: [] };
    const errors: string[] = [];
    if (!previewUrl) errors.push('Type the preview URL, for example http://localhost:3000.');
    else if (!isHttpUrl(previewUrl)) errors.push('The preview URL must start with http:// or https://.');
    if (pages.length === 0) errors.push('Type at least one page path, for example /.');
    const badPage = pages.find(page => !page.startsWith('/'));
    if (badPage) errors.push(`The page path "${badPage}" must start with "/".`);
    if (pages.length > MAX_PAGES) errors.push(`Type at most ${MAX_PAGES} pages.`);
    if (/^\d+$/.test(wait) && Number(wait) > MAX_WAIT_MS) errors.push(`The wait must be at most ${MAX_WAIT_MS} ms.`);
    let viewportWidth: number | undefined;
    if (widthText) {
        const width = Number(widthText);
        if (!/^\d+$/.test(widthText) || width < MIN_VIEWPORT_WIDTH || width > MAX_VIEWPORT_WIDTH) {
            errors.push(`The width must be a number from ${MIN_VIEWPORT_WIDTH} to ${MAX_VIEWPORT_WIDTH}.`);
        } else {
            viewportWidth = width;
        }
    }
    if (errors.length > 0) return { errors };
    return {
        errors,
        settings: {
            previewUrl: previewUrl.replace(/\/+$/, ''),
            pages,
            ...(wait ? { wait } : {}),
            ...(viewportWidth && viewportWidth !== DEFAULT_VIEWPORT_WIDTH ? { viewportWidth } : {})
        }
    };
}

/** Converts the settings to form values. */
export function screenshotSettingsInput(settings: ScreenshotSettings | undefined): ScreenshotSettingsInput {
    return {
        previewUrl: settings?.previewUrl ?? '',
        pages: settings?.pages.join('\n') ?? '',
        wait: settings?.wait ?? '',
        viewportWidth: settings?.viewportWidth ? String(settings.viewportWidth) : ''
    };
}

/** Converts stored settings to valid settings. Returns undefined when the value is not valid. */
export function normalizeScreenshotSettings(value: unknown): ScreenshotSettings | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const pages = Array.isArray(raw.pages) ? raw.pages.filter((page): page is string => typeof page === 'string') : [];
    const width = typeof raw.viewportWidth === 'number' ? String(raw.viewportWidth) : '';
    return validateScreenshotSettings({
        previewUrl: typeof raw.previewUrl === 'string' ? raw.previewUrl : '',
        pages: pages.join('\n'),
        wait: typeof raw.wait === 'string' ? raw.wait : '',
        viewportWidth: width
    }).settings;
}

/** Returns the address of a page: the preview URL and the path. */
export function pageUrl(previewUrl: string, page: string): string {
    return `${previewUrl.replace(/\/+$/, '')}${page.startsWith('/') ? page : `/${page}`}`;
}

/** The width of the captures of a repository. */
export function viewportWidthOf(settings: ScreenshotSettings): number {
    return settings.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
}

/** A short, safe file name part for a page path: "/" is "home", "/a/b?x=1" is "a-b-x-1". */
export function pageSlug(page: string): string {
    const slug = page
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug || 'home';
}

/** The image of one side of a page, as a reference for the comment. Undefined means no image. */
export interface CommentImage {
    page: string;
    side: ScreenshotSide;
    /** The address of the image that the provider gave. */
    url: string;
}

function shortSha(sha: string | undefined): string {
    return sha ? sha.slice(0, 7) : '';
}

/** The text of one side in the header of the comment, for example "`feature` at abc1234". */
function sideLabel(set: ScreenshotSet, side: ScreenshotSide): string | undefined {
    const shot = set.pages.map(page => page[side]).find(item => item && !item.error);
    return shot ? `\`${shot.branch}\` at ${shortSha(shot.sha)}` : undefined;
}

/** Text in a Markdown table cell: no pipes and no line breaks. */
function cell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

/**
 * Builds the Markdown of the PR comment: a table with the base and the branch of each page.
 * The same Markdown works on GitHub, Azure DevOps, and GitLab. Only the image addresses differ.
 */
export function screenshotCommentMarkdown(set: ScreenshotSet, images: CommentImage[]): string {
    const find = (page: string, side: ScreenshotSide) => images.find(image => image.page === page && image.side === side);
    const base = sideLabel(set, 'base');
    const branch = sideLabel(set, 'branch');
    const lines = ['### Screenshots', ''];
    const meta = [base ? `Base: ${base}` : undefined, branch ? `Branch: ${branch}` : undefined, `Width: ${set.viewportWidth} px`].filter(Boolean);
    lines.push(meta.join(' · '), '');
    for (const page of set.pages) {
        const baseImage = find(page.path, 'base');
        const branchImage = find(page.path, 'branch');
        if (!baseImage && !branchImage) continue;
        const image = (item: CommentImage | undefined, label: string) => (item ? `![${cell(`${label} ${page.path}`)}](${item.url})` : '_No image_');
        lines.push(
            `#### \`${cell(page.path)}\``,
            '',
            '| Base | Branch |',
            '| --- | --- |',
            `| ${image(baseImage, 'Base')} | ${image(branchImage, 'Branch')} |`,
            ''
        );
    }
    lines.push('<sub>Captured with ShipWarden.</sub>');
    return lines.join('\n');
}

/**
 * The file name of an uploaded image, for example "02-base-settings.png". `index` is the place of the page in the set.
 * It keeps the names unique when two paths have the same slug.
 */
export function uploadFileName(side: ScreenshotSide, page: string, index: number): string {
    return `${String(index + 1).padStart(2, '0')}-${side}-${pageSlug(page)}.png`;
}
