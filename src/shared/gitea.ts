import type { CheckConclusion, CheckStatus, MergeMethod, RepoRef, ReviewEvent } from './github';
import { normalizeGitLabUrl } from './gitlab';

/**
 * A repository on a Gitea or Forgejo server. `host` is the host of the server, for example "git.example.com" or
 * "codeberg.org" or "git.example.com:3000". `owner` is the user or the organization.
 */
export interface GiteaRepoRef {
    host: string;
    owner: string;
    repo: string;
}

/**
 * Returns the base URL of a Gitea or Forgejo server without a "/" at the end, for example "https://git.example.com".
 * A URL without a protocol gets "https://". A server in a subfolder keeps the folder.
 * Returns undefined for a text that is not a URL.
 */
export function normalizeGiteaUrl(value: string | undefined | null): string | undefined {
    return normalizeGitLabUrl(value);
}

/** Returns the host of a base URL in lowercase, for example "git.example.com". Returns undefined for a text that is not a URL. */
export function giteaHostOf(baseUrl: string | undefined | null): string | undefined {
    const url = normalizeGiteaUrl(baseUrl);
    return url ? new URL(url).host.toLowerCase() : undefined;
}

function decodePart(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

/** Splits "owner/repo[.git]" into its parts. Returns undefined when the path does not have exactly 2 parts. */
function splitPath(raw: string): { owner: string; repo: string } | undefined {
    const parts = raw
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean)
        .map(decodePart);
    if (parts.length !== 2) return undefined;
    return { owner: parts[0], repo: parts[1] };
}

/**
 * Parses the remote URL of a repository on one of the Gitea or Forgejo servers. Returns undefined for other URLs.
 * `servers` are the base URLs of the servers of the providers. There is no default server.
 * It accepts these forms:
 * - git@{host}:{owner}/{repo}.git
 * - ssh://git@{host}[:port]/{owner}/{repo}.git
 * - https://[user[:password]@]{host}[:port][/folder]/{owner}/{repo}.git
 * The SSH forms match the server by its host name only, because the SSH port is not the port of the web server.
 */
export function parseGiteaRemote(url: string, servers: readonly string[]): GiteaRepoRef | undefined {
    const text = url.trim();
    const known = servers.flatMap(server => {
        const base = normalizeGiteaUrl(server);
        if (!base) return [];
        const parsed = new URL(base);
        return [{ host: parsed.host.toLowerCase(), hostname: parsed.hostname.toLowerCase(), folder: parsed.pathname.replace(/\/+$/, '') }];
    });
    if (known.length === 0) return undefined;
    const make = (hostname: string, port: string | undefined, path: string, web: boolean): GiteaRepoRef | undefined => {
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
    let match = /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(text);
    if (match) return make(match[1], undefined, `/${match[2]}`, false);
    match = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(text);
    if (match && !/^https?$/i.test(match[1])) return make(match[1], undefined, `/${match[2]}`, false);
    match = /^https?:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::(\d+))?(\/.+)$/i.exec(text);
    if (match) return make(match[1], match[2], match[3], true);
    return undefined;
}

/**
 * Returns the base URL of the server of a remote, as a guess for a new provider. Returns undefined for a remote that
 * is not a URL. An SSH remote gives "https://" and the host name, because the SSH port is not the port of the web server.
 * A web remote keeps its port. A server in a subfolder is not found.
 */
export function remoteServerGuess(url: string): string | undefined {
    const text = url.trim();
    let match = /^https?:\/\/(?:[^@/\s]+@)?([^/\s]+)\/.+$/i.exec(text);
    if (match) return `${/^http:/i.test(text) ? 'http' : 'https'}://${match[1].toLowerCase()}`;
    match = /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/.+$/i.exec(text) ?? /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/).+$/.exec(text);
    if (match && !/^https?$/i.test(match[1])) return `https://${match[1].toLowerCase()}`;
    return undefined;
}

