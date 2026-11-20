import type { CheckConclusion, CheckStatus, RepoRef, ReviewEvent } from './github';

/** The server of a GitLab provider without a host URL. */
export const GITLAB_DEFAULT_URL = 'https://gitlab.com';

/**
 * A GitLab project. `host` is the host of the server, for example "gitlab.com" or "git.example.com:8443".
 * `namespace` is the group path, with all subgroups, for example "acme/platform/web".
 */
export interface GitLabRepoRef {
    host: string;
    namespace: string;
    project: string;
}

/**
 * Returns the base URL of a GitLab server without a "/" at the end, for example "https://git.example.com".
 * A URL without a protocol gets "https://". A server in a subfolder keeps the folder, for example "https://example.com/gitlab".
 * Returns undefined for a text that is not a URL.
 */
export function normalizeGitLabUrl(value: string | undefined | null): string | undefined {
    const text = (value ?? '').trim();
    if (!text) return undefined;
    try {
        const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
        return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
        return undefined;
    }
}

/** Returns the host of a GitLab base URL in lowercase, for example "gitlab.com". Returns undefined for a text that is not a URL. */
export function gitlabHostOf(baseUrl: string | undefined | null): string | undefined {
    const url = normalizeGitLabUrl(baseUrl ?? GITLAB_DEFAULT_URL);
    return url ? new URL(url).host.toLowerCase() : undefined;
}

/** Splits a project path into its namespace and its project. Returns undefined for a path with less than 2 parts. */
function splitPath(raw: string): { namespace: string; project: string } | undefined {
    const decode = (part: string) => {
        try {
            return decodeURIComponent(part);
        } catch {
            return part;
        }
    };
    const parts = raw
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean)
        .map(decode);
    // A web URL can point to a page of the project, for example "/-/merge_requests/3". The project path ends before "/-/".
    const dash = parts.indexOf('-');
    const path = dash >= 0 ? parts.slice(0, dash) : parts;
    if (path.length < 2) return undefined;
    return { namespace: path.slice(0, -1).join('/'), project: path[path.length - 1] };
}

/**
 * Parses a GitLab remote URL. Returns undefined for other URLs.
 * `servers` are the base URLs of the GitLab servers. gitlab.com is always a server.
 * It accepts these forms, also with subgroups:
 * - git@{host}:{group}/{project}.git
 * - ssh://git@{host}[:port]/{group}/{project}.git
 * - https://[user[:password]@]{host}[:port][/folder]/{group}/{project}.git
 * The SSH forms match the server by its host name only, because the SSH port is not the port of the web server.
 */
export function parseGitLabRemote(url: string, servers: readonly string[] = []): GitLabRepoRef | undefined {
    const text = url.trim();
    const known = [GITLAB_DEFAULT_URL, ...servers].flatMap(server => {
        const base = normalizeGitLabUrl(server);
        if (!base) return [];
        const parsed = new URL(base);
        return [{ host: parsed.host.toLowerCase(), hostname: parsed.hostname.toLowerCase(), folder: parsed.pathname.replace(/\/+$/, '') }];
    });
    const make = (hostname: string, port: string | undefined, path: string, web: boolean): GitLabRepoRef | undefined => {
        const name = hostname.toLowerCase();
        const server = web
            ? (known.find(item => item.host === (port ? `${name}:${port}` : name)) ?? known.find(item => item.hostname === name && !port))
            : known.find(item => item.hostname === name);
        if (!server) return undefined;
        let rest = path;
        if (web && server.folder) {
            if (!rest.toLowerCase().startsWith(`${server.folder.toLowerCase()}/`)) return undefined;
            rest = rest.slice(server.folder.length);
        }
        const parts = splitPath(rest);
        return parts && { host: server.host, ...parts };
    };
    // SSH: ssh://git@host[:port]/group/project.git
    let match = /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(text);
    if (match) return make(match[1], undefined, `/${match[2]}`, false);
    // SCP-like SSH: git@host:group/project.git
    match = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(text);
    if (match && !/^https?$/i.test(match[1])) return make(match[1], undefined, `/${match[2]}`, false);
    // HTTPS: https://[user@]host[:port]/[folder/]group/project.git
    match = /^https?:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::(\d+))?(\/.+)$/i.exec(text);
    if (match) return make(match[1], match[2], match[3], true);
    return undefined;
}

/** The ID of a project for the REST API: the full path, URL-encoded, for example "acme%2Fplatform%2Fweb". */
export function gitlabProjectId(repo: Pick<GitLabRepoRef, 'namespace' | 'project'>): string {
    return encodeURIComponent(`${repo.namespace}/${repo.project}`);
}

