import type { CheckConclusion, CheckStatus, MergeMethod, RepoRef, ReviewEvent } from './github';

/** The web host of Bitbucket Cloud. */
export const BITBUCKET_HOST = 'bitbucket.org';

/** The base URL of the Bitbucket Cloud REST API, version 2.0. */
export const BITBUCKET_API_URL = 'https://api.bitbucket.org/2.0';

/** A Bitbucket Cloud repository: the slug of its workspace and its own slug. */
export interface BitbucketRepoRef {
    workspace: string;
    repo: string;
}

/** The hosts that serve the git remotes of Bitbucket Cloud. "altssh.bitbucket.org" serves SSH on port 443. */
const REMOTE_HOSTS = new Set(['bitbucket.org', 'www.bitbucket.org', 'altssh.bitbucket.org']);

function decodePart(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

/** Splits "workspace/repo[.git]" into its parts. Returns undefined when the path does not have exactly 2 parts. */
function splitPath(path: string): BitbucketRepoRef | undefined {
    const parts = path
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean)
        .map(decodePart);
    if (parts.length !== 2) return undefined;
    return { workspace: parts[0], repo: parts[1] };
}

/**
 * Parses a Bitbucket Cloud remote URL. Returns undefined for other URLs. It accepts these forms:
 * - git@bitbucket.org:{workspace}/{repo}.git
 * - ssh://git@bitbucket.org/{workspace}/{repo}.git, also ssh://git@altssh.bitbucket.org:443/...
 * - https://[user[:password]@]bitbucket.org/{workspace}/{repo}.git
 */
export function parseBitbucketRemote(url: string): BitbucketRepoRef | undefined {
    const text = url.trim();
    let match = /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(text);
    if (!match) match = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(text);
    if (match && /^https?$/i.test(match[1])) match = null;
    if (!match) match = /^https?:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(text);
    if (!match || !REMOTE_HOSTS.has(match[1].toLowerCase())) return undefined;
    return splitPath(match[2]);
}

/** Returns the Bitbucket repository of a reference. Returns undefined for other hosts. */
export function bitbucketRepoOf(repo: RepoRef | null | undefined): BitbucketRepoRef | undefined {
    if (repo?.host !== 'bitbucket' || !repo.owner || !repo.name) return undefined;
    return { workspace: repo.owner, repo: repo.name };
}

/** Returns the reference of a Bitbucket repository, for the page. */
export function bitbucketRepoRef(repo: BitbucketRepoRef): RepoRef {
    return { owner: repo.workspace, name: repo.repo, host: 'bitbucket' };
}

/** The API path of a repository, for example "/repositories/acme/api". */
export function bitbucketRepoApi(repo: BitbucketRepoRef): string {
    return `/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repo)}`;
}

/** The web page of a repository. */
export function bitbucketRepoWebUrl(repo: BitbucketRepoRef): string {
    return `https://${BITBUCKET_HOST}/${repo.workspace}/${repo.repo}`;
}

/** The web page of a pull request. */
export function bitbucketPullRequestWebUrl(repo: BitbucketRepoRef, id: number): string {
    return `${bitbucketRepoWebUrl(repo)}/pull-requests/${id}`;
}

/** The web page that creates a pull request from a branch. */
export function bitbucketCreatePullRequestUrl(repo: BitbucketRepoRef, branch: string): string {
    return `${bitbucketRepoWebUrl(repo)}/pull-requests/new?source=${encodeURIComponent(branch)}`;
}

/** The web page of the pipelines of a repository. */
export function bitbucketPipelinesWebUrl(repo: BitbucketRepoRef): string {
    return `${bitbucketRepoWebUrl(repo)}/pipelines`;
}

/**
 * Makes an ID that holds the repository, the pull request, and a comment, so a call with only the ID
 * (for example "resolve the thread") can find the repository. All Bitbucket IDs start with "bitbucket:".
 */
export function encodeBitbucketId(repo: BitbucketRepoRef, id: number, commentId?: number): string {
    const parts = [repo.workspace, repo.repo, String(id)];
    if (commentId !== undefined) parts.push(String(commentId));
    return `bitbucket:${parts.map(encodeURIComponent).join('/')}`;
}