/** Returns the Gitea repository of a reference. Returns undefined for other hosts. The owner is "host/owner". */
export function giteaRepoOf(repo: RepoRef | null | undefined): GiteaRepoRef | undefined {
    if (repo?.host !== 'gitea') return undefined;
    const slash = repo.owner.indexOf('/');
    if (slash <= 0 || slash === repo.owner.length - 1 || !repo.name || repo.owner.indexOf('/', slash + 1) >= 0) return undefined;
    return { host: repo.owner.slice(0, slash).toLowerCase(), owner: repo.owner.slice(slash + 1), repo: repo.name };
}

/** Returns the reference of a Gitea repository, for the page. */
export function giteaRepoRef(repo: GiteaRepoRef): RepoRef {
    return { owner: `${repo.host}/${repo.owner}`, name: repo.repo, host: 'gitea' };
}

/** The API path of a repository, for example "/repos/acme/api". */
export function giteaRepoApi(repo: Pick<GiteaRepoRef, 'owner' | 'repo'>): string {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

/**
 * The web page of a repository. The page uses https, because a `RepoRef` has no protocol.
 * The main process uses the `html_url` of the API when it has one.
 */
export function giteaRepoWebUrl(repo: GiteaRepoRef): string {
    return `https://${repo.host}/${repo.owner}/${repo.repo}`;
}

/** The web page of a pull request. */
export function giteaPullRequestWebUrl(repo: GiteaRepoRef, number: number): string {
    return `${giteaRepoWebUrl(repo)}/pulls/${number}`;
}

/** The web page that compares a branch with the base branch. It has the button that creates a pull request. */
export function giteaCreatePullRequestUrl(repoWebUrl: string, base: string, branch: string): string {
    return `${repoWebUrl}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`;
}

/** The web page of the Actions runs of a repository. */
export function giteaActionsWebUrl(repo: GiteaRepoRef): string {
    return `${giteaRepoWebUrl(repo)}/actions`;
}

/**
 * Makes an ID that holds the repository, the pull request, and a comment, so a call with only the ID
 * (for example "resolve the thread") can find the repository. All Gitea IDs start with "gitea:".
 */
export function encodeGiteaId(repo: GiteaRepoRef, number: number, commentId?: number): string {
    const parts = [repo.host, repo.owner, repo.repo, String(number)];
    if (commentId !== undefined) parts.push(String(commentId));
    return `gitea:${parts.map(encodeURIComponent).join('/')}`;
}

/** Reads an ID from `encodeGiteaId`. Returns undefined for other IDs. */
export function decodeGiteaId(value: string): { repo: GiteaRepoRef; number: number; commentId?: number } | undefined {
    if (!value.startsWith('gitea:')) return undefined;
    const parts = value.slice('gitea:'.length).split('/').map(decodePart);
    if (parts.length < 4 || parts.length > 5) return undefined;
    const number = Number(parts[3]);
    if (!Number.isInteger(number) || number <= 0) return undefined;
    const commentId = parts[4] === undefined ? undefined : Number(parts[4]);
    if (commentId !== undefined && (!Number.isInteger(commentId) || commentId <= 0)) return undefined;
    return { repo: { host: parts[0], owner: parts[1], repo: parts[2] }, number, ...(commentId !== undefined ? { commentId } : {}) };
}

/** The review events of Gitea and Forgejo, in the order of the buttons. */
export const GITEA_REVIEW_EVENTS: ReviewEvent[] = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];

/** The title prefixes that make a pull request a draft ("work in progress"). These are the defaults of Gitea and Forgejo. */
const DRAFT_PREFIX = /^\s*(?:wip:|\[wip\])\s*/i;

/** True when the title starts with a draft prefix. Older servers have no `draft` field, so the title decides. */
export function hasDraftPrefix(title: string): boolean {
    return DRAFT_PREFIX.test(title);
}

/** Returns the title with or without the "WIP:" prefix. Gitea and Forgejo set the draft state from the title. */
export function giteaDraftTitle(title: string, draft: boolean): string {
    const plain = title.replace(DRAFT_PREFIX, '');
    return draft ? `WIP: ${plain}` : plain;
}