/**
 * The web page of the project. The page uses https, because a `RepoRef` has no protocol.
 * The main process uses the `web_url` of the API when it has one.
 */
export function gitlabRepoWebUrl(repo: GitLabRepoRef): string {
    return `https://${repo.host}/${repo.namespace}/${repo.project}`;
}

/** The web page of a merge request. */
export function gitlabMergeRequestWebUrl(repo: GitLabRepoRef, iid: number): string {
    return `${gitlabRepoWebUrl(repo)}/-/merge_requests/${iid}`;
}

/** The web page that creates a merge request from a branch. */
export function gitlabCreateMergeRequestUrl(repo: GitLabRepoRef, branch: string): string {
    return `${gitlabRepoWebUrl(repo)}/-/merge_requests/new?${encodeURIComponent('merge_request[source_branch]')}=${encodeURIComponent(branch)}`;
}

/**
 * Returns the GitLab project of a reference. Returns undefined for other hosts.
 * The owner of a GitLab reference is "host/namespace", for example "gitlab.com/acme/platform".
 */
export function gitlabRepoOf(repo: RepoRef | null | undefined): GitLabRepoRef | undefined {
    if (repo?.host !== 'gitlab') return undefined;
    const slash = repo.owner.indexOf('/');
    if (slash <= 0 || slash === repo.owner.length - 1 || !repo.name) return undefined;
    return { host: repo.owner.slice(0, slash).toLowerCase(), namespace: repo.owner.slice(slash + 1), project: repo.name };
}

/** Returns the reference of a GitLab project, for the page. */
export function gitlabRepoRef(repo: GitLabRepoRef): RepoRef {
    return { owner: `${repo.host}/${repo.namespace}`, name: repo.project, host: 'gitlab' };
}

/** Returns the first group of a namespace, for the scope of a provider. */
export function topGroupOf(namespace: string): string {
    return namespace.split('/')[0];
}

/** True when the project path is in one of the groups of the scope, also in a subgroup. The match ignores case. */
export function inGroups(path: string, scope: readonly string[] | undefined): boolean {
    if (!scope) return true;
    const lower = path.toLowerCase();
    return scope.some(group => {
        const prefix = group.toLowerCase().replace(/\/+$/, '');
        return lower === prefix || lower.startsWith(`${prefix}/`);
    });
}

/**
 * Makes an ID that holds the project, the merge request and a discussion, so a call with only the ID
 * (for example "resolve the thread") can find the project. All GitLab IDs start with "gitlab:".
 */
export function encodeGitLabId(repo: GitLabRepoRef, iid: number, discussionId?: string): string {
    const parts = [repo.host, repo.namespace, repo.project, String(iid)];
    if (discussionId !== undefined) parts.push(discussionId);
    return `gitlab:${parts.map(encodeURIComponent).join('/')}`;
}

/** Reads an ID from `encodeGitLabId`. Returns undefined for other IDs. */
export function decodeGitLabId(id: string): { repo: GitLabRepoRef; iid: number; discussionId?: string } | undefined {
    if (!id.startsWith('gitlab:')) return undefined;
    const parts = id.slice('gitlab:'.length).split('/').map(decodeURIComponent);
    if (parts.length < 4 || parts.length > 5) return undefined;
    const iid = Number(parts[3]);
    if (!Number.isInteger(iid) || iid <= 0) return undefined;
    return { repo: { host: parts[0], namespace: parts[1], project: parts[2] }, iid, ...(parts[4] ? { discussionId: parts[4] } : {}) };
}

/** The review events of GitLab before the user approves, in the order of the buttons. */
export const GITLAB_REVIEW_EVENTS: ReviewEvent[] = ['COMMENT', 'APPROVE'];

/** The review events of GitLab after the user approved. "UNAPPROVE" revokes the approval. */
export const GITLAB_APPROVED_EVENTS: ReviewEvent[] = ['COMMENT', 'UNAPPROVE'];

/**
 * Returns the review events of a GitLab merge request after a review of the user. An approval gives "UNAPPROVE",
 * and "UNAPPROVE" gives "APPROVE" again. Other hosts do not change.
 */
export function reviewEventsAfter(host: string | undefined, events: ReviewEvent[] | undefined, event: ReviewEvent): ReviewEvent[] | undefined {
    if (host !== 'gitlab' || !events) return events;
    if (event === 'APPROVE') return events.map(item => (item === 'APPROVE' ? 'UNAPPROVE' : item));
    if (event === 'UNAPPROVE') return events.map(item => (item === 'UNAPPROVE' ? 'APPROVE' : item));
    return events;
}

