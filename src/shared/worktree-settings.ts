/** The ignored files that a new worktree gets from the main worktree, when the user did not choose other patterns. */
export const DEFAULT_COPY_PATTERNS = ['.env', '.env.*'];

/** The ignored folders that "all except" does not copy, when the user did not choose others. They are large or belong to one build. */
export const DEFAULT_COPY_EXCLUDE = [
    'node_modules/', 'dist/', 'build/', 'out/', 'target/', '.next/', '.turbo/', '.cache/', 'coverage/',
    '.venv/', '__pycache__/', '.gradle/', '*.tsbuildinfo'
];

/** "matching": copy the ignored entries that match `patterns`. "allExcept": copy all ignored entries except `exclude`. */
export type CopyMode = 'matching' | 'allExcept';

/**
 * The git-ignored files and folders to copy from the main worktree to a new worktree.
 * A pattern without "/" matches the name at any depth. A pattern with "/" matches the path from the repository root.
 * "*" matches any characters except "/", "**" matches any characters, "?" matches one character.
 * A pattern that ends with "/" matches only folders.
 */
export interface CopyIgnoredSettings {
    enabled: boolean;
    mode: CopyMode;
    patterns: string[];
    exclude: string[];
}

/** The worktree settings of all repositories. */
export interface WorktreeSettings {
    /** The folder for new worktrees: <directory>/<repository name>/<branch>. Empty: ~/.shipwarden/worktrees. */
    directory?: string;
    copyIgnored: CopyIgnoredSettings;
}

/** The worktree settings of one repository. A missing value uses the global setting. */
export interface RepoWorktreeSettings {
    /** The folder for the new worktrees of this repository: <directory>/<branch>. */
    directory?: string;
    copyIgnored?: CopyIgnoredSettings;
    /** A shell script that runs in a new worktree, in a terminal tab. */
    setupScript?: string;
    /** A shell script that runs in a worktree before ShipWarden removes it. */
    teardownScript?: string;
}

/** The settings that apply to the worktrees of one repository. */
export interface ResolvedWorktreeSettings {
    /** The folder that gets the worktree folders of this repository. */
    parentFolder: string;
    copyIgnored: CopyIgnoredSettings;
    setupScript?: string;
    teardownScript?: string;
}

export const DEFAULT_COPY_SETTINGS: CopyIgnoredSettings = { enabled: true, mode: 'matching', patterns: DEFAULT_COPY_PATTERNS, exclude: DEFAULT_COPY_EXCLUDE };

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = { copyIgnored: DEFAULT_COPY_SETTINGS };

function cleanPatterns(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

function normalizeCopy(value: unknown): CopyIgnoredSettings | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    return {
        enabled: raw.enabled !== false,
        mode: raw.mode === 'allExcept' ? 'allExcept' : 'matching',
        patterns: cleanPatterns(raw.patterns),
        // Settings from before the mode have no exclusions. They get the default list.
        exclude: Array.isArray(raw.exclude) ? cleanPatterns(raw.exclude) : DEFAULT_COPY_EXCLUDE
    };
}

function cleanText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A script keeps its own lines. Only an empty script is removed. */
function cleanScript(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.replace(/\s+$/, '') : undefined;
}

export function normalizeWorktreeSettings(value: unknown): WorktreeSettings {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const directory = cleanText(raw.directory);
    return { ...(directory ? { directory } : {}), copyIgnored: normalizeCopy(raw.copyIgnored) ?? DEFAULT_WORKTREE_SETTINGS.copyIgnored };
}

/** Returns the valid worktree settings of a repository, or undefined when nothing differs from the global settings. */
export function normalizeRepoWorktreeSettings(value: unknown): RepoWorktreeSettings | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const result: RepoWorktreeSettings = {};
    const directory = cleanText(raw.directory);
    const copy = normalizeCopy(raw.copyIgnored);
    const setup = cleanScript(raw.setupScript);
    const teardown = cleanScript(raw.teardownScript);
    if (directory) result.directory = directory;
    if (copy) result.copyIgnored = copy;
    if (setup) result.setupScript = setup;
    if (teardown) result.teardownScript = teardown;
    return Object.keys(result).length > 0 ? result : undefined;
}

/** Replaces a leading "~" with the home folder. */
export function expandHome(folder: string, home: string): string {
    return folder === '~' ? home : folder.startsWith('~/') ? `${home}${folder.slice(1)}` : folder;
}

