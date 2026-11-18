/** The hash that `git blame` gives to lines that are not in a commit. */
export const UNCOMMITTED_HASH = '0000000000000000000000000000000000000000';

/** One commit of a blame. */
export interface BlameCommit {
    hash: string;
    author: string;
    authorEmail: string;
    /** The author time in milliseconds. */
    date: number;
    summary: string;
    /** True for the lines that are not in a commit yet. */
    uncommitted: boolean;
}

/** The last commit that changed each line of a file. */
export interface FileBlame {
    /** The commits of the blame, by hash. */
    commits: Record<string, BlameCommit>;
    /** The commit hash of each line. Item 0 is line 1. */
    lines: string[];
}

/** One commit in the history of a file. */
export interface FileHistoryCommit {
    hash: string;
    /** The parent hashes. A root commit has none. */
    parents: string[];
    author: string;
    authorEmail: string;
    /** The author time in milliseconds. */
    date: number;
    subject: string;
    /** The full commit message. */
    body: string;
    /** The path of the file in this commit. */
    path: string;
    /** The path of the file before this commit, when this commit renamed the file. */
    oldPath?: string;
    /** The kind of change: A (added), M (modified), D (deleted), R (renamed), or C (copied). */
    status: string;
}

export interface FileHistory {
    commits: FileHistoryCommit[];
    /** True when the history has more commits than the limit. */
    more: boolean;
}

/**
 * Parses the output of `git blame --porcelain`. The first line of each commit has its header lines. The next lines of
 * the same commit have only the hash line and the text line.
 */
export function parseBlamePorcelain(text: string): FileBlame {
    const commits: Record<string, BlameCommit> = {};
    const lines: string[] = [];
    const rows = text.split('\n');
    let index = 0;
    while (index < rows.length) {
        const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(rows[index]);
        index++;
        if (!header) continue;
        const [, hash, final] = header;
        let commit = commits[hash];
        if (!commit) {
            commit = { hash, author: '', authorEmail: '', date: 0, summary: '', uncommitted: hash === UNCOMMITTED_HASH };
            commits[hash] = commit;
        }
        // The header lines continue to the text line. The text line starts with a tab.
        while (index < rows.length && !rows[index].startsWith('\t')) {
            const row = rows[index];
            const space = row.indexOf(' ');
            const key = space < 0 ? row : row.slice(0, space);
            const value = space < 0 ? '' : row.slice(space + 1);
            if (key === 'author') commit.author = value;
            else if (key === 'author-mail') commit.authorEmail = value.replace(/^<|>$/g, '');
            else if (key === 'author-time') commit.date = Number(value) * 1000;
            else if (key === 'summary') commit.summary = value;
            index++;
        }
        index++;
        lines[Number(final) - 1] = hash;
    }
    return { commits, lines };
}

/** The separator of the commits in the file history output. */
const RECORD = '\x1e';
/** The separator of the fields of one commit. */
const FIELD = '\x1f';

/** The `--format` of `git log` for `parseFileHistory`. The body is last, because it can contain new lines. */
export const FILE_HISTORY_FORMAT = `${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s${FIELD}%B${FIELD}`;

/**
 * Parses the output of `git log --name-status -z --format=FILE_HISTORY_FORMAT -- <file>`. The `-z` option separates
 * the status and the paths with NUL characters.
 */
export function parseFileHistory(text: string): FileHistoryCommit[] {
    const commits: FileHistoryCommit[] = [];
    for (const record of text.split(RECORD)) {
        if (!record.trim()) continue;
        const fields = record.split(FIELD);
        if (fields.length < 8) continue;
        const [hash, parents, author, authorEmail, time, subject, body] = fields;
        const changes = fields
            .slice(7)
            .join(FIELD)
            .split('\0')
            .map(item => item.trim());
        while (changes.length && !changes[0]) changes.shift();
        const status = changes[0]?.charAt(0) ?? 'M';
        const renamed = status === 'R' || status === 'C';
        const path = (renamed ? changes[2] : changes[1]) ?? '';
        commits.push({
            hash,
            parents: parents ? parents.split(' ') : [],
            author,
            authorEmail,
            date: Number(time) * 1000,
            subject,
            body: body.trim(),
            path,
            ...(renamed && changes[1] ? { oldPath: changes[1] } : {}),
            status
        });
    }
    return commits;
}

/** Returns a date as YYYY-MM-DD in the local time zone, for the blame column. */
export function blameDate(date: number): string {
    const value = new Date(date);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}