/**
 * The status of a GitLab job or pipeline:
 * https://docs.gitlab.com/api/jobs/ and https://docs.gitlab.com/api/pipelines/
 */
export type GitLabJobStatus =
    | 'created'
    | 'pending'
    | 'running'
    | 'failed'
    | 'success'
    | 'canceled'
    | 'canceling'
    | 'skipped'
    | 'manual'
    | 'scheduled'
    | 'preparing'
    | 'waiting_for_resource'
    | 'waiting_for_callback';

/**
 * Converts the status of a job or a pipeline to the check status and conclusion of the UI.
 * A manual job that nobody started is "skipped", so it does not keep the checks pending or make them fail.
 * A failed job that is allowed to fail is "neutral".
 */
export function jobStatusToCheck(
    status: GitLabJobStatus | string | null | undefined,
    allowFailure = false
): { status: CheckStatus; conclusion: CheckConclusion } {
    switch (status) {
        case 'success':
            return { status: 'completed', conclusion: 'success' };
        case 'failed':
            return { status: 'completed', conclusion: allowFailure ? 'neutral' : 'failure' };
        case 'canceled':
            return { status: 'completed', conclusion: 'cancelled' };
        case 'skipped':
        case 'manual':
            return { status: 'completed', conclusion: 'skipped' };
        case 'running':
        case 'canceling':
            return { status: 'in_progress', conclusion: null };
        case 'scheduled':
        case 'waiting_for_resource':
        case 'waiting_for_callback':
            return { status: 'waiting', conclusion: null };
        default:
            return { status: 'queued', conclusion: null };
    }
}

/**
 * Removes the GitLab section markers and the ANSI escape codes from a job log (trace).
 * A section line starts with "section_start:<time>:<name>" or "section_end:<time>:<name>".
 */
export function cleanGitLabTrace(trace: string): string {
    return trace
        .replace(/section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?\r?/g, '')
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => {
            // A carriage return inside a line overwrites the start of the line in a terminal. The last part is what shows.
            const parts = line.split('\r');
            return parts[parts.length - 1];
        })
        .join('\n');
}

/** The old and the new line of a line in a diff. Undefined means that the line is not on that side. */
export interface DiffLinePosition {
    old_line?: number;
    new_line?: number;
}

/**
 * Finds the line numbers that GitLab needs for a new comment on a diff line.
 * An added line has only `new_line`. A removed line has only `old_line`. A line without a change (in a hunk or out of
 * all hunks) needs both. The patch is the "@@" text of the file. Without a patch, the line is on its side only.
 */
export function diffLinePosition(patch: string | undefined, side: 'LEFT' | 'RIGHT', line: number): DiffLinePosition {
    const own: DiffLinePosition = side === 'RIGHT' ? { new_line: line } : { old_line: line };
    if (!patch) return own;
    // The difference "new line - old line" after the last hunk before the line. Lines out of all hunks keep this difference.
    let delta = 0;
    let oldLine = 0;
    let newLine = 0;
    for (const text of patch.split('\n')) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        if (header) {
            const oldStart = Number(header[1]);
            const newStart = Number(header[2]);
            const target = side === 'RIGHT' ? newStart : oldStart;
            // The line is before this hunk: it has no change.
            if (line < target) break;
            oldLine = oldStart;
            newLine = newStart;
            delta = newStart - oldStart;
            continue;
        }
        if (oldLine === 0 && newLine === 0) continue;
        const kind = text[0];
        if (kind === '\\') continue;
        if (kind === '+') {
            if (side === 'RIGHT' && newLine === line) return { new_line: line };
            newLine++;
        } else if (kind === '-') {
            if (side === 'LEFT' && oldLine === line) return { old_line: line };
            oldLine++;
        } else {
            if ((side === 'RIGHT' && newLine === line) || (side === 'LEFT' && oldLine === line)) return { old_line: oldLine, new_line: newLine };
            oldLine++;
            newLine++;
        }
        delta = newLine - oldLine;
    }
    return side === 'RIGHT' ? { old_line: line - delta, new_line: line } : { old_line: line, new_line: line + delta };
}

/** Counts the added and the removed lines of a patch. */
export function patchLineCounts(patch: string | undefined): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const line of (patch ?? '').split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    return { additions, deletions };
}

/** The title prefix that makes a GitLab merge request a draft. */
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s-\s|\[wip\]|wip:)\s*/i;

/** Returns the title with or without the "Draft:" prefix. GitLab sets the draft state from the title. */
export function draftTitle(title: string, draft: boolean): string {
    const plain = title.replace(DRAFT_PREFIX, '');
    return draft ? `Draft: ${plain}` : plain;
}