/** Reads an ID from `encodeBitbucketId`. Returns undefined for other IDs. */
export function decodeBitbucketId(value: string): { repo: BitbucketRepoRef; id: number; commentId?: number } | undefined {
    if (!value.startsWith('bitbucket:')) return undefined;
    const parts = value.slice('bitbucket:'.length).split('/').map(decodePart);
    if (parts.length < 3 || parts.length > 4) return undefined;
    const id = Number(parts[2]);
    if (!Number.isInteger(id) || id <= 0) return undefined;
    const commentId = parts[3] === undefined ? undefined : Number(parts[3]);
    if (commentId !== undefined && (!Number.isInteger(commentId) || commentId <= 0)) return undefined;
    return { repo: { workspace: parts[0], repo: parts[1] }, id, ...(commentId !== undefined ? { commentId } : {}) };
}

/** The review events of Bitbucket before the user approves, in the order of the buttons. */
export const BITBUCKET_REVIEW_EVENTS: ReviewEvent[] = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];

/** The review events of Bitbucket after the user approved. "UNAPPROVE" removes the approval. */
export const BITBUCKET_APPROVED_EVENTS: ReviewEvent[] = ['COMMENT', 'REQUEST_CHANGES', 'UNAPPROVE'];

/**
 * The merge strategies of Bitbucket Cloud, as the branch API gives them in `merge_strategies`.
 * See https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/
 */
export type BitbucketMergeStrategy = 'merge_commit' | 'squash' | 'fast_forward' | 'squash_fast_forward' | 'rebase_fast_forward' | 'rebase_merge';

/** The merge method of the UI for each strategy. A fast-forward or a rebase keeps the commits, so it is "rebase". */
const STRATEGY_METHOD: Record<BitbucketMergeStrategy, MergeMethod> = {
    merge_commit: 'merge',
    squash: 'squash',
    squash_fast_forward: 'squash',
    fast_forward: 'rebase',
    rebase_fast_forward: 'rebase',
    rebase_merge: 'rebase'
};

/** Returns the merge method of the UI for a strategy. Returns undefined for a strategy that ShipWarden does not know. */
export function mergeMethodOfStrategy(strategy: string | null | undefined): MergeMethod | undefined {
    return STRATEGY_METHOD[strategy as BitbucketMergeStrategy];
}

/**
 * Returns the merge methods that the branch allows and the preferred method.
 * Without a list of strategies, all strategies are allowed and "merge" is preferred.
 */
export function mergeMethodsOfStrategies(
    strategies: readonly string[] | null | undefined,
    defaultStrategy: string | null | undefined
): { allowed: MergeMethod[]; preferred: MergeMethod } {
    const order: MergeMethod[] = ['merge', 'squash', 'rebase'];
    const known = (strategies ?? []).map(mergeMethodOfStrategy).filter((method): method is MergeMethod => !!method);
    const allowed = known.length > 0 ? order.filter(method => known.includes(method)) : order;
    const preferred = mergeMethodOfStrategy(defaultStrategy);
    return { allowed, preferred: preferred && allowed.includes(preferred) ? preferred : allowed[0] };
}

/**
 * Selects the Bitbucket strategy for a merge method. The default strategy of the branch wins when it has the method.
 * Else the first allowed strategy with the method. Without a list, "merge" is "merge_commit", "squash" is "squash", and
 * "rebase" is "fast_forward".
 */
export function strategyForMethod(
    method: MergeMethod,
    strategies: readonly string[] | null | undefined,
    defaultStrategy: string | null | undefined
): BitbucketMergeStrategy {
    if (mergeMethodOfStrategy(defaultStrategy) === method) return defaultStrategy as BitbucketMergeStrategy;
    const allowed = (strategies ?? []).find(strategy => mergeMethodOfStrategy(strategy) === method);
    if (allowed) return allowed as BitbucketMergeStrategy;
    return method === 'merge' ? 'merge_commit' : method === 'squash' ? 'squash' : 'fast_forward';
}

/**
 * Converts the state of a pipeline or a step to the check status and conclusion of the UI.
 * `state` is the name of the state: PENDING, READY, IN_PROGRESS, PAUSED, HALTED, or COMPLETED.
 * `result` is the name of the result of a completed item: SUCCESSFUL, FAILED, ERROR, STOPPED, EXPIRED, or NOT_RUN.
 * `stage` is the name of the stage of a pipeline in progress, for example PAUSED for a manual step.
 */