/**
 * The merge methods that a repository allows, and the default method.
 * Gitea "rebase" is a rebase and a fast-forward. Gitea "rebase-merge" (a rebase and a merge commit) and
 * "fast-forward-only" have no method in the UI.
 */
export function giteaMergeMethods(repo: {
    allow_merge_commits?: boolean;
    allow_squash_merge?: boolean;
    allow_rebase?: boolean;
    default_merge_style?: string;
}): { allowed: MergeMethod[]; preferred: MergeMethod } {
    const allowed: MergeMethod[] = [];
    if (repo.allow_merge_commits !== false) allowed.push('merge');
    if (repo.allow_squash_merge !== false) allowed.push('squash');
    if (repo.allow_rebase !== false) allowed.push('rebase');
    if (allowed.length === 0) allowed.push('merge');
    const style = repo.default_merge_style;
    const preferred: MergeMethod =
        style === 'squash' && allowed.includes('squash') ? 'squash' : style === 'rebase' && allowed.includes('rebase') ? 'rebase' : allowed[0];
    return { allowed, preferred };
}

/**
 * Converts the status and the conclusion of an Actions run, job, task, or step to the check status of the UI.
 * The newer API (runs and jobs) uses the words of GitHub: a status ("queued", "in_progress", "completed", "waiting")
 * and a conclusion. The older task API and the steps give one status: "success", "failure", "cancelled", "skipped",
 * "waiting", "running", "blocked", or "unknown".
 */
export function actionsStatusToCheck(status: string | null | undefined, conclusion?: string | null): { status: CheckStatus; conclusion: CheckConclusion } {
    const finished = (value: string | null | undefined): CheckConclusion | undefined => {
        switch (value) {
            case 'success':
                return 'success';
            case 'failure':
                return 'failure';
            case 'cancelled':
            case 'canceled':
                return 'cancelled';
            case 'skipped':
                return 'skipped';
            case 'neutral':
                return 'neutral';
            default:
                return undefined;
        }
    };
    const done = finished(conclusion) ?? finished(status);
    if (done) return { status: 'completed', conclusion: done };
    switch (status) {
        case 'completed':
            return { status: 'completed', conclusion: 'neutral' };
        case 'running':
        case 'in_progress':
            return { status: 'in_progress', conclusion: null };
        case 'waiting':
        case 'blocked':
            return { status: 'waiting', conclusion: null };
        default:
            return { status: 'queued', conclusion: null };
    }
}

/** Converts the state of a commit status ("pending", "success", "error", "failure", "warning", or "skipped") to the check status of the UI. */
export function commitStatusToCheck(state: string | null | undefined): { status: CheckStatus; conclusion: CheckConclusion } {
    switch (state) {
        case 'success':
            return { status: 'completed', conclusion: 'success' };
        case 'failure':
            return { status: 'completed', conclusion: 'failure' };
        case 'error':
            return { status: 'completed', conclusion: 'error' };
        case 'warning':
            return { status: 'completed', conclusion: 'neutral' };
        case 'skipped':
            return { status: 'completed', conclusion: 'skipped' };
        default:
            return { status: 'pending', conclusion: null };
    }
}

/**
 * Reads the server version from the answer of "/api/v1/version". A Forgejo server gives a version such as
 * "7.0.0+gitea-1.22.0". `gitea` is then the Gitea version that its API is compatible with.
 */
export function parseServerVersion(version: string | null | undefined): { product: 'Gitea' | 'Forgejo'; version: string; gitea?: string } {
    const text = (version ?? '').trim();
    const forgejo = /^v?(\d+\.\d+(?:\.\d+)?)[^+]*\+.*gitea-(\d+\.\d+(?:\.\d+)?)/i.exec(text);
    if (forgejo) return { product: 'Forgejo', version: forgejo[1], gitea: forgejo[2] };
    return { product: 'Gitea', version: text.replace(/^v/i, '').replace(/\+.*$/, '') || 'unknown' };
}