/** The last part of a path. */
function baseName(folder: string): string {
    return folder.split('/').filter(Boolean).pop() ?? folder;
}

/**
 * Returns the worktree settings of a repository: its own settings, else the global settings.
 * `defaultRoot` is the folder when the global directory is empty, for example ~/.shipwarden/worktrees.
 */
export function resolveWorktreeSettings(
    global: WorktreeSettings,
    repo: RepoWorktreeSettings | undefined,
    repoRoot: string,
    defaultRoot: string,
    home: string
): ResolvedWorktreeSettings {
    const parentFolder = repo?.directory
        ? expandHome(repo.directory, home)
        : `${expandHome(global.directory ?? defaultRoot, home).replace(/\/+$/, '')}/${baseName(repoRoot)}`;
    return {
        parentFolder,
        copyIgnored: repo?.copyIgnored ?? global.copyIgnored,
        ...(repo?.setupScript ? { setupScript: repo.setupScript } : {}),
        ...(repo?.teardownScript ? { teardownScript: repo.teardownScript } : {})
    };
}

function globToRegExp(glob: string): RegExp {
    let source = '';
    for (let index = 0; index < glob.length; index++) {
        const char = glob[index];
        if (char === '*' && glob[index + 1] === '*') {
            // "**/" matches zero or more folders.
            source += glob[index + 2] === '/' ? '(?:.*/)?' : '.*';
            index += glob[index + 2] === '/' ? 2 : 1;
        } else if (char === '*') {
            source += '[^/]*';
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}

/**
 * True when a path from the repository root (with "/" at the end for a folder) matches a copy pattern.
 * A pattern that ends with "/" matches only folders.
 */
export function matchesCopyPattern(entry: string, pattern: string): boolean {
    const isFolder = entry.endsWith('/');
    const file = entry.replace(/\/+$/, '');
    let glob = pattern.trim().replace(/^\//, '');
    if (glob.endsWith('/')) {
        if (!isFolder) return false;
        glob = glob.replace(/\/+$/, '');
    }
    if (!glob) return false;
    const regex = globToRegExp(glob);
    return glob.includes('/') ? regex.test(file) : regex.test(file.split('/').pop() ?? file);
}

/**
 * Removes the folders that only contain other entries from the output of
 * "git ls-files --others --ignored --exclude-standard --directory". Git lists a folder with only ignored content
 * (for example "apps/") next to its ignored entries ("apps/web/.env.local"). Such a folder is not ignored itself.
 * An ignored folder (for example "node_modules/") has no listed entries in it, so it stays.
 */
export function ignoredUnits(entries: string[]): string[] {
    return entries.filter(entry => !entry.endsWith('/') || !entries.some(other => other !== entry && other.startsWith(entry)));
}

/** Returns the ignored entries (paths from the root, a folder with "/" at the end) that the copy settings copy. */
export function selectCopyEntries(entries: string[], copy: CopyIgnoredSettings): string[] {
    if (!copy.enabled) return [];
    return copy.mode === 'allExcept'
        ? entries.filter(entry => !copy.exclude.some(pattern => matchesCopyPattern(entry, pattern)))
        : entries.filter(entry => copy.patterns.some(pattern => matchesCopyPattern(entry, pattern)));
}

/** The environment variables of the setup and teardown scripts. */
export interface ScriptVariables {
    rootPath: string;
    worktreePath: string;
    branch?: string;
    repoName: string;
}

export function scriptEnvironment(vars: ScriptVariables): Record<string, string> {
    return {
        SHIPWARDEN_ROOT_PATH: vars.rootPath,
        SHIPWARDEN_WORKTREE_PATH: vars.worktreePath,
        SHIPWARDEN_BRANCH: vars.branch ?? '',
        SHIPWARDEN_REPO_NAME: vars.repoName,
        // The names from the time when the app was Yardmaster, for scripts that use them.
        YARDMASTER_ROOT_PATH: vars.rootPath,
        YARDMASTER_WORKTREE_PATH: vars.worktreePath,
        YARDMASTER_BRANCH: vars.branch ?? '',
        YARDMASTER_REPO_NAME: vars.repoName
    };
}

/** Quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The terminal command of a setup script: the variables, then the script. The terminal tab shows its output. */
export function setupCommand(script: string, vars: ScriptVariables): string {
    const exports = Object.entries(scriptEnvironment(vars)).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('; ');
    return `${exports}; ${script}`;
}