export function pipelineStateToCheck(
    state: string | null | undefined,
    result?: string | null,
    stage?: string | null
): { status: CheckStatus; conclusion: CheckConclusion } {
    switch (state) {
        case 'COMPLETED':
            switch (result) {
                case 'SUCCESSFUL':
                    return { status: 'completed', conclusion: 'success' };
                case 'FAILED':
                case 'ERROR':
                    return { status: 'completed', conclusion: 'failure' };
                case 'STOPPED':
                    return { status: 'completed', conclusion: 'cancelled' };
                case 'EXPIRED':
                    return { status: 'completed', conclusion: 'timed_out' };
                case 'NOT_RUN':
                case 'SKIPPED':
                    return { status: 'completed', conclusion: 'skipped' };
                default:
                    return { status: 'completed', conclusion: 'neutral' };
            }
        case 'IN_PROGRESS':
        case 'RUNNING':
            return stage === 'PAUSED' || stage === 'HALTED' ? { status: 'waiting', conclusion: null } : { status: 'in_progress', conclusion: null };
        case 'PAUSED':
        case 'HALTED':
            return { status: 'waiting', conclusion: null };
        default:
            return { status: 'queued', conclusion: null };
    }
}

/** Converts the state of a commit status (SUCCESSFUL, FAILED, INPROGRESS, or STOPPED) to the check status of the UI. */
export function commitStatusToCheck(state: string | null | undefined): { status: CheckStatus; conclusion: CheckConclusion } {
    switch (state) {
        case 'SUCCESSFUL':
            return { status: 'completed', conclusion: 'success' };
        case 'FAILED':
            return { status: 'completed', conclusion: 'failure' };
        case 'STOPPED':
            return { status: 'completed', conclusion: 'cancelled' };
        default:
            return { status: 'in_progress', conclusion: null };
    }
}

/** Removes the ANSI escape codes from a step log and keeps the last part of each line after a carriage return. */
export function cleanBitbucketLog(log: string): string {
    return log
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => {
            const parts = line.split('\r');
            return parts[parts.length - 1];
        })
        .join('\n');
}

/** One file of a unified diff: the paths and the "@@" hunks. */
export interface DiffFilePatch {
    oldPath: string | null;
    newPath: string | null;
    /** The hunks from the first "@@" line. Undefined for a binary file or a change without hunks. */
    patch?: string;
}

/** Removes the "a/" or "b/" of a path of a diff header. "/dev/null" gives null. */
function diffPath(value: string | undefined, prefix: 'a/' | 'b/'): string | null {
    if (!value || value === '/dev/null') return null;
    const text = value.replace(/\t.*$/, '').replace(/^"(.*)"$/, '$1');
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * Splits a unified diff of many files (the diff of a pull request) into one patch for each file.
 * The "---" and "+++" lines give the paths. A file without them (for example a binary file) takes the paths of its
 * "diff --git" line.
 */
export function splitUnifiedDiff(diff: string): DiffFilePatch[] {
    const files: DiffFilePatch[] = [];
    let current: (DiffFilePatch & { hunks: string[] }) | undefined;
    const finish = () => {
        if (!current) return;
        const { hunks, ...file } = current;
        files.push(hunks.length > 0 ? { ...file, patch: hunks.join('\n') } : file);
    };
    for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
        const header = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
        if (header) {
            finish();
            current = { oldPath: header[1], newPath: header[2], hunks: [] };
            continue;
        }
        if (!current) continue;
        if (current.hunks.length === 0) {
            if (line.startsWith('--- ')) {
                current.oldPath = diffPath(line.slice(4), 'a/');
                continue;
            }
            if (line.startsWith('+++ ')) {
                current.newPath = diffPath(line.slice(4), 'b/');
                continue;
            }
            if (!line.startsWith('@@')) continue;
        }
        current.hunks.push(line);
    }
    finish();
    // The last line of a diff ends with a newline. The split gives an empty last line, which is not part of a hunk.
    return files.map(file => (file.patch?.endsWith('\n') ? { ...file, patch: file.patch.replace(/\n+$/, '') } : file));
}
