import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { compareEntries, type ContentMatch, type ContentSearchResult, type FileEntry } from '@shared/files';
import { kindFromExtension, MAX_TEXT_FILE_SIZE, sniffKind, type FileInfo, type FileKind } from '@shared/file-types';

/** ShipWarden does not open text files that are larger than this limit. */
export const MAX_FILE_SIZE = MAX_TEXT_FILE_SIZE;
/** The number of bytes at the start of a file that the kind test reads. */
const SNIFF_BYTES = 8000;
const MAX_CONTENT_MATCHES = 500;
const HIDDEN_NAMES = new Set(['.git', '.DS_Store']);

interface GitResult {
    stdout: string;
    code: number;
}

function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        const child = execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            const code =
                error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
                    ? (error as unknown as { code: number }).code
                    : error
                      ? -1
                      : 0;
            if (code === -1) {
                reject(new Error(`The command "git ${args.join(' ')}" failed: ${(stderr || error?.message || '').trim()}`));
            } else {
                resolve({ stdout, code });
            }
        });
        if (input !== undefined) {
            child.stdin?.end(input);
        }
    });
}

/**
 * Converts a path relative to the root to an absolute path.
 * Throws an error if the path is outside the root.
 */
export function resolveInside(root: string, relativePath: string): string {
    const absolute = path.resolve(root, relativePath);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`The path "${relativePath}" is outside the worktree.`);
    }
    return absolute;
}

/**
 * True when `target` is the folder `folder` or is in it. Both paths must be absolute.
 * The test compares the paths only. It does not follow symbolic links.
 */
export function isInside(folder: string, target: string): boolean {
    const relative = path.relative(folder, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Reads the first bytes of a file. */
async function readStart(absolute: string, length = SNIFF_BYTES): Promise<Uint8Array> {
    const handle = await fs.open(absolute, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/**
 * Returns the kind of a file. The extension tells the kind of most files.
 * For other files, the first bytes tell the kind.
 */
export async function detectKind(absolute: string): Promise<FileKind> {
    return kindFromExtension(absolute) ?? sniffKind(await readStart(absolute));
}

/** Converts an OS path to a path with "/" separators. */
function toPosix(value: string): string {
    return value.split(path.sep).join('/');
}

/**
 * Parses the output of `git grep --null --line-number`.
 * Each line has the form `<path>\0<line>\0<text>`.
 */
export function parseGitGrep(output: string, limit = MAX_CONTENT_MATCHES): ContentSearchResult {
    const matches: ContentMatch[] = [];
    let truncated = false;
    for (const line of output.split('\n')) {
        if (!line) {
            continue;
        }
        const [file, lineNumber, ...rest] = line.split('\0');
        const number = Number(lineNumber);
        if (!file || !Number.isFinite(number)) {
            continue;
        }
        if (matches.length >= limit) {
            truncated = true;
            break;
        }
        matches.push({ path: file, line: number, text: rest.join('\0') });
    }
    return { matches, truncated };
}

/** Reads folders and files of a worktree for the file explorer and the editor. */
export class FileService {
    /** Lists one folder. `directory` is relative to the root. An empty string is the root. */
    async listDirectory(root: string, directory: string): Promise<FileEntry[]> {
        const absolute = resolveInside(root, directory);
        const dirents = await fs.readdir(absolute, { withFileTypes: true });
        const entries: FileEntry[] = [];
        for (const dirent of dirents) {
            if (HIDDEN_NAMES.has(dirent.name)) {
                continue;
            }
            let isDirectory = dirent.isDirectory();
            if (dirent.isSymbolicLink()) {
                isDirectory = await fs.stat(path.join(absolute, dirent.name)).then(
                    stat => stat.isDirectory(),
                    () => false
                );
            }
            const relative = directory ? `${directory}/${dirent.name}` : dirent.name;
            entries.push({ name: dirent.name, path: relative, isDirectory, ignored: false });
        }

        const ignored = await this.ignoredPaths(root, entries);
        for (const entry of entries) {
            entry.ignored = ignored.has(entry.path);
        }
        return entries.sort(compareEntries);
    }

    /** Lists all files that git tracks or does not ignore. The file name filter uses this list. */
    async listFiles(root: string): Promise<string[]> {
        const { stdout, code } = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
        if (code !== 0) {
            throw new Error(`The folder "${root}" is not a git worktree.`);
        }
        const files = stdout.split('\0').filter(Boolean);
        // ls-files lists a file twice when it is tracked and changed in a merge. Remove the duplicates.
        return [...new Set(files)];
    }

    /** Searches the contents of the files that git does not ignore. The search ignores case when `caseSensitive` is false. */
    async searchContents(root: string, query: string, caseSensitive = false): Promise<ContentSearchResult> {
        if (!query.trim()) {
            return { matches: [], truncated: false };
        }
        const { stdout, code } = await git(root, [
            'grep',
            '--untracked',
            '-I',
            ...(caseSensitive ? [] : ['-i']),
            '--fixed-strings',
            '--null',
            '--line-number',
            '--no-color',
            '-e',
            query,
            '--',
            '.'
        ]);
        // git grep exits with code 1 when there are no matches.
        if (code !== 0 && code !== 1) {
            throw new Error(`git grep failed with exit code ${code}.`);
        }
        return parseGitGrep(stdout);
    }

    /** Returns the size and the kind of a file, so that the page can select a view. */
    async info(root: string, file: string): Promise<FileInfo> {
        const absolute = resolveInside(root, file);
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) {
            throw new Error(`The path "${file}" is not a file.`);
        }
        return { size: stat.size, kind: await detectKind(absolute) };
    }

    async readFile(root: string, file: string): Promise<string> {
        const absolute = resolveInside(root, file);
        const stat = await fs.stat(absolute);
        if (stat.size > MAX_FILE_SIZE) {
            throw new Error(`The file "${file}" is larger than 5 MB. ShipWarden does not open it.`);
        }
        const buffer = await fs.readFile(absolute);
        if (buffer.subarray(0, 8000).includes(0)) {
            throw new Error(`The file "${file}" is a binary file. ShipWarden does not open it.`);
        }
        return buffer.toString('utf8');
    }

    /** Reads a text file at an absolute path. The same size and binary limits apply. */
    async readExternal(absolutePath: string): Promise<string> {
        if (!path.isAbsolute(absolutePath)) {
            throw new Error(`The path "${absolutePath}" is not absolute.`);
        }
        return this.readFile(path.dirname(absolutePath), path.basename(absolutePath));
    }

    async writeFile(root: string, file: string, content: string): Promise<void> {
        await fs.writeFile(resolveInside(root, file), content, 'utf8');
    }

    /** Returns the entries that git ignores. Returns an empty set when the root is not a git worktree. */
    private async ignoredPaths(root: string, entries: FileEntry[]): Promise<Set<string>> {
        if (entries.length === 0) {
            return new Set();
        }
        // A trailing "/" lets patterns such as "build/" match folders.
        const input = entries.map(entry => (entry.isDirectory ? `${entry.path}/` : entry.path)).join('\0') + '\0';
        try {
            const { stdout } = await git(root, ['check-ignore', '--stdin', '-z'], input);
            return new Set(
                stdout
                    .split('\0')
                    .filter(Boolean)
                    .map(value => toPosix(value).replace(/\/$/, ''))
            );
        } catch {
            return new Set();
        }
    }
}
